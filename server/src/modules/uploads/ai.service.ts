import { z } from 'zod';
import { anthropic, MODEL, extractText, parseJsonReply } from '../../lib/anthropic';
import { caps } from '../../config/env';
import type { ExifData } from '../../lib/imagePipeline';
import type { PaletteColor } from '../../lib/imagePipeline';

// NOTE ON HONESTY: the composition/quality/scene fields below (ruleOfThirds,
// symmetryDetected, leadingLines, compositionScore, qualityScore,
// sceneClassification, weatherEstimate, timeOfDayEstimate) are Claude's
// holistic visual judgment from looking at the image — the same way the
// caption/mood/story fields already worked. This is NOT a dedicated
// object-detection/CV model (no YOLO, no scene-classifier network) — it's
// one vision-language model asked to reason about composition the way a
// human critic would. Treat scores as an opinion, not a measurement.
export const AiMeta = z.object({
  title: z.string(),
  caption: z.string(),
  shortCaption: z.string(),
  longCaption: z.string(),
  subject: z.string().optional().default(''),
  subjects: z.array(z.string()).optional().default([]),
  description: z.string(),
  sceneDescription: z.string(),
  altText: z.string(),
  story: z.string(),
  tags: z.array(z.string()),
  categories: z.array(z.string()),
  collections: z.array(z.string()).optional().default([]),
  seoKeywords: z.array(z.string()),
  hashtags: z.array(z.string()),
  mood: z.string(),
  composition: z.string(),
  lighting: z.string(),
  colorAnalysis: z.string(),
  colorHarmony: z.string(),
  editingStyle: z.string(),
  cameraTechnique: z.string(),
  genre: z.string(),
  socialCaption: z.string(),
  instagramCaption: z.string(),
  linkedinCaption: z.string(),
  twitterCaption: z.string(),
  technicalNote: z.string().optional().default(''),
  locationGuess: z.string().nullable().optional().default(null),
  // AI-estimated analysis — see the disclosure above.
  sceneClassification: z.string(),
  weatherEstimate: z.string().nullable().optional().default(null),
  timeOfDayEstimate: z.string().nullable().optional().default(null),
  lightingQuality: z.string(),
  ruleOfThirds: z.boolean(),
  symmetryDetected: z.boolean(),
  leadingLines: z.boolean(),
  compositionScore: z.number().min(0).max(10),
  qualityScore: z.number().min(0).max(10),
  // --- Explicit detection buckets ---
  // Asked for separately (rather than folded into free-form tags) so the
  // Discovery taxonomy can match reliably: a tiger in a forest should land
  // in Wildlife AND Animals AND Nature AND Forests without anyone tagging
  // it by hand. Each is a list because a frame usually contains several.
  detectedAnimals: z.array(z.string()).optional().default([]),
  detectedBirds: z.array(z.string()).optional().default([]),
  detectedPeople: z.array(z.string()).optional().default([]),
  detectedVehicles: z.array(z.string()).optional().default([]),
  detectedBuildings: z.array(z.string()).optional().default([]),
  detectedPlants: z.array(z.string()).optional().default([]),
  detectedFood: z.array(z.string()).optional().default([]),
  detectedNature: z.array(z.string()).optional().default([])
});
export type AiMeta = z.infer<typeof AiMeta>;

/**
 * Flattens every detection bucket into lowercase tag values. The upload
 * worker writes these as `tag` terms alongside the model's own tags, which
 * is what makes a photo appear in multiple Discovery collections at once.
 */
export function detectionTags(ai: AiMeta): string[] {
  const buckets: [string[], string][] = [
    [ai.detectedAnimals, 'animal'],
    [ai.detectedBirds, 'bird'],
    [ai.detectedPeople, 'people'],
    [ai.detectedVehicles, 'vehicle'],
    [ai.detectedBuildings, 'building'],
    [ai.detectedPlants, 'plant'],
    [ai.detectedFood, 'food'],
    [ai.detectedNature, 'nature']
  ];
  const out = new Set<string>();
  for (const [values, bucketLabel] of buckets) {
    if (!values.length) continue;
    // The bucket label itself is a tag, so "Animals"/"Birds" style rows
    // populate even when the specific species wording varies.
    out.add(bucketLabel);
    for (const v of values) {
      const clean = v.trim().toLowerCase();
      if (clean) out.add(clean);
    }
  }
  return [...out];
}

function buildContext(exif: ExifData | null, palette: Pick<PaletteColor, 'hex' | 'share'>[]): string {
  return [
    exif &&
      `Camera: ${[exif.make, exif.model].filter(Boolean).join(' ')}` +
        `${exif.lens ? `, lens ${exif.lens}` : ''}` +
        `${exif.aperture ? `, f/${exif.aperture}` : ''}` +
        `${exif.iso ? `, ISO ${exif.iso}` : ''}.`,
    palette.length && `Dominant colours: ${palette.map(p => p.hex).join(', ')}.`
  ]
    .filter(Boolean)
    .join(' ');
}

const ENRICH_FIELDS =
  'title, caption, shortCaption (under 8 words), longCaption (2-3 sentences), subject, subjects[] ' +
  '(distinct dominant subjects, e.g. ["heron","reflection","reeds"]), description, sceneDescription, ' +
  'altText, story, tags[], categories[], collections[], seoKeywords[], hashtags[], mood, composition, ' +
  'lighting, colorAnalysis, colorHarmony, editingStyle, cameraTechnique, genre, socialCaption, ' +
  'instagramCaption (with emoji, casual), linkedinCaption (professional, no emoji), ' +
  'twitterCaption (under 280 chars), technicalNote, locationGuess, sceneClassification ' +
  '(e.g. landscape/portrait/street/wildlife/architecture/macro), weatherEstimate, timeOfDayEstimate, ' +
  'lightingQuality, ruleOfThirds (boolean), symmetryDetected (boolean), leadingLines (boolean), ' +
  'compositionScore (0-10), qualityScore (0-10), ' +
  'detectedAnimals[] (species/common names of any animals present, empty if none), ' +
  'detectedBirds[], detectedPeople[] (e.g. ["child","fisherman"], not identities), ' +
  'detectedVehicles[], detectedBuildings[] (e.g. ["temple","bridge"]), detectedPlants[], ' +
  'detectedFood[], detectedNature[] (e.g. ["forest","river","mountain","beach"])';

// Vision enrichment — one Claude call returns full exhibition-catalogue
// metadata for a photo, including AI-estimated composition/scene analysis.
// Ported from legacy/lib.ts::enrichPhoto and expanded per the AI feature
// spec (multi-platform captions, composition/quality scoring).
// Non-AI fallback used when ANTHROPIC_API_KEY isn't configured. It produces
// a valid, honest-but-plain metadata record from the EXIF/palette we already
// extracted locally — no invented critique, no fabricated scene analysis — so
// the whole pipeline (renditions, search index, Discovery rows) still works.
// The photographer can add a key later and re-run via POST /uploads/:id/retry
// to get the full AI enrichment.
function fallbackAiMeta(exif: ExifData | null, palette: Pick<PaletteColor, 'hex' | 'share'>[]): AiMeta {
  const camera = [exif?.make, exif?.model].filter(Boolean).join(' ').trim();
  const caption = camera ? `Photograph captured on ${camera}` : 'Untitled photograph';
  const colourNote = palette.length ? `Dominant colours: ${palette.map(p => p.hex).join(', ')}.` : '';
  return AiMeta.parse({
    title: 'Untitled',
    caption,
    shortCaption: caption,
    longCaption: `${caption}. ${colourNote}`.trim(),
    subject: '',
    subjects: [],
    description: `${caption}. ${colourNote}`.trim(),
    sceneDescription: '',
    altText: caption,
    story: '',
    tags: [],
    categories: [],
    collections: [],
    seoKeywords: [],
    hashtags: [],
    mood: '',
    composition: '',
    lighting: '',
    colorAnalysis: colourNote,
    colorHarmony: '',
    editingStyle: '',
    cameraTechnique: '',
    genre: '',
    socialCaption: caption,
    instagramCaption: caption,
    linkedinCaption: caption,
    twitterCaption: caption,
    technicalNote: '',
    locationGuess: null,
    sceneClassification: 'unclassified',
    weatherEstimate: null,
    timeOfDayEstimate: null,
    lightingQuality: '',
    ruleOfThirds: false,
    symmetryDetected: false,
    leadingLines: false,
    compositionScore: 0,
    qualityScore: 0
  });
}

export async function enrichPhoto(
  imageBase64: string,
  mediaType: string,
  exif: ExifData | null,
  palette: Pick<PaletteColor, 'hex' | 'share'>[]
): Promise<AiMeta> {
  if (!caps.anthropic) return fallbackAiMeta(exif, palette);

  const context = buildContext(exif, palette);

  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 3000,
    system:
      'You are a photography curator and critic writing exhibition catalogue metadata. ' +
      'Reply with one JSON object and nothing else. Be specific, never generic. When asked for a ' +
      'composition or quality score, give your honest expert opinion as a number — these are ' +
      'stylistic judgments, not measurements, so commit to a real answer rather than hedging.',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType as 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: `${context}\n\nReturn JSON with keys: ${ENRICH_FIELDS}.` }
        ]
      }
    ]
  });

  const text = extractText(msg.content);
  return AiMeta.parse(parseJsonReply(text));
}

export const PhotoCritique = z.object({
  exposure: z.string(),
  compositionImprovements: z.string(),
  croppingSuggestion: z.string(),
  whiteBalance: z.string(),
  sharpnessFeedback: z.string(),
  noiseAnalysis: z.string(),
  editingRecommendations: z.string()
});
export type PhotoCritique = z.infer<typeof PhotoCritique>;

// On-demand editing feedback — a second, separate Claude call so it never
// adds latency/cost to the automatic upload pipeline (see PhotoCritique
// model comment in schema.prisma). Framed as constructive technical
// feedback, not a value judgment.
export async function critiquePhoto(
  imageBase64: string,
  mediaType: string,
  exif: ExifData | null
): Promise<PhotoCritique> {
  const context = buildContext(exif, []);

  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1200,
    system:
      'You are an experienced photography instructor giving constructive, specific, technical ' +
      'feedback on a single frame. Reply with one JSON object and nothing else. Be concrete ' +
      '(reference actual regions/tones/edges in the frame), not generic encouragement.',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType as 'image/jpeg', data: imageBase64 } },
          {
            type: 'text',
            text:
              `${context}\n\nReturn JSON with keys: exposure, compositionImprovements, ` +
              `croppingSuggestion, whiteBalance, sharpnessFeedback, noiseAnalysis, editingRecommendations.`
          }
        ]
      }
    ]
  });

  const text = extractText(msg.content);
  return PhotoCritique.parse(parseJsonReply(text));
}
