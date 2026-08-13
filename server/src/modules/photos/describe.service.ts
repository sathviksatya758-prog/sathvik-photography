import type { Photo, PhotoExif, PhotoAi, PhotoColor } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { cacheGet, cacheSet } from '../../lib/redis';
import { caps } from '../../config/env';
import { anthropic, MODEL, extractText } from '../../lib/anthropic';
import { getObject } from '../../lib/storage';
import { buildAiPreview } from '../../lib/imagePipeline';
import { logger } from '../../lib/logger';

type PhotoWithData = Photo & { exif: PhotoExif | null; ai: PhotoAi | null; colors: PhotoColor[] };

const DESCRIBE_TTL = 24 * 3600;

// EXIF stores shutter speed as decimal seconds; render it the way a
// photographer reads it (1/500 rather than 0.002).
function fmtShutter(s?: number | null): string | null {
  if (s == null) return null;
  return s >= 1 ? `${s}s` : `1/${Math.round(1 / s)}s`;
}

// A compact "real-time data" sheet — everything factual we actually know about
// this photograph — used both as context for the AI call and as the source for
// the non-AI fallback. Never fabricates values.
function factSheet(p: PhotoWithData): string {
  const x = p.exif;
  const cam = [x?.make, x?.model].filter(Boolean).join(' ').trim();
  const facts: string[] = [];
  const name = p.title || p.ai?.title || p.ai?.caption;
  if (name) facts.push(`Title: ${name}`);
  if (p.ai?.subject) facts.push(`Subject: ${p.ai.subject}`);
  if (p.ai?.subjects?.length) facts.push(`Detected subjects: ${p.ai.subjects.join(', ')}`);
  if (p.ai?.genre) facts.push(`Genre: ${p.ai.genre}`);
  if (p.ai?.sceneDescription) facts.push(`Scene: ${p.ai.sceneDescription}`);
  if (p.ai?.mood) facts.push(`Mood: ${p.ai.mood}`);
  if (cam) facts.push(`Camera: ${cam}`);
  if (x?.lens) facts.push(`Lens: ${x.lens}`);
  if (x?.focalMm) facts.push(`Focal length: ${x.focalMm}mm`);
  if (x?.aperture) facts.push(`Aperture: f/${x.aperture}`);
  if (x?.shutterSec) facts.push(`Shutter: ${fmtShutter(x.shutterSec)}`);
  if (x?.iso) facts.push(`ISO: ${x.iso}`);
  const taken = x?.takenAt ?? p.capturedAt ?? p.createdAt;
  if (taken) facts.push(`Captured: ${new Date(taken).toISOString().slice(0, 10)}`);
  if (x?.placeName || p.ai?.locationGuess) facts.push(`Location: ${x?.placeName ?? p.ai?.locationGuess}`);
  if (p.width && p.height) facts.push(`Dimensions: ${p.width}×${p.height}`);
  if (p.colors.length) facts.push(`Dominant colours: ${p.colors.slice(0, 5).map(c => c.hex).join(', ')}`);
  if (p.ownerNote) facts.push(`Photographer's note: ${p.ownerNote}`);
  return facts.join('\n');
}

// Non-AI fallback: a readable paragraph assembled from the real metadata, used
// when ANTHROPIC_API_KEY isn't configured (or a call fails). Honest and
// specific — no invented content.
function composeFromFacts(p: PhotoWithData): string {
  const x = p.exif;
  const cam = [x?.make, x?.model].filter(Boolean).join(' ').trim();
  // Treat placeholder AI values (the no-key fallback writes "Untitled") as
  // non-informative so the sentence doesn't read "Untitled. Untitled…".
  const meaningful = (s?: string | null) => (s && !/^untitled/i.test(s.trim()) ? s.trim() : null);
  const name = p.title || meaningful(p.ai?.title) || meaningful(p.ai?.caption) || 'This photograph';
  const sentences: string[] = [];

  let lead = name.replace(/\.$/, '');
  if (p.ai?.subject) lead += ` centres on ${p.ai.subject}`;
  else if (meaningful(p.ai?.sceneDescription)) lead += ` — ${p.ai!.sceneDescription!.replace(/\.$/, '')}`;
  sentences.push(lead + '.');

  const desc = meaningful(p.ai?.description);
  if (desc && desc !== name) sentences.push(desc);
  if (p.ai?.story) sentences.push(p.ai.story);

  const gear: string[] = [];
  if (cam) gear.push(cam);
  if (x?.lens) gear.push(`the ${x.lens}`);
  let shot = '';
  if (gear.length) shot = `Made on ${gear.join(' with ')}`;
  const settings = [
    x?.focalMm ? `${x.focalMm}mm` : null,
    x?.aperture ? `f/${x.aperture}` : null,
    fmtShutter(x?.shutterSec),
    x?.iso ? `ISO ${x.iso}` : null
  ].filter(Boolean);
  if (settings.length) shot += `${shot ? ' at ' : 'Shot at '}${settings.join(', ')}`;
  const taken = x?.takenAt ?? p.capturedAt;
  if (taken) shot += `${shot ? ', ' : 'Captured '}${new Date(taken).toISOString().slice(0, 10)}`;
  if (shot) sentences.push(shot.trim() + '.');

  if (p.colors.length) {
    sentences.push(`Its palette is led by ${p.colors.slice(0, 3).map(c => c.hex).join(', ')}.`);
  }
  if (p.width && p.height) sentences.push(`Full resolution ${p.width}×${p.height}.`);

  return sentences.join(' ');
}

/** On-demand comprehensive description for a photo. Uses Claude vision when a
 *  key is configured (cached 24h), otherwise composes one from the real
 *  metadata. Public. */
export async function describePhoto(photoId: string): Promise<{ description: string; source: 'ai' | 'metadata' }> {
  const photo = (await prisma.photo.findFirst({
    where: { id: photoId, deletedAt: null },
    include: { exif: true, ai: true, colors: { orderBy: { rank: 'asc' } } }
  })) as PhotoWithData | null;
  if (!photo) throw AppError.notFound('Photo not found');

  if (!caps.anthropic) return { description: composeFromFacts(photo), source: 'metadata' };

  const cacheKey = `photo:describe:${photoId}`;
  const hit = await cacheGet<{ description: string; source: 'ai' | 'metadata' }>(cacheKey);
  if (hit) return hit;

  try {
    const original = await getObject(photo.storageKey);
    const preview = await buildAiPreview(original);
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 600,
      system:
        'You are a photography curator writing for a gallery visitor. In one comprehensive, engaging ' +
        'paragraph (4–6 sentences), describe this photograph: what it shows, its light and mood, and any ' +
        'notable technique. Ground every technical claim in the camera data provided — never invent ' +
        'settings, places, or dates. Plain prose, no lists, no markdown.',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: preview.toString('base64') } },
            { type: 'text', text: `Known data for this photograph:\n${factSheet(photo)}` }
          ]
        }
      ]
    });
    const result = { description: extractText(msg.content), source: 'ai' as const };
    await cacheSet(cacheKey, result, DESCRIBE_TTL);
    return result;
  } catch (err) {
    logger.error({ err, photoId }, 'AI describe failed — falling back to metadata');
    return { description: composeFromFacts(photo), source: 'metadata' };
  }
}
