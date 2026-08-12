import { publicUrl } from './storage';
import { RENDITION_WIDTHS } from './imagePipeline';
import type { Photo, PhotoAi, PhotoTerm } from '@prisma/client';

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
  return {
    ...photo,
    ai: ai ?? undefined,
    urls: {
      original: originalUrl(photo.storageKey),
      lqip: photo.lqip,
      avif: srcSet(photo.slug, 'avif'),
      webp: srcSet(photo.slug, 'webp'),
      jpeg: srcSet(photo.slug, 'jpeg')
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
