import { prisma } from '../../lib/prisma';
import { cached, cacheDel } from '../../lib/redis';
import { anthropic, MODEL, extractText } from '../../lib/anthropic';
import { logger } from '../../lib/logger';
import { publicUrl } from '../../lib/storage';

const INSIGHTS_CACHE_KEY = 'admin:insights:v1';
const INSIGHTS_TTL_SECONDS = 6 * 3600;

interface CountRow {
  label: string | null;
  count: bigint;
}

async function topSubjects(limit = 10) {
  // subjects is a text[] column — unnest to count individual entries
  // rather than whole-array groupings.
  const rows = await prisma.$queryRaw<CountRow[]>`
    SELECT s AS label, COUNT(*)::bigint AS count
    FROM "photo_ai", unnest(subjects) AS s
    GROUP BY s ORDER BY count DESC LIMIT ${limit}
  `;
  return rows.map(r => ({ label: r.label, count: Number(r.count) }));
}

// `table`/`column` are always internal literals (never user input), so
// string interpolation here is safe despite using $queryRawUnsafe.
async function groupByColumn(table: string, column: string, limit = 10) {
  const rows = await prisma.$queryRawUnsafe<CountRow[]>(
    `SELECT ${column} AS label, COUNT(*)::bigint AS count
     FROM "${table}"
     WHERE ${column} IS NOT NULL
     GROUP BY ${column} ORDER BY count DESC LIMIT ${limit}`
  );
  return rows.map(r => ({ label: r.label, count: Number(r.count) }));
}

async function cameraUsage(limit = 10) {
  const rows = await prisma.$queryRaw<CountRow[]>`
    SELECT TRIM(COALESCE(make, '') || ' ' || COALESCE(model, '')) AS label, COUNT(*)::bigint AS count
    FROM "photo_exif"
    WHERE make IS NOT NULL OR model IS NOT NULL
    GROUP BY label ORDER BY count DESC LIMIT ${limit}
  `;
  return rows.map(r => ({ label: r.label, count: Number(r.count) })).filter(r => r.label);
}

async function focalLengthHistogram() {
  // Buckets match common prime/zoom focal lengths rather than a
  // continuous histogram, which reads more usefully for a photographer.
  const rows = await prisma.$queryRaw<{ bucket: string; count: bigint }[]>`
    SELECT CASE
      WHEN focal_mm < 24 THEN 'Under 24mm'
      WHEN focal_mm < 35 THEN '24-35mm'
      WHEN focal_mm < 50 THEN '35-50mm'
      WHEN focal_mm < 85 THEN '50-85mm'
      WHEN focal_mm < 135 THEN '85-135mm'
      ELSE '135mm+'
    END AS bucket, COUNT(*)::bigint AS count
    FROM "photo_exif" WHERE focal_mm IS NOT NULL
    GROUP BY bucket ORDER BY MIN(focal_mm)
  `;
  return rows.map(r => ({ label: r.bucket, count: Number(r.count) }));
}

async function isoDistribution() {
  const rows = await prisma.$queryRaw<{ bucket: string; count: bigint }[]>`
    SELECT CASE
      WHEN iso <= 200 THEN 'ISO 100-200'
      WHEN iso <= 400 THEN 'ISO 400'
      WHEN iso <= 800 THEN 'ISO 800'
      WHEN iso <= 1600 THEN 'ISO 1600'
      WHEN iso <= 3200 THEN 'ISO 3200'
      ELSE 'ISO 3200+'
    END AS bucket, COUNT(*)::bigint AS count
    FROM "photo_exif" WHERE iso IS NOT NULL
    GROUP BY bucket ORDER BY MIN(iso)
  `;
  return rows.map(r => ({ label: r.bucket, count: Number(r.count) }));
}

async function colorTrends(limit = 8) {
  const rows = await prisma.$queryRaw<{ hex: string; total_share: number; uses: bigint }[]>`
    SELECT hex, SUM(share)::float AS total_share, COUNT(*)::bigint AS uses
    FROM "photo_colors"
    GROUP BY hex ORDER BY total_share DESC LIMIT ${limit}
  `;
  return rows.map(r => ({ hex: r.hex, totalShare: r.total_share, uses: Number(r.uses) }));
}

async function shootingLocations(limit = 10) {
  const rows = await prisma.$queryRaw<CountRow[]>`
    SELECT COALESCE(e.place_name, a.location_guess) AS label, COUNT(*)::bigint AS count
    FROM "photos" p
    LEFT JOIN "photo_exif" e ON e.photo_id = p.id
    LEFT JOIN "photo_ai" a ON a.photo_id = p.id
    WHERE COALESCE(e.place_name, a.location_guess) IS NOT NULL
    GROUP BY label ORDER BY count DESC LIMIT ${limit}
  `;
  return rows.map(r => ({ label: r.label, count: Number(r.count) }));
}

async function seasonalTrends() {
  const rows = await prisma.$queryRaw<{ month: number; count: bigint }[]>`
    SELECT EXTRACT(MONTH FROM COALESCE(e.taken_at, p.captured_at, p.created_at))::int AS month, COUNT(*)::bigint AS count
    FROM "photos" p LEFT JOIN "photo_exif" e ON e.photo_id = p.id
    WHERE p.deleted_at IS NULL
    GROUP BY month ORDER BY month
  `;
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return rows.map(r => ({ label: names[r.month - 1], count: Number(r.count) }));
}

async function monthlyUploads(months = 12) {
  const rows = await prisma.$queryRaw<{ month: Date; count: bigint }[]>`
    SELECT date_trunc('month', created_at) AS month, COUNT(*)::bigint AS count
    FROM "photos" WHERE deleted_at IS NULL
      AND created_at >= now() - (${months} || ' months')::interval
    GROUP BY month ORDER BY month
  `;
  return rows.map(r => ({ month: r.month, count: Number(r.count) }));
}

async function genreDistribution(limit = 10) {
  return groupByColumn('photo_ai', 'genre', limit);
}

async function computeInsights() {
  const [
    subjects,
    genres,
    cameras,
    lenses,
    focalLengths,
    isoBuckets,
    colors,
    locations,
    seasonal,
    monthly,
    totalPhotos,
    avgScores,
    mostViewed,
    mostDownloaded
  ] = await Promise.all([
    topSubjects(),
    genreDistribution(),
    cameraUsage(),
    groupByColumn('photo_exif', 'lens'),
    focalLengthHistogram(),
    isoDistribution(),
    colorTrends(),
    shootingLocations(),
    seasonalTrends(),
    monthlyUploads(),
    prisma.photo.count({ where: { deletedAt: null, status: 'READY' } }),
    prisma.$queryRaw<{ avg_composition: number | null; avg_quality: number | null }[]>`
      SELECT AVG(composition_score)::float AS avg_composition, AVG(quality_score)::float AS avg_quality
      FROM "photo_ai"
    `,
    topPhotosBy('photo_views'),
    topPhotosBy('downloads')
  ]);

  return {
    totalPhotos,
    topSubjects: subjects,
    genreDistribution: genres,
    cameraUsage: cameras,
    lensUsage: lenses,
    focalLengthDistribution: focalLengths,
    isoDistribution: isoBuckets,
    colorTrends: colors,
    shootingLocations: locations,
    seasonalTrends: seasonal,
    monthlyUploads: monthly,
    averageScores: {
      composition: avgScores[0]?.avg_composition ?? null,
      quality: avgScores[0]?.avg_quality ?? null
    },
    mostViewed,
    mostDownloaded
  };
}

/** Top photos by row count in an event table (photo_views or downloads),
 *  joined back to caption/slug/lqip for the dashboard's leaderboards. */
async function topPhotosBy(table: 'photo_views' | 'downloads', limit = 8) {
  const rows = await prisma.$queryRawUnsafe<{ photo_id: string; n: bigint; slug: string; lqip: string | null; caption: string | null }[]>(
    `SELECT e.photo_id, COUNT(*)::bigint AS n, p.slug, p.lqip, a.caption
     FROM "${table}" e
     JOIN "photos" p ON p.id = e.photo_id AND p.deleted_at IS NULL
     LEFT JOIN "photo_ai" a ON a.photo_id = e.photo_id
     GROUP BY e.photo_id, p.slug, p.lqip, a.caption
     ORDER BY n DESC LIMIT ${limit}`
  );
  return rows.map(r => ({
    photoId: r.photo_id,
    slug: r.slug,
    lqip: r.lqip,
    caption: r.caption,
    count: Number(r.n),
    thumb: publicUrl(`renditions/${r.slug}/640.jpeg`)
  }));
}

async function generateNarrative(stats: Awaited<ReturnType<typeof computeInsights>>): Promise<string> {
  if (!stats.totalPhotos) return 'No photos in the archive yet — insights will appear once you upload some.';
  try {
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 300,
      system:
        'You write a short (3-4 sentence), specific, warm summary of a photographer\'s shooting ' +
        'habits from aggregate statistics. No generic praise — cite actual numbers/patterns from ' +
        'the data given. Plain text, no markdown.',
      messages: [{ role: 'user', content: `Portfolio statistics as JSON:\n${JSON.stringify(stats)}` }]
    });
    return extractText(msg.content);
  } catch (err) {
    logger.error({ err }, 'insights narrative generation failed');
    return '';
  }
}

export async function getPortfolioInsights(forceRefresh = false) {
  if (forceRefresh) await cacheDel(INSIGHTS_CACHE_KEY);
  return cached(INSIGHTS_CACHE_KEY, INSIGHTS_TTL_SECONDS, async () => {
    const stats = await computeInsights();
    const narrative = await generateNarrative(stats);
    return { ...stats, narrative, generatedAt: new Date().toISOString() };
  });
}
