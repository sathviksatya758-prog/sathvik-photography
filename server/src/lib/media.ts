import { publicUrl } from './storage';
import { RENDITION_WIDTHS } from './imagePipeline';
import type { Photo, PhotoAi, PhotoTerm } from '@prisma/client';

// Which rendition widths actually exist on disk for a photo of the given
// original width. MUST mirror buildRenditions() in imagePipeline.ts: it only
// generates widths <= the original (withoutEnlargement), falling back to the
// original's own width when it's smaller than the smallest breakpoint.
// Advertising a width that was never generated (e.g. 2048 for a 1600px upload)
// produces srcset/download URLs that 404 — which is exactly what broke the
// hero image, since the client picks the largest advertised width as its src.
export function availableWidths(width?: number | null): number[] {
  const w = width ?? 0;
  const targets = RENDITION_WIDTHS.filter(x => x <= w);
  return targets.length ? targets : [w || RENDITION_WIDTHS[0]];
}

export function srcSet(slug: string, format: 'avif' | 'webp' | 'jpeg', widths: readonly number[] = RENDITION_WIDTHS): string {
  return widths.map(w => `${publicUrl(`renditions/${slug}/${w}.${format}`)} ${w}w`).join(', ');
}

export function renditionUrl(slug: string, format: 'avif' | 'webp' | 'jpeg', width: number): string {
  return publicUrl(`renditions/${slug}/${width}.${format}`);
}

export function originalUrl(storageKey: string): string {
  return publicUrl(storageKey);
}

// Attaches CDN URLs (responsive srcsets + original) to a photo row.
// Shared by photos/search/chat/uploads so every endpoint returns
// images in the same shape.
export function withMediaPublic<T extends Photo>(photo: T, ai?: PhotoAi | null) {
  const widths = availableWidths(photo.width);
  return {
    ...photo,
    ai: ai ?? undefined,
    urls: {
      original: originalUrl(photo.storageKey),
      lqip: photo.lqip,
      avif: srcSet(photo.slug, 'avif', widths),
      webp: srcSet(photo.slug, 'webp', widths),
      jpeg: srcSet(photo.slug, 'jpeg', widths)
    }
  };
}

// Flattens the one-row-per-(kind,value) PhotoTerm rows into the
// {tags,categories,...} shape every consumer (gallery cards, the
// frontend adapter in index.html) expects.
export function groupTerms(terms: PhotoTerm[]) {
  const by = (kind: string) => terms.filter(t => t.kind === kind).map(t => t.value);
  return {
    tags: by('tag'),
    categories: by('category'),
    collections: by('collection'),
    seoKeywords: by('seo'),
    hashtags: by('hashtag')
  };
}
