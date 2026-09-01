// One-off migration: uploads made during local dev live under
// server/storage/ (originals/<slug>, renditions/<slug>/<width>.<format>).
// That directory is gitignored and never leaves this machine, so once the
// backend runs on Vercel (no writable local disk) those files need to exist
// in the Vercel Blob store instead, under the exact same keys — the DB rows
// already reference these keys via storageKey / slug, so no DB changes are
// needed, just getting the bytes to Blob.
//
// Run once, locally, against production Blob credentials:
//   BLOB_READ_WRITE_TOKEN=... tsx scripts/migrate-storage-to-blob.ts
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { put } from '@vercel/blob';

const STORAGE_ROOT = path.resolve(__dirname, '..', 'storage');

const EXT_TO_MIME: Record<string, string> = {
  '.avif': 'image/avif',
  '.webp': 'image/webp',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.tiff': 'image/tiff'
};

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

async function main() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error('Set BLOB_READ_WRITE_TOKEN before running this script');

  const stats = await stat(STORAGE_ROOT).catch(() => null);
  if (!stats) {
    console.log('No local storage/ directory found — nothing to migrate.');
    return;
  }

  let count = 0;
  for await (const file of walk(STORAGE_ROOT)) {
    const key = path.relative(STORAGE_ROOT, file).split(path.sep).join('/');
    const ext = path.extname(file).toLowerCase();
    const contentType = EXT_TO_MIME[ext] || 'application/octet-stream';
    const buffer = await readFile(file);
    await put(key, buffer, { access: 'public', contentType, addRandomSuffix: false, allowOverwrite: true, token });
    count++;
    console.log(`uploaded: ${key} (${buffer.length} bytes)`);
  }
  console.log(`Done — migrated ${count} file(s) to Vercel Blob.`);
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
