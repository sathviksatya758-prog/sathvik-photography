/* ============================================================
   lib.ts — server building blocks
   Postgres + pgvector, Anthropic vision, sharp image pipeline.

   npm i pg sharp exifr @anthropic-ai/sdk zod
   ============================================================ */

import { Pool } from 'pg';
import sharp from 'sharp';
import exifr from 'exifr';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const MODEL = 'claude-sonnet-4-20250514';
const EMBED_MODEL = process.env.EMBED_MODEL ?? 'text-embedding-3-small';
const EMBED_DIMS = 1536;

/* ------------------------------------------------------------
   1. Embeddings
   ------------------------------------------------------------ */
export async function embed(input: string | string[]): Promise<number[][]> {
  const texts = Array.isArray(input) ? input : [input];
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts, dimensions: EMBED_DIMS })
  });
  if (!res.ok) throw new Error(`Embedding failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data.map(d => d.embedding);
}

const toVector = (v: number[]) => `[${v.join(',')}]`;

/* ------------------------------------------------------------
   2. Image pipeline — AVIF + WebP + JPEG fallback
   ------------------------------------------------------------ */
export const RENDITION_WIDTHS = [320, 640, 960, 1440, 2048] as const;

export interface Rendition {
  format: 'avif' | 'webp' | 'jpeg';
  width: number;
  height: number;
  bytes: number;
  buffer: Buffer;
}

export async function buildRenditions(original: Buffer): Promise<{
  renditions: Rendition[];
  lqip: string;
  width: number;
  height: number;
  aspect: number;
}> {
  const base = sharp(original, { failOn: 'none' }).rotate();
  const meta = await base.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const targets = RENDITION_WIDTHS.filter(w => w <= width);
  if (!targets.length) targets.push(width as (typeof RENDITION_WIDTHS)[number]);

  const renditions: Rendition[] = [];
  for (const w of targets) {
    const resized = sharp(original).rotate().resize({ width: w, withoutEnlargement: true });
    const [avif, webp, jpeg] = await Promise.all([
      resized.clone().avif({ quality: 55, effort: 4 }).toBuffer({ resolveWithObject: true }),
      resized.clone().webp({ quality: 78 }).toBuffer({ resolveWithObject: true }),
      resized.clone().jpeg({ quality: 82, mozjpeg: true }).toBuffer({ resolveWithObject: true })
    ]);
    renditions.push(
      { format: 'avif', width: avif.info.width, height: avif.info.height, bytes: avif.info.size, buffer: avif.data },
      { format: 'webp', width: webp.info.width, height: webp.info.height, bytes: webp.info.size, buffer: webp.data },
      { format: 'jpeg', width: jpeg.info.width, height: jpeg.info.height, bytes: jpeg.info.size, buffer: jpeg.data }
    );
  }

  const lqipBuf = await sharp(original).rotate().resize({ width: 24 })
    .blur(1.2).jpeg({ quality: 40 }).toBuffer();

  return {
    renditions,
    lqip: `data:image/jpeg;base64,${lqipBuf.toString('base64')}`,
    width,
    height,
    aspect: height ? width / height : 1
  };
}

export function srcSet(
  photoId: string,
  format: 'avif' | 'webp' | 'jpeg',
  widths: number[]
): string {
  const cdn = process.env.CDN_BASE ?? '/media';
  return widths.map(w => `${cdn}/${photoId}/${w}.${format} ${w}w`).join(', ');
}

/* ------------------------------------------------------------
   3. EXIF ingest
   ------------------------------------------------------------ */
export async function readExif(buffer: Buffer) {
  const x = await exifr.parse(buffer, {
    tiff: true, exif: true, gps: true, ifd0: true,
    pick: ['Make', 'Model', 'LensModel', 'FocalLength', 'FocalLengthIn35mmFormat',
      'FNumber', 'ExposureTime', 'ISO', 'ExposureCompensation', 'Flash',
      'WhiteBalance', 'Software', 'DateTimeOriginal', 'latitude', 'longitude']
  }).catch(() => null);
  if (!x) return null;
  return {
    make: x.Make ?? null,
    model: x.Model ?? null,
    lens: x.LensModel ?? null,
    focal_mm: x.FocalLength ?? null,
    focal_35mm: x.FocalLengthIn35mmFormat ?? null,
    aperture: x.FNumber ?? null,
    shutter_sec: x.ExposureTime ?? null,
    iso: x.ISO ?? null,
    exposure_bias: x.ExposureCompensation ?? null,
    flash: typeof x.Flash === 'string' ? x.Flash : (x.Flash ? 'Fired' : null),
    white_balance: x.WhiteBalance != null ? String(x.WhiteBalance) : null,
    software: x.Software ?? null,
    taken_at: x.DateTimeOriginal ?? null,
    gps_lat: x.latitude ?? null,
    gps_lon: x.longitude ?? null,
    raw: x
  };
}

/* ------------------------------------------------------------
   4. Vision enrichment
   ------------------------------------------------------------ */
export const AiMeta = z.object({
  caption: z.string(),
  subject: z.string().optional().default(''),
  description: z.string(),
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
  editingStyle: z.string(),
  technicalNote: z.string().optional().default(''),
  locationGuess: z.string().nullable().optional().default(null)
});
export type AiMeta = z.infer<typeof AiMeta>;

export async function enrichPhoto(
  imageBase64: string,
  mediaType: string,
  exif: Awaited<ReturnType<typeof readExif>>,
  palette: { hex: string; share: number }[]
): Promise<AiMeta> {
  const context = [
    exif && `Camera: ${[exif.make, exif.model].filter(Boolean).join(' ')}` +
      `${exif.lens ? `, lens ${exif.lens}` : ''}` +
      `${exif.aperture ? `, f/${exif.aperture}` : ''}` +
      `${exif.iso ? `, ISO ${exif.iso}` : ''}.`,
    palette.length && `Dominant colours: ${palette.map(p => p.hex).join(', ')}.`
  ].filter(Boolean).join(' ');

  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1600,
    system:
      'You are a photography curator writing exhibition catalogue metadata. ' +
      'Reply with one JSON object and nothing else. Be specific, never generic.',
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType as any, data: imageBase64 } },
        {
          type: 'text',
          text: `${context}\n\nReturn JSON with keys: caption, subject, description, altText, ` +
            `story, tags[], categories[], collections[], seoKeywords[], hashtags[], mood, ` +
            `composition, lighting, colorAnalysis, editingStyle, technicalNote, locationGuess.`
        }
      ]
    }]
  });

  const text = msg.content.filter(b => b.type === 'text').map(b => (b as any).text).join('\n');
  const json = JSON.parse(text.replace(/```json|```/g, '').trim());
  return AiMeta.parse(json);
}

/* ------------------------------------------------------------
   5. Persistence
   ------------------------------------------------------------ */
export async function savePhoto(payload: {
  slug: string;
  storageKey: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  aspect: number;
  lqip: string;
  exif: Awaited<ReturnType<typeof readExif>>;
  ai: AiMeta;
  palette: { hex: string; r: number; g: number; b: number; share: number }[];
  renditions: { format: string; width: number; height: number; bytes: number; key: string }[];
}) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO photos (slug, storage_key, width, height, aspect, bytes, mime, lqip,
                           status, captured_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ready',$9) RETURNING id`,
      [payload.slug, payload.storageKey, payload.width, payload.height, payload.aspect,
        payload.bytes, payload.mime, payload.lqip, payload.exif?.taken_at ?? null]
    );
    const photoId: string = rows[0].id;

    if (payload.exif) {
      const e = payload.exif;
      await client.query(
        `INSERT INTO photo_exif (photo_id, make, model, lens, focal_mm, focal_35mm, aperture,
           shutter_sec, iso, exposure_bias, flash, white_balance, software, taken_at,
           gps_lat, gps_lon, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [photoId, e.make, e.model, e.lens, e.focal_mm, e.focal_35mm, e.aperture,
          e.shutter_sec, e.iso, e.exposure_bias, e.flash, e.white_balance, e.software,
          e.taken_at, e.gps_lat, e.gps_lon, JSON.stringify(e.raw)]
      );
    }

    const a = payload.ai;
    await client.query(
      `INSERT INTO photo_ai (photo_id, caption, subject, description, alt_text, story, mood,
         composition, lighting, color_analysis, editing_style, technical_note, location_guess,
         model_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [photoId, a.caption, a.subject, a.description, a.altText, a.story, a.mood,
        a.composition, a.lighting, a.colorAnalysis, a.editingStyle, a.technicalNote,
        a.locationGuess, MODEL]
    );

    const terms: [string, string][] = [
      ...a.tags.map(t => ['tag', t] as [string, string]),
      ...a.categories.map(t => ['category', t] as [string, string]),
      ...a.collections.map(t => ['collection', t] as [string, string]),
      ...a.seoKeywords.map(t => ['seo', t] as [string, string]),
      ...a.hashtags.map(t => ['hashtag', t] as [string, string])
    ];
    for (const [kind, value] of terms) {
      await client.query(
        `INSERT INTO photo_terms (photo_id, kind, value) VALUES ($1,$2,$3)
         ON CONFLICT DO NOTHING`, [photoId, kind, value.toLowerCase()]
      );
    }

    for (const [i, c] of payload.palette.entries()) {
      await client.query(
        `INSERT INTO photo_colors (photo_id, hex, r, g, b, share, rank)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [photoId, c.hex, c.r, c.g, c.b, c.share, i]
      );
    }

    for (const r of payload.renditions) {
      await client.query(
        `INSERT INTO photo_renditions (photo_id, format, width, height, bytes, storage_key)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [photoId, r.format, r.width, r.height, r.bytes, r.key]
      );
    }

    const embedText = [a.caption, a.subject, a.description, a.story, a.mood,
      a.tags.join(' '), a.categories.join(' ')].filter(Boolean).join('. ');
    const [vec] = await embed(embedText);
    await client.query(
      `INSERT INTO photo_embeddings (photo_id, embedding, model) VALUES ($1,$2,$3)
       ON CONFLICT (photo_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
      [photoId, toVector(vec), EMBED_MODEL]
    );

    await client.query(
      `INSERT INTO knowledge_chunks (kind, title, body, photo_id, embedding, token_len)
       VALUES ('photo',$1,$2,$3,$4,$5)`,
      [a.caption, embedText, photoId, toVector(vec), Math.ceil(embedText.length / 4)]
    );

    await client.query('COMMIT');
    return photoId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------
   6. Search + similarity
   ------------------------------------------------------------ */
export async function searchPhotos(query: string, k = 12) {
  const started = Date.now();
  const [vec] = await embed(query);
  const { rows } = await db.query(
    `SELECT s.photo_id, s.score, s.vector_score, s.term_score,
            p.slug, p.lqip, p.aspect, a.caption, a.alt_text, a.mood
     FROM search_photos($1::vector, $2, $3) s
     JOIN photos p ON p.id = s.photo_id
     LEFT JOIN photo_ai a ON a.photo_id = s.photo_id`,
    [toVector(vec), query, k]
  );
  await db.query(
    `INSERT INTO search_log (query, mode, result_ids, latency_ms)
     VALUES ($1,'hybrid',$2,$3)`,
    [query, rows.map(r => r.photo_id), Date.now() - started]
  );
  return rows;
}

export async function similarPhotos(photoId: string, k = 6) {
  const { rows } = await db.query(
    `SELECT s.photo_id, s.score, p.slug, p.lqip, p.aspect, a.caption, a.alt_text
     FROM similar_photos($1, $2) s
     JOIN photos p ON p.id = s.photo_id
     LEFT JOIN photo_ai a ON a.photo_id = s.photo_id`,
    [photoId, k]
  );
  return rows;
}

/* ------------------------------------------------------------
   7. RAG
   ------------------------------------------------------------ */
export async function retrieve(question: string, k = 6) {
  const [vec] = await embed(question);
  const { rows } = await db.query(
    `SELECT id, kind, title, body, photo_id,
            1 - (embedding <=> $1::vector) AS score
     FROM knowledge_chunks
     WHERE embedding IS NOT NULL
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    [toVector(vec), k]
  );
  return rows.filter(r => r.score > 0.15);
}

export async function answerWithRag(
  question: string,
  history: { role: 'user' | 'assistant'; content: string }[] = []
) {
  const hits = await retrieve(question, 6);
  const context = hits.length
    ? hits.map((h, i) => `[${i + 1}] ${h.title}: ${h.body}`).join('\n\n')
    : 'No matching entries.';

  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 700,
    system:
      'You are the studio assistant for photographer Katnam Sathvik. Answer only from the ' +
      'retrieved context. Cite sources inline as [1], [2]. If the context lacks the answer, ' +
      'say so and point to sathviksatya758@gmail.com. Warm, concise, under 5 sentences. ' +
      'Never invent prices, availability or gear.',
    messages: [
      ...history.slice(-6),
      { role: 'user', content: `Context:\n\n${context}\n\nQuestion: ${question}` }
    ]
  });

  return {
    answer: msg.content.filter(b => b.type === 'text').map(b => (b as any).text).join('\n'),
    sources: hits.map((h, i) => ({ n: i + 1, title: h.title, kind: h.kind, photoId: h.photo_id }))
  };
}

export async function reindexKnowledge(entries: { kind: string; title: string; body: string }[]) {
  const vectors = await embed(entries.map(e => e.body));
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM knowledge_chunks WHERE kind <> 'photo'`);
    for (const [i, e] of entries.entries()) {
      await client.query(
        `INSERT INTO knowledge_chunks (kind, title, body, embedding, token_len)
         VALUES ($1,$2,$3,$4,$5)`,
        [e.kind, e.title, e.body, toVector(vectors[i]), Math.ceil(e.body.length / 4)]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
