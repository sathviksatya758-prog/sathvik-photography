import '../lib/bigintJson';
import { Worker, type Job } from 'bullmq';
import { queueRedis } from '../lib/redis';
import { IMAGE_QUEUE_NAME, type ImageJobData } from '../lib/queue';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { putObject, getObject } from '../lib/storage';
import { buildRenditions, buildAiPreview } from '../lib/imagePipeline';
import { enrichPhoto, detectionTags, type AiMeta } from '../modules/uploads/ai.service';
import { embed, toVectorLiteral } from '../lib/embeddings';
import { env } from '../config/env';
import { cacheDel } from '../lib/redis';
import type { TermKind } from '@prisma/client';

const FEATURED_SCORE_THRESHOLD = 8.5; // out of 10, on both composition and quality
const DUPLICATE_SIMILARITY_THRESHOLD = 0.985;

function photoAiWriteData(ai: AiMeta) {
  return {
    title: ai.title,
    caption: ai.caption,
    subject: ai.subject,
    description: ai.description,
    altText: ai.altText,
    story: ai.story,
    mood: ai.mood,
    composition: ai.composition,
    lighting: ai.lighting,
    colorAnalysis: ai.colorAnalysis,
    editingStyle: ai.editingStyle,
    genre: ai.genre,
    socialCaption: ai.socialCaption,
    technicalNote: ai.technicalNote,
    locationGuess: ai.locationGuess,
    shortCaption: ai.shortCaption,
    longCaption: ai.longCaption,
    sceneDescription: ai.sceneDescription,
    colorHarmony: ai.colorHarmony,
    cameraTechnique: ai.cameraTechnique,
    subjects: ai.subjects,
    instagramCaption: ai.instagramCaption,
    linkedinCaption: ai.linkedinCaption,
    twitterCaption: ai.twitterCaption,
    sceneClassification: ai.sceneClassification,
    weatherEstimate: ai.weatherEstimate,
    timeOfDayEstimate: ai.timeOfDayEstimate,
    lightingQuality: ai.lightingQuality,
    ruleOfThirds: ai.ruleOfThirds,
    symmetryDetected: ai.symmetryDetected,
    leadingLines: ai.leadingLines,
    compositionScore: Math.round(ai.compositionScore),
    qualityScore: Math.round(ai.qualityScore),
    modelVersion: env.ANTHROPIC_MODEL
  };
}

async function processImage(job: Job<ImageJobData>): Promise<void> {
  const { photoId, storageKey } = job.data;
  logger.info({ photoId, attempt: job.attemptsMade + 1 }, 'image job started');

  const original = await getObject(storageKey);
  const [built, preview, exif] = await Promise.all([
    buildRenditions(original),
    buildAiPreview(original),
    prisma.photoExif.findUnique({ where: { photoId } })
  ]);
  const colors = await prisma.photoColor.findMany({ where: { photoId }, orderBy: { rank: 'asc' } });

  const renditionRows: { format: 'avif' | 'webp' | 'jpeg'; width: number; height: number; bytes: number; key: string }[] = [];
  for (const r of built.renditions) {
    const key = `renditions/${storageKey.replace(/^originals\//, '')}/${r.width}.${r.format}`;
    await putObject(key, r.buffer, `image/${r.format}`);
    renditionRows.push({ format: r.format, width: r.width, height: r.height, bytes: r.bytes, key });
  }

  const ai = await enrichPhoto(
    preview.toString('base64'),
    'image/jpeg',
    exif && {
      make: exif.make,
      model: exif.model,
      lens: exif.lens,
      focal_mm: exif.focalMm,
      focal_35mm: exif.focal35mm,
      aperture: exif.aperture,
      shutter_sec: exif.shutterSec,
      iso: exif.iso,
      exposure_bias: exif.exposureBias,
      flash: exif.flash,
      white_balance: exif.whiteBalance,
      software: exif.software,
      taken_at: exif.takenAt,
      gps_lat: exif.gpsLat,
      gps_lon: exif.gpsLon,
      raw: exif.raw
    },
    colors.map(c => ({ hex: c.hex, share: c.share }))
  );

  const detected = detectionTags(ai);

  // Richer embedding text than the original caption/tags-only version —
  // folds in subjects, scene description, and genre so semantic search
  // ("golden hour portraits", "architecture at night") has more to match
  // against.
  const embedText = [
    ai.title,
    ai.caption,
    ai.subject,
    ai.subjects.join(' '),
    ai.description,
    ai.sceneDescription,
    ai.story,
    ai.mood,
    ai.genre,
    ai.tags.join(' '),
    ai.categories.join(' '),
    detected.join(' ')
  ]
    .filter(Boolean)
    .join('. ');
  const [vector] = await embed(embedText);
  const vectorLiteral = toVectorLiteral(vector);

  const terms: [TermKind, string][] = [
    ...ai.tags.map((t): [TermKind, string] => ['tag', t]),
    // Detection buckets become tags too, which is what lets one photo
    // belong to several Discovery collections at once without any manual
    // categorisation (see detectionTags in uploads/ai.service.ts).
    ...detected.map((t): [TermKind, string] => ['tag', t]),
    ...ai.categories.map((t): [TermKind, string] => ['category', t]),
    ...ai.collections.map((t): [TermKind, string] => ['collection', t]),
    ...ai.seoKeywords.map((t): [TermKind, string] => ['seo', t]),
    ...ai.hashtags.map((t): [TermKind, string] => ['hashtag', t])
  ];

  await prisma.$transaction(async tx => {
    await tx.photoRendition.createMany({
      data: renditionRows.map(r => ({ photoId, format: r.format, width: r.width, height: r.height, bytes: r.bytes, storageKey: r.key })),
      skipDuplicates: true
    });

    const data = photoAiWriteData(ai);
    await tx.photoAi.upsert({
      where: { photoId },
      create: { photoId, ...data },
      update: { ...data, generatedAt: new Date() }
    });

    if (terms.length) {
      await tx.photoTerm.createMany({
        data: terms.map(([kind, value]) => ({ photoId, kind, value: value.toLowerCase() })),
        skipDuplicates: true
      });
    }

    await tx.$executeRawUnsafe(
      `INSERT INTO photo_embeddings (photo_id, embedding, model)
       VALUES ($1::uuid, $2::vector, $3)
       ON CONFLICT (photo_id) DO UPDATE SET embedding = EXCLUDED.embedding, model = EXCLUDED.model`,
      photoId,
      vectorLiteral,
      env.EMBED_MODEL
    );

    await tx.$executeRawUnsafe(
      `INSERT INTO knowledge_chunks (kind, title, body, photo_id, embedding, token_len)
       VALUES ('photo', $1, $2, $3::uuid, $4::vector, $5)`,
      ai.title || ai.caption,
      embedText,
      photoId,
      vectorLiteral,
      Math.ceil(embedText.length / 4)
    );

    await tx.photo.update({ where: { id: photoId }, data: { status: 'READY' } });
  });

  await generateSuggestions(photoId, ai).catch(err => logger.error({ err, photoId }, 'suggestion generation failed'));

  await cacheDel('photos:list:*');
  await cacheDel(`photo:${photoId}`);
  await cacheDel('admin:insights:*');
  await cacheDel('search:q:*');
  // A newly enriched photo can join existing collections and appear in
  // other photos' rails, so both feeds have to be rebuilt.
  await cacheDel('discovery:*');
  await cacheDel('recs:*');
  logger.info({ photoId }, 'image job completed');
}

// Additive auto-organization pass — proposes, never applies. See
// PhotoSuggestion in schema.prisma and server/src/modules/admin for the
// approve/reject endpoints.
async function generateSuggestions(photoId: string, ai: AiMeta): Promise<void> {
  const suggestions: { kind: 'FEATURED' | 'DUPLICATE'; value?: string; duplicateOfId?: string; confidence?: number }[] = [];

  if (ai.compositionScore >= FEATURED_SCORE_THRESHOLD && ai.qualityScore >= FEATURED_SCORE_THRESHOLD) {
    suggestions.push({
      kind: 'FEATURED',
      value: `Composition ${ai.compositionScore.toFixed(1)}/10, quality ${ai.qualityScore.toFixed(1)}/10`,
      confidence: (ai.compositionScore + ai.qualityScore) / 20
    });
  }

  const duplicates = await prisma.$queryRawUnsafe<{ photo_id: string; score: number }[]>(
    `SELECT * FROM find_duplicate_photos($1::uuid, $2)`,
    photoId,
    DUPLICATE_SIMILARITY_THRESHOLD
  );
  for (const d of duplicates) {
    suggestions.push({ kind: 'DUPLICATE', duplicateOfId: d.photo_id, confidence: d.score });
  }

  if (!suggestions.length) return;

  await prisma.photoSuggestion.createMany({
    data: suggestions.map(s => ({
      photoId,
      kind: s.kind,
      value: s.value,
      duplicateOfId: s.duplicateOfId,
      confidence: s.confidence
    }))
  });
}

export const imageWorker = new Worker<ImageJobData>(IMAGE_QUEUE_NAME, processImage, {
  connection: queueRedis,
  concurrency: 2
});

imageWorker.on('failed', async (job, err) => {
  logger.error({ photoId: job?.data.photoId, err, attempt: job?.attemptsMade }, 'image job failed');
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    await prisma.photo.update({ where: { id: job.data.photoId }, data: { status: 'FAILED' } }).catch(() => {});
  }
});

imageWorker.on('completed', job => {
  logger.info({ photoId: job.data.photoId }, 'image worker: job completed');
});

logger.info('Image processing worker started');
