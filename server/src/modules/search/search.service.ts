import { prisma } from '../../lib/prisma';
import { embed, toVectorLiteral } from '../../lib/embeddings';
import { withMediaPublic } from '../../lib/media';
import { cached } from '../../lib/redis';

interface SearchRow {
  photo_id: string;
  score: number;
  vector_score: number;
  term_score: number;
}

const SEARCH_CACHE_TTL_SECONDS = 300;

export async function searchPhotos(query: string, k = 12) {
  const cacheKey = `search:q:${query.trim().toLowerCase()}:${k}`;
  return cached(cacheKey, SEARCH_CACHE_TTL_SECONDS, () => runSearch(query, k));
}

async function runSearch(query: string, k: number) {
  const started = Date.now();
  const [vector] = await embed(query);

  const rows = await prisma.$queryRawUnsafe<SearchRow[]>(
    `SELECT * FROM search_photos($1::vector, $2, $3)`,
    toVectorLiteral(vector),
    query,
    k
  );

  const photos = rows.length
    ? await prisma.photo.findMany({
        where: { id: { in: rows.map(r => r.photo_id) } },
        include: { ai: true, exif: true, colors: { orderBy: { rank: 'asc' } } }
      })
    : [];
  const byId = new Map(photos.map(p => [p.id, p]));

  prisma.searchLog
    .create({ data: { query, mode: 'hybrid', resultIds: rows.map(r => r.photo_id), latencyMs: Date.now() - started } })
    .catch(() => {});

  return rows
    .map(r => {
      const photo = byId.get(r.photo_id);
      if (!photo) return null;
      return {
        score: r.score,
        vectorScore: r.vector_score,
        termScore: r.term_score,
        photo: { ...withMediaPublic(photo, photo.ai), exif: photo.exif, colors: photo.colors }
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
}

export async function similarPhotos(photoId: string, k = 6) {
  const rows = await prisma.$queryRawUnsafe<{ photo_id: string; score: number }[]>(
    `SELECT * FROM similar_photos($1::uuid, $2)`,
    photoId,
    k
  );
  const photos = rows.length
    ? await prisma.photo.findMany({
        where: { id: { in: rows.map(r => r.photo_id) } },
        include: { ai: true, exif: true, colors: { orderBy: { rank: 'asc' } } }
      })
    : [];
  const byId = new Map(photos.map(p => [p.id, p] as [string, typeof photos[number]]));

  return rows
    .map(r => {
      const photo = byId.get(r.photo_id);
      if (!photo) return null;
      return { score: r.score, photo: { ...withMediaPublic(photo, photo.ai), exif: photo.exif, colors: photo.colors } };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
}
