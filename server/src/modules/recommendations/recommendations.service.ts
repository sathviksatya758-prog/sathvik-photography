/* ============================================================
   recommendations.service.ts — multi-signal "keep exploring" rails
   ------------------------------------------------------------
   Every rail shown under an opened photograph is produced here.
   Signals used, and where each comes from:

     semantic      pgvector cosine over caption+subjects+story
                   embeddings            → similar_photos()
     colour        RGB distance between dominant colours
                                          → similar_by_palette()
     location      haversine over EXIF GPS → nearby_photos()
     camera/lens   EXIF make+model / lens  → Prisma
     category      shared AI category terms → Prisma
     mood / genre  AI-generated fields      → Prisma

   "AI Recommended" is a weighted fusion of all of the above rather
   than any single signal, so it degrades gracefully: a photo with no
   GPS, no EXIF and no palette still gets sensible semantic results.

   Results are cached per photo; the upload worker and delete path
   both clear `recs:*`, so a new upload can appear in existing rails.
   ============================================================ */

import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { cached } from '../../lib/redis';
import { toPhotoCard, PHOTO_CARD_INCLUDE, type PhotoCard } from '../../lib/photoCard';

const RECS_TTL_SECONDS = 900;
const RAIL_SIZE = 12;

export interface Rail {
  slug: string;
  title: string;
  subtitle?: string;
  photos: PhotoCard[];
}

/** Weights for the fused "AI Recommended" rail. Tuned so semantic
 *  similarity leads but never completely dominates the other signals. */
const FUSION_WEIGHTS = {
  semantic: 0.40,
  palette: 0.14,
  category: 0.14,
  tags: 0.12,
  mood: 0.08,
  camera: 0.07,
  lens: 0.05
} as const;

type ScoreMap = Map<string, number>;

function addScores(target: ScoreMap, ids: string[], weight: number, scores?: number[]) {
  ids.forEach((id, i) => {
    const s = (scores?.[i] ?? 1) * weight;
    target.set(id, (target.get(id) ?? 0) + s);
  });
}

async function hydrate(ids: string[]): Promise<Map<string, PhotoCard>> {
  if (!ids.length) return new Map();
  const photos = await prisma.photo.findMany({
    where: { id: { in: ids }, deletedAt: null, status: 'READY' },
    include: PHOTO_CARD_INCLUDE
  });
  return new Map(photos.map(p => [p.id, toPhotoCard(p)]));
}

/** Orders hydrated cards to match the id order they were requested in. */
function order(ids: string[], byId: Map<string, PhotoCard>, limit = RAIL_SIZE): PhotoCard[] {
  const out: PhotoCard[] = [];
  for (const id of ids) {
    const card = byId.get(id);
    if (card) out.push(card);
    if (out.length >= limit) break;
  }
  return out;
}

async function buildRails(photoId: string): Promise<{ rails: Rail[] }> {
  const target = await prisma.photo.findFirst({
    where: { id: photoId, deletedAt: null },
    include: { ai: true, exif: true, terms: true, colors: { orderBy: { rank: 'asc' } } }
  });
  if (!target) throw AppError.notFound('Photo not found');

  const categories = target.terms.filter(t => t.kind === 'category').map(t => t.value);
  const tags = target.terms.filter(t => t.kind === 'tag').map(t => t.value);
  const camera = [target.exif?.make, target.exif?.model].filter(Boolean).join(' ').trim();
  const lens = target.exif?.lens ?? null;
  const mood = target.ai?.mood ?? null;
  const genre = target.ai?.genre ?? null;

  // --- Raw signal gathering, all in parallel ---
  const [semantic, palette, nearby, sameCamera, sameLens, sameCategory, sameMood, sharedTags, recent] =
    await Promise.all([
    prisma
      .$queryRawUnsafe<{ photo_id: string; score: number }[]>(`SELECT * FROM similar_photos($1::uuid, $2::int)`, photoId, 40)
      .catch(() => []),
    prisma
      .$queryRawUnsafe<{ photo_id: string; score: number }[]>(
        `SELECT * FROM similar_by_palette($1::uuid, $2::int)`,
        photoId,
        30
      )
      .catch(() => []),
    prisma
      .$queryRawUnsafe<{ photo_id: string; distance_km: number }[]>(
        `SELECT * FROM nearby_photos($1::uuid, $2::real, $3::int)`,
        photoId,
        50,
        RAIL_SIZE
      )
      .catch(() => []),
    camera
      ? prisma.photo.findMany({
          where: {
            id: { not: photoId },
            deletedAt: null,
            status: 'READY',
            exif: { make: target.exif?.make ?? undefined, model: target.exif?.model ?? undefined }
          },
          select: { id: true },
          orderBy: { createdAt: 'desc' },
          take: RAIL_SIZE
        })
      : Promise.resolve([]),
    lens
      ? prisma.photo.findMany({
          where: { id: { not: photoId }, deletedAt: null, status: 'READY', exif: { lens } },
          select: { id: true },
          orderBy: { createdAt: 'desc' },
          take: RAIL_SIZE
        })
      : Promise.resolve([]),
    categories.length
      ? prisma.photo.findMany({
          where: {
            id: { not: photoId },
            deletedAt: null,
            status: 'READY',
            terms: { some: { kind: 'category', value: { in: categories } } }
          },
          select: { id: true },
          orderBy: { createdAt: 'desc' },
          take: RAIL_SIZE * 2
        })
      : Promise.resolve([]),
    mood
      ? prisma.photo.findMany({
          where: {
            id: { not: photoId },
            deletedAt: null,
            status: 'READY',
            ai: { mood: { equals: mood, mode: 'insensitive' } }
          },
          select: { id: true },
          orderBy: { createdAt: 'desc' },
          take: RAIL_SIZE
        })
      : Promise.resolve([]),
    // Tag overlap, weighted by how many tags actually match. Tags now
    // include the automatic detection buckets (animal/bird/forest/…),
    // so this is a strong subject-level signal, not just manual labels.
    tags.length
      ? prisma.photoTerm.groupBy({
          by: ['photoId'],
          where: { kind: 'tag', value: { in: tags }, photoId: { not: photoId } },
          _count: { photoId: true },
          orderBy: { _count: { photoId: 'desc' } },
          take: RAIL_SIZE * 2
        })
      : Promise.resolve([]),
      prisma.photo.findMany({
        where: { id: { not: photoId }, deletedAt: null, status: 'READY' },
        select: { id: true },
        orderBy: [{ capturedAt: 'desc' }, { createdAt: 'desc' }],
        take: RAIL_SIZE
      })
    ]);

  // --- "More like this": composition/lighting/mood affinity ---
  // Semantic neighbours re-ranked by how closely their treatment matches,
  // which is a different question from "is it the same subject".
  const moreLikeThisIds = await (async () => {
    const neighbourIds = semantic.map(s => s.photo_id).slice(0, 30);
    if (!neighbourIds.length) return [];
    const neighbours = await prisma.photoAi.findMany({
      where: { photoId: { in: neighbourIds } },
      select: { photoId: true, mood: true, lightingQuality: true, composition: true, genre: true, editingStyle: true }
    });
    const scoreOf = (n: (typeof neighbours)[number]) => {
      let s = 0;
      if (mood && n.mood && n.mood.toLowerCase() === mood.toLowerCase()) s += 2;
      if (genre && n.genre && n.genre.toLowerCase() === genre.toLowerCase()) s += 1.5;
      if (target.ai?.lightingQuality && n.lightingQuality === target.ai.lightingQuality) s += 1;
      if (target.ai?.editingStyle && n.editingStyle === target.ai.editingStyle) s += 1;
      return s;
    };
    const semanticRank = new Map(semantic.map((s, i) => [s.photo_id, 1 - i / semantic.length]));
    return neighbours
      .map(n => ({ id: n.photoId, s: scoreOf(n) + (semanticRank.get(n.photoId) ?? 0) }))
      .filter(r => r.s > 0.4)
      .sort((a, b) => b.s - a.s)
      .map(r => r.id);
  })();

  // --- Fused "AI Recommended" ---
  const fused: ScoreMap = new Map();
  addScores(fused, semantic.map(s => s.photo_id), FUSION_WEIGHTS.semantic, semantic.map(s => s.score));
  addScores(fused, palette.map(s => s.photo_id), FUSION_WEIGHTS.palette, palette.map(s => s.score));
  addScores(fused, sameCategory.map(p => p.id), FUSION_WEIGHTS.category);
  // Normalised by the best overlap seen, so "shares 5 of 6 tags" outranks
  // "shares 1 of 6" instead of both counting the same.
  const topTagOverlap = sharedTags[0]?._count.photoId ?? 1;
  addScores(
    fused,
    sharedTags.map(t => t.photoId),
    FUSION_WEIGHTS.tags,
    sharedTags.map(t => t._count.photoId / topTagOverlap)
  );
  addScores(fused, sameMood.map(p => p.id), FUSION_WEIGHTS.mood);
  addScores(fused, sameCamera.map(p => p.id), FUSION_WEIGHTS.camera);
  addScores(fused, sameLens.map(p => p.id), FUSION_WEIGHTS.lens);
  fused.delete(photoId);
  const fusedIds = [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);

  // --- One hydration query for every id any rail might show ---
  const allIds = [
    ...new Set([
      ...fusedIds.slice(0, RAIL_SIZE),
      ...semantic.map(s => s.photo_id).slice(0, RAIL_SIZE),
      ...moreLikeThisIds.slice(0, RAIL_SIZE),
      ...sameCategory.map(p => p.id),
      ...sharedTags.map(t => t.photoId).slice(0, RAIL_SIZE),
      ...sameCamera.map(p => p.id),
      ...sameLens.map(p => p.id),
      ...palette.map(p => p.photo_id).slice(0, RAIL_SIZE),
      ...sameMood.map(p => p.id),
      ...nearby.map(n => n.photo_id),
      ...recent.map(p => p.id)
    ])
  ];
  const byId = await hydrate(allIds);

  const railSpecs: { slug: string; title: string; subtitle?: string; ids: string[] }[] = [
    {
      slug: 'ai-recommended',
      title: 'AI Recommended',
      subtitle: 'Blended across meaning, colour, gear and mood',
      ids: fusedIds
    },
    {
      slug: 'related',
      title: 'Related Photographs',
      subtitle: 'Closest in meaning and content',
      ids: semantic.map(s => s.photo_id)
    },
    {
      slug: 'more-like-this',
      title: 'More Like This',
      subtitle: 'Similar composition, lighting and mood',
      ids: moreLikeThisIds
    },
    {
      slug: 'same-category',
      title: categories.length ? `More in ${categories[0]}` : 'Same Category',
      subtitle: 'Sharing an AI-detected category',
      ids: sameCategory.map(p => p.id)
    },
    {
      slug: 'shared-subjects',
      title: 'Shares Subjects',
      subtitle: 'Same detected subjects and elements',
      ids: sharedTags.map(t => t.photoId)
    },
    {
      slug: 'same-palette',
      title: 'Same Colour Palette',
      subtitle: 'Built from the same dominant tones',
      ids: palette.map(p => p.photo_id)
    },
    {
      slug: 'same-mood',
      title: mood ? `Also ${mood}` : 'Same Mood',
      ids: sameMood.map(p => p.id)
    },
    {
      slug: 'same-camera',
      title: camera ? `Shot on ${camera}` : 'Same Camera',
      ids: sameCamera.map(p => p.id)
    },
    {
      slug: 'same-lens',
      title: lens ? `Shot with ${lens}` : 'Same Lens',
      ids: sameLens.map(p => p.id)
    },
    {
      slug: 'same-location',
      title: 'Nearby Frames',
      subtitle: 'Within 50 km, by GPS',
      ids: nearby.map(n => n.photo_id)
    },
    {
      slug: 'recent',
      title: 'Recently Captured',
      ids: recent.map(p => p.id)
    }
  ];

  // Drop empty rails, and any rail whose photos are already fully
  // covered by an earlier one — no visitor wants the same six frames
  // under four different headings.
  const shown = new Set<string>();
  const rails: Rail[] = [];
  for (const spec of railSpecs) {
    const photos = order(spec.ids.filter(id => id !== photoId), byId);
    if (!photos.length) continue;
    const fresh = photos.filter(p => !shown.has(p.id));
    // Keep the rail if it contributes anything new, or if it's one of the
    // two lead rails (which are allowed to overlap by design).
    const isLead = spec.slug === 'ai-recommended' || spec.slug === 'related';
    if (!isLead && fresh.length < Math.min(3, photos.length)) continue;
    photos.forEach(p => shown.add(p.id));
    rails.push({ slug: spec.slug, title: spec.title, subtitle: spec.subtitle, photos });
  }

  return { rails };
}

export async function getRecommendations(photoId: string) {
  return cached(`recs:${photoId}:v1`, RECS_TTL_SECONDS, () => buildRails(photoId));
}
