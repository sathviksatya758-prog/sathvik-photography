/* ============================================================
   discovery.service.ts — builds the Discovery feed
   ------------------------------------------------------------
   Turns the declarative definitions in taxonomy.ts into live,
   populated rows. A photo is matched purely on its AI-generated
   metadata, so rows re-populate themselves whenever the upload
   worker finishes enriching a new photograph — there is no
   manual curation step anywhere in this path.

   Performance: one lean projection query for the whole archive,
   bucketed in memory, then cached in Redis. That's O(1) queries
   per feed build regardless of how many collections exist, and
   the cache is invalidated by the upload worker / delete path
   (see cacheDel('discovery:*') callers).
   ============================================================ */

import { prisma } from '../../lib/prisma';
import { cached } from '../../lib/redis';
import { toPhotoCard, type PhotoCard } from '../../lib/photoCard';
import { COLLECTIONS, COLLECTION_BY_SLUG, matchersFor, type CollectionDef } from './taxonomy';
import type { Photo, PhotoAi, PhotoColor } from '@prisma/client';

const DISCOVERY_TTL_SECONDS = 300;
/** Netflix-style rows don't need the whole archive — cap per row. */
const MAX_PER_ROW = 24;
/** Rows thinner than this are dropped so the feed never looks sparse. */
const DEFAULT_MIN_PHOTOS = 3;

type PhotoWithMeta = Photo & {
  ai: PhotoAi | null;
  terms: { kind: string; value: string }[];
  colors: PhotoColor[];
};

/** Everything a photo's text-matchable identity is drawn from. */
function searchableText(p: PhotoWithMeta): string {
  const ai = p.ai;
  return [
    ...p.terms.map(t => t.value),
    ai?.subject,
    ...(ai?.subjects ?? []),
    ai?.genre,
    ai?.sceneClassification,
    ai?.mood,
    ai?.timeOfDayEstimate,
    ai?.weatherEstimate,
    ai?.lightingQuality,
    ai?.caption,
    ai?.shortCaption,
    ai?.sceneDescription
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function matches(def: CollectionDef, text: string): boolean {
  return matchersFor(def).some(m => text.includes(m));
}

async function loadArchive(): Promise<PhotoWithMeta[]> {
  return prisma.photo.findMany({
    where: { deletedAt: null, status: 'READY' },
    include: {
      ai: true,
      terms: { select: { kind: true, value: true } },
      colors: { orderBy: { rank: 'asc' } }
    },
    orderBy: { createdAt: 'desc' }
  }) as unknown as Promise<PhotoWithMeta[]>;
}

const toCard = toPhotoCard;

export interface DiscoveryRow {
  slug: string;
  title: string;
  subtitle?: string;
  /** 'collection' = curated taxonomy definition, others are derived from live data. */
  kind: 'collection' | 'recent' | 'featured' | 'camera' | 'category';
  total: number;
  photos: PhotoCard[];
}

async function buildFeed(): Promise<{ rows: DiscoveryRow[]; totalPhotos: number; generatedAt: string }> {
  const archive = await loadArchive();
  const rows: DiscoveryRow[] = [];

  if (!archive.length) {
    return { rows, totalPhotos: 0, generatedAt: new Date().toISOString() };
  }

  const texts = new Map(archive.map(p => [p.id, searchableText(p)]));

  // --- Featured + Recent lead the feed (editorial framing) ---
  const featured = archive.filter(p => p.featured);
  if (featured.length >= 1) {
    rows.push({
      slug: 'featured',
      title: 'Featured Work',
      subtitle: 'Frames worth starting with',
      kind: 'featured',
      total: featured.length,
      photos: featured.slice(0, MAX_PER_ROW).map(toCard)
    });
  }

  rows.push({
    slug: 'recent',
    title: 'Recently Added',
    subtitle: 'Newest in the archive',
    kind: 'recent',
    total: archive.length,
    photos: archive.slice(0, MAX_PER_ROW).map(toCard)
  });

  // --- Taxonomy-driven auto-collections ---
  for (const def of [...COLLECTIONS].sort((a, b) => (a.order ?? 999) - (b.order ?? 999))) {
    const hits = archive.filter(p => matches(def, texts.get(p.id) ?? ''));
    if (hits.length < (def.minPhotos ?? DEFAULT_MIN_PHOTOS)) continue;
    rows.push({
      slug: def.slug,
      title: def.title,
      subtitle: def.subtitle,
      kind: 'collection',
      total: hits.length,
      photos: hits.slice(0, MAX_PER_ROW).map(toCard)
    });
  }

  // --- Camera rows: "shot on X" is a genuinely different way to browse ---
  const byCamera = new Map<string, PhotoWithMeta[]>();
  const exifRows = await prisma.photoExif.findMany({
    where: { photoId: { in: archive.map(p => p.id) } },
    select: { photoId: true, make: true, model: true }
  });
  const cameraOf = new Map(
    exifRows.map(e => [e.photoId, [e.make, e.model].filter(Boolean).join(' ').trim()] as const)
  );
  for (const p of archive) {
    const cam = cameraOf.get(p.id);
    if (!cam) continue;
    if (!byCamera.has(cam)) byCamera.set(cam, []);
    byCamera.get(cam)!.push(p);
  }
  for (const [camera, hits] of [...byCamera.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 3)) {
    if (hits.length < 4) continue;
    rows.push({
      slug: 'camera-' + camera.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      title: `Shot on ${camera}`,
      subtitle: 'One body, one way of seeing',
      kind: 'camera',
      total: hits.length,
      photos: hits.slice(0, MAX_PER_ROW).map(toCard)
    });
  }

  // --- Any AI category with real volume that no curated row already covers ---
  const covered = new Set(rows.filter(r => r.kind === 'collection').map(r => r.slug));
  const categoryCounts = new Map<string, PhotoWithMeta[]>();
  for (const p of archive) {
    for (const t of p.terms) {
      if (t.kind !== 'category') continue;
      const key = t.value.toLowerCase();
      if (!categoryCounts.has(key)) categoryCounts.set(key, []);
      categoryCounts.get(key)!.push(p);
    }
  }
  for (const [cat, hits] of [...categoryCounts.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const slug = cat.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (covered.has(slug) || hits.length < 4) continue;
    if (rows.some(r => r.slug === slug)) continue;
    rows.push({
      slug,
      title: cat.replace(/\b\w/g, c => c.toUpperCase()),
      kind: 'category',
      total: hits.length,
      photos: hits.slice(0, MAX_PER_ROW).map(toCard)
    });
    if (rows.length > 40) break; // hard ceiling on feed length
  }

  return { rows, totalPhotos: archive.length, generatedAt: new Date().toISOString() };
}

export async function getDiscoveryFeed() {
  return cached('discovery:feed:v1', DISCOVERY_TTL_SECONDS, buildFeed);
}

/** Full contents of one row (Discovery rows are capped; this isn't). */
export async function getCollection(slug: string, limit = 60, offset = 0) {
  const archive = await loadArchive();
  const def = COLLECTION_BY_SLUG.get(slug);

  let hits: PhotoWithMeta[];
  let title: string;
  let subtitle: string | undefined;

  if (def) {
    title = def.title;
    subtitle = def.subtitle;
    hits = archive.filter(p => matches(def, searchableText(p)));
  } else if (slug === 'recent') {
    title = 'Recently Added';
    hits = archive;
  } else if (slug === 'featured') {
    title = 'Featured Work';
    hits = archive.filter(p => p.featured);
  } else {
    // Fall back to a literal category/tag term match.
    title = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const needle = slug.replace(/-/g, ' ');
    hits = archive.filter(p => p.terms.some(t => t.value.toLowerCase() === needle));
  }

  return {
    slug,
    title,
    subtitle,
    total: hits.length,
    photos: hits.slice(offset, offset + limit).map(toCard)
  };
}

/** Lightweight index of every populated collection (for nav / About / SEO). */
export async function listCollections() {
  const feed = await getDiscoveryFeed();
  return feed.rows
    .filter(r => r.kind === 'collection' || r.kind === 'category')
    .map(r => ({ slug: r.slug, title: r.title, subtitle: r.subtitle, total: r.total, cover: r.photos[0] ?? null }));
}
