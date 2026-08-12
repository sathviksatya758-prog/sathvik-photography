/* ============================================================
   routes.ts — Next.js App Router handlers
   Split each export into its own app/api/<name>/route.ts file,
   or mount with the Express adapter at the bottom.
   ============================================================ */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import {
  db, embed, readExif, enrichPhoto, savePhoto, buildRenditions,
  searchPhotos, similarPhotos, answerWithRag, reindexKnowledge
} from './lib';

export const runtime = 'nodejs';
export const maxDuration = 60;

/* ---------- rate limiting ---------- */
const buckets = new Map<string, { n: number; reset: number }>();
function limit(req: NextRequest, max: number, windowMs: number) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0] ?? 'local';
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || now > b.reset) { buckets.set(ip, { n: 1, reset: now + windowMs }); return true; }
  if (b.n >= max) return false;
  b.n++; return true;
}
const tooMany = () => NextResponse.json({ error: 'Too many requests' }, { status: 429 });

/* ---------- auth ---------- */
async function currentUser(req: NextRequest) {
  const token = req.cookies.get('session')?.value;
  if (!token) return null;
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.username, u.role
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.expires_at > now()`, [token]);
  return rows[0] ?? null;
}
const forbidden = () => NextResponse.json({ error: 'Owner access required' }, { status: 403 });

/* ============================================================
   POST /api/upload  — owner only
   multipart/form-data: file
   ============================================================ */
export async function POST_upload(req: NextRequest) {
  if (!limit(req, 20, 60_000)) return tooMany();
  const user = await currentUser(req);
  if (!user || user.role !== 'owner') return forbidden();

  const form = await req.formData();
  const file = form.get('file') as File | null;
  if (!file) return NextResponse.json({ error: 'No file' }, { status: 400 });
  if (!file.type.startsWith('image/'))
    return NextResponse.json({ error: 'Not an image' }, { status: 415 });
  if (file.size > 25 * 1024 * 1024)
    return NextResponse.json({ error: 'Max 25MB' }, { status: 413 });

  const buffer = Buffer.from(await file.arrayBuffer());
  const [exif, built] = await Promise.all([readExif(buffer), buildRenditions(buffer)]);

  const sharpMod = (await import('sharp')).default;
  const { dominant } = await sharpMod(buffer).stats();
  const raw = await sharpMod(buffer).resize(48, 48, { fit: 'cover' })
    .raw().toBuffer({ resolveWithObject: true });
  const palette = quantize(raw.data, 5);
  if (!palette.length) {
    palette.push({ hex: rgbHex(dominant.r, dominant.g, dominant.b),
      r: dominant.r, g: dominant.g, b: dominant.b, share: 1 });
  }

  const preview = await sharpMod(buffer).resize({ width: 1024 })
    .jpeg({ quality: 80 }).toBuffer();
  const ai = await enrichPhoto(preview.toString('base64'), 'image/jpeg', exif,
    palette.map(p => ({ hex: p.hex, share: p.share })));

  const slug = `${slugify(ai.caption)}-${crypto.randomBytes(3).toString('hex')}`;
  const storageKey = `originals/${slug}`;
  await putObject(storageKey, buffer, file.type);

  const renditionRows = [];
  for (const r of built.renditions) {
    const key = `renditions/${slug}/${r.width}.${r.format}`;
    await putObject(key, r.buffer, `image/${r.format}`);
    renditionRows.push({ format: r.format, width: r.width, height: r.height, bytes: r.bytes, key });
  }

  const photoId = await savePhoto({
    slug, storageKey, mime: file.type, bytes: file.size,
    width: built.width, height: built.height, aspect: built.aspect, lqip: built.lqip,
    exif, ai, palette, renditions: renditionRows
  });

  return NextResponse.json({ id: photoId, slug, lqip: built.lqip, ai, exif, palette });
}

/* ============================================================
   GET /api/photos?limit=&cursor=&category=
   ============================================================ */
export async function GET_photos(req: NextRequest) {
  const url = new URL(req.url);
  const limitN = Math.min(Number(url.searchParams.get('limit') ?? 24), 60);
  const cursor = url.searchParams.get('cursor');
  const category = url.searchParams.get('category');

  const { rows } = await db.query(
    `SELECT p.id, p.slug, p.lqip, p.aspect, p.width, p.height, p.created_at,
            a.caption, a.alt_text, a.description, a.mood,
            COALESCE(json_agg(DISTINCT t.value) FILTER (WHERE t.kind='tag'), '[]') AS tags,
            COALESCE(json_agg(DISTINCT c.value) FILTER (WHERE c.kind='category'), '[]') AS categories
     FROM photos p
     LEFT JOIN photo_ai a ON a.photo_id = p.id
     LEFT JOIN photo_terms t ON t.photo_id = p.id AND t.kind = 'tag'
     LEFT JOIN photo_terms c ON c.photo_id = p.id AND c.kind = 'category'
     WHERE p.deleted_at IS NULL AND p.status = 'ready'
       AND ($1::timestamptz IS NULL OR p.created_at < $1)
       AND ($2::text IS NULL OR EXISTS (
             SELECT 1 FROM photo_terms f
             WHERE f.photo_id = p.id AND f.kind='category' AND f.value = $2))
     GROUP BY p.id, a.caption, a.alt_text, a.description, a.mood
     ORDER BY p.created_at DESC
     LIMIT $3`,
    [cursor, category, limitN]
  );

  return NextResponse.json({
    photos: rows,
    nextCursor: rows.length === limitN ? rows[rows.length - 1].created_at : null
  }, { headers: { 'Cache-Control': 's-maxage=60, stale-while-revalidate=300' } });
}

/* ============================================================
   GET /api/photos/[slug] — full detail incl. EXIF, palette, related
   ============================================================ */
export async function GET_photo(_req: NextRequest, ctx: { params: { slug: string } }) {
  const { rows } = await db.query(
    `SELECT p.*, row_to_json(e) AS exif, row_to_json(a) AS ai,
            COALESCE(json_agg(DISTINCT jsonb_build_object(
              'hex', c.hex, 'share', c.share, 'rank', c.rank))
              FILTER (WHERE c.id IS NOT NULL), '[]') AS palette,
            COALESCE(json_agg(DISTINCT jsonb_build_object(
              'kind', t.kind, 'value', t.value))
              FILTER (WHERE t.id IS NOT NULL), '[]') AS terms
     FROM photos p
     LEFT JOIN photo_exif e ON e.photo_id = p.id
     LEFT JOIN photo_ai a ON a.photo_id = p.id
     LEFT JOIN photo_colors c ON c.photo_id = p.id
     LEFT JOIN photo_terms t ON t.photo_id = p.id
     WHERE p.slug = $1 AND p.deleted_at IS NULL
     GROUP BY p.id, e.*, a.*`,
    [ctx.params.slug]
  );
  if (!rows[0]) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const related = await similarPhotos(rows[0].id, 6);
  db.query(`INSERT INTO photo_views (photo_id) VALUES ($1)`, [rows[0].id]).catch(() => {});

  return NextResponse.json({ photo: rows[0], related }, {
    headers: { 'Cache-Control': 's-maxage=300, stale-while-revalidate=900' }
  });
}

/* ============================================================
   GET /api/search?q=  — hybrid semantic + lexical
   ============================================================ */
export async function GET_search(req: NextRequest) {
  if (!limit(req, 30, 60_000)) return tooMany();
  const q = new URL(req.url).searchParams.get('q')?.trim();
  if (!q) return NextResponse.json({ results: [] });
  if (q.length > 200) return NextResponse.json({ error: 'Query too long' }, { status: 400 });
  return NextResponse.json({ results: await searchPhotos(q, 12) });
}

/* ============================================================
   GET /api/similar/[id]
   ============================================================ */
export async function GET_similar(_req: NextRequest, ctx: { params: { id: string } }) {
  return NextResponse.json({ results: await similarPhotos(ctx.params.id, 6) }, {
    headers: { 'Cache-Control': 's-maxage=600, stale-while-revalidate=3600' }
  });
}

/* ============================================================
   POST /api/assistant  — RAG chat
   ============================================================ */
export async function POST_assistant(req: NextRequest) {
  if (!limit(req, 20, 60_000)) return tooMany();
  const { question, history } = await req.json();
  if (!question || typeof question !== 'string')
    return NextResponse.json({ error: 'Question required' }, { status: 400 });
  if (question.length > 600)
    return NextResponse.json({ error: 'Question too long' }, { status: 400 });
  try {
    return NextResponse.json(await answerWithRag(question, history ?? []));
  } catch (e: any) {
    return NextResponse.json({ error: 'Assistant unavailable' }, { status: 502 });
  }
}

/* ============================================================
   POST /api/reindex — owner only, rebuilds bio + FAQ vectors
   ============================================================ */
export async function POST_reindex(req: NextRequest) {
  const user = await currentUser(req);
  if (!user || user.role !== 'owner') return forbidden();
  const { entries } = await req.json();
  await reindexKnowledge(entries);
  return NextResponse.json({ ok: true, count: entries.length });
}

/* ============================================================
   DELETE /api/photos/[id] — soft delete, owner only
   ============================================================ */
export async function DELETE_photo(req: NextRequest, ctx: { params: { id: string } }) {
  const user = await currentUser(req);
  if (!user || user.role !== 'owner') return forbidden();
  await db.query(`UPDATE photos SET deleted_at = now(), status='hidden' WHERE id = $1`,
    [ctx.params.id]);
  return NextResponse.json({ ok: true });
}

/* ============================================================
   Helpers
   ============================================================ */
function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'frame';
}
const rgbHex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');

function quantize(raw: Buffer, k: number) {
  const px: number[][] = [];
  for (let i = 0; i < raw.length; i += 3) px.push([raw[i], raw[i + 1], raw[i + 2]]);
  if (!px.length) return [];
  const cents = Array.from({ length: k }, (_, i) => px[Math.floor(i * px.length / k)].slice());
  const assign = new Array(px.length).fill(0);
  for (let it = 0; it < 8; it++) {
    px.forEach((p, i) => {
      let best = 0, bd = Infinity;
      cents.forEach((c, ci) => {
        const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
        if (d < bd) { bd = d; best = ci; }
      });
      assign[i] = best;
    });
    const sums = cents.map(() => [0, 0, 0, 0]);
    px.forEach((p, i) => {
      const a = assign[i];
      sums[a][0] += p[0]; sums[a][1] += p[1]; sums[a][2] += p[2]; sums[a][3]++;
    });
    sums.forEach((s, i) => { if (s[3]) cents[i] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]; });
  }
  const counts = new Array(k).fill(0);
  assign.forEach(a => counts[a]++);
  return cents.map((c, i) => ({
    hex: rgbHex(c[0], c[1], c[2]),
    r: Math.round(c[0]), g: Math.round(c[1]), b: Math.round(c[2]),
    share: counts[i] / px.length
  })).filter(c => c.share > 0.02).sort((a, b) => b.share - a.share);
}

/* S3/R2 object storage — swap for your provider */
async function putObject(key: string, body: Buffer, contentType: string) {
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
  const s3 = new S3Client({
    region: process.env.S3_REGION ?? 'auto',
    endpoint: process.env.S3_ENDPOINT,
    credentials: {
      accessKeyId: process.env.S3_KEY!,
      secretAccessKey: process.env.S3_SECRET!
    }
  });
  await s3.send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET!,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable'
  }));
  return key;
}
