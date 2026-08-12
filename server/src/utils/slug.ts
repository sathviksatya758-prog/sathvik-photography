import crypto from 'node:crypto';

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'frame';
}

export function uniqueSlug(base: string): string {
  return `${slugify(base)}-${crypto.randomBytes(3).toString('hex')}`;
}
