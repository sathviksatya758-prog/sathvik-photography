import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { put as blobPut, del as blobDel } from '@vercel/blob';
import type { Readable } from 'node:stream';
import path from 'node:path';
import fs from 'node:fs/promises';
import { env, caps } from '../config/env';
import { logger } from './logger';

// Three interchangeable object-storage drivers behind one interface:
//
//   Blob driver  — used on Vercel, where there's no writable/persistent
//                  local disk. Configured automatically once a Vercel Blob
//                  store is connected to the project (BLOB_READ_WRITE_TOKEN
//                  is injected; BLOB_BASE_URL is set once at provisioning).
//   S3 driver    — used when S3_BUCKET/S3_KEY/S3_SECRET are configured.
//                  Works unmodified against AWS S3, Cloudflare R2, Supabase
//                  Storage (S3 protocol), or MinIO. Public URLs come from
//                  CDN_BASE (or the S3 endpoint).
//   Local driver — the zero-config default for local dev. Writes objects as
//                  files under LOCAL_STORAGE_DIR and serves them from
//                  `${API_BASE_URL}/media/<key>` (see the /media route in
//                  app.ts). Lets uploads work end-to-end with no cloud
//                  storage account.
//
// The rest of the app calls putObject/getObject/deleteObject/publicUrl and
// never knows which driver is active.

const LOCAL_ROOT = path.resolve(process.cwd(), env.LOCAL_STORAGE_DIR);

// Reject keys that could escape the storage root via `..` or absolute paths.
function safeLocalPath(key: string): string {
  const full = path.resolve(LOCAL_ROOT, key);
  if (full !== LOCAL_ROOT && !full.startsWith(LOCAL_ROOT + path.sep)) {
    throw new Error(`Unsafe storage key: ${key}`);
  }
  return full;
}

const s3 = caps.s3
  ? new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: env.S3_KEY as string, secretAccessKey: env.S3_SECRET as string }
    })
  : null;

// Deterministic public URL for a Blob object — addRandomSuffix:false on put()
// guarantees the object actually lives here, so this needs no network call.
function blobUrlFor(key: string): string {
  return `${(env.BLOB_BASE_URL as string).replace(/\/$/, '')}/${key}`;
}

export async function putObject(key: string, body: Buffer, contentType: string): Promise<string> {
  if (caps.blob) {
    await blobPut(key, body, {
      access: 'public',
      contentType,
      addRandomSuffix: false,
      allowOverwrite: true,
      token: env.BLOB_READ_WRITE_TOKEN
    });
    return key;
  }
  if (s3) {
    await s3.send(
      new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable'
      })
    );
    return key;
  }
  const dest = safeLocalPath(key);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, body);
  return key;
}

export async function getObject(key: string): Promise<Buffer> {
  if (caps.blob) {
    const res = await fetch(blobUrlFor(key));
    if (!res.ok) throw new Error(`Blob object not found: ${key}`);
    return Buffer.from(await res.arrayBuffer());
  }
  if (s3) {
    const res = await s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    const stream = res.Body as Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  return fs.readFile(safeLocalPath(key));
}

export async function deleteObject(key: string): Promise<void> {
  if (caps.blob) {
    await blobDel(blobUrlFor(key), { token: env.BLOB_READ_WRITE_TOKEN });
    return;
  }
  if (s3) {
    await s3.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    return;
  }
  await fs.rm(safeLocalPath(key), { force: true });
}

export function publicUrl(key: string): string {
  if (caps.blob) return blobUrlFor(key);
  if (caps.s3 && env.CDN_BASE) return `${env.CDN_BASE.replace(/\/$/, '')}/${key}`;
  // Local driver (or S3 without a CDN configured): serve via the API's
  // /media route. Encode each path segment but keep the slashes.
  const encoded = key.split('/').map(encodeURIComponent).join('/');
  return `${env.API_BASE_URL.replace(/\/$/, '')}/media/${encoded}`;
}

// The absolute directory the /media static route serves from. Only meaningful
// for the local driver; exported so app.ts can wire the route.
export const LOCAL_STORAGE_ROOT = LOCAL_ROOT;

if (caps.blob) {
  logger.info({ base: env.BLOB_BASE_URL }, 'storage: using Vercel Blob driver');
} else if (!caps.s3) {
  logger.info({ dir: LOCAL_ROOT }, 'storage: using local filesystem driver (no S3 configured)');
}

export { s3 };
