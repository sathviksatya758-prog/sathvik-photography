/* ============================================================
   photoCard.ts — the one canonical "photo tile" projection
   ------------------------------------------------------------
   Discovery rows, recommendation rails and map panels all render
   the same tile, so they all serialise photos through here. Keeping
   a single definition means a field added for one surface is
   automatically available to the others, and the frontend only ever
   has to understand one shape.
   ============================================================ */

import { withMediaPublic } from './media';
import type { Photo, PhotoAi, PhotoColor } from '@prisma/client';

/** Prisma `include` that satisfies `toPhotoCard`. Spread into queries. */
export const PHOTO_CARD_INCLUDE = {
  ai: true,
  colors: { orderBy: { rank: 'asc' } }
} as const;

export type PhotoCardSource = Photo & {
  ai?: PhotoAi | null;
  colors?: PhotoColor[];
};

export interface PhotoCard {
  id: string;
  slug: string;
  lqip: string | null;
  aspect: number | null;
  width: number | null;
  height: number | null;
  featured: boolean;
  createdAt: Date;
  capturedAt: Date | null;
  urls: ReturnType<typeof withMediaPublic>['urls'];
  ai: {
    title: string | null;
    caption: string | null;
    shortCaption: string | null;
    altText: string | null;
    story: string | null;
    mood: string | null;
    genre: string | null;
  } | null;
  colors: { hex: string; share: number }[];
}

export function toPhotoCard(p: PhotoCardSource): PhotoCard {
  const media = withMediaPublic(p, p.ai ?? null);
  return {
    id: p.id,
    slug: p.slug,
    lqip: p.lqip,
    aspect: p.aspect,
    width: p.width,
    height: p.height,
    featured: p.featured,
    createdAt: p.createdAt,
    capturedAt: p.capturedAt,
    urls: media.urls,
    ai: p.ai
      ? {
          title: p.ai.title,
          caption: p.ai.caption,
          shortCaption: p.ai.shortCaption,
          altText: p.ai.altText,
          story: p.ai.story,
          mood: p.ai.mood,
          genre: p.ai.genre
        }
      : null,
    colors: (p.colors ?? []).slice(0, 4).map(c => ({ hex: c.hex, share: c.share }))
  };
}
