import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate';
import { apiLimiter } from '../../middleware/rateLimit';
import { asyncHandler } from '../../utils/asyncHandler';
import { getDiscoveryFeed, getCollection, listCollections } from './discovery.service';
import { getMapClusters, getPhotosAt } from './map.service';

export const discoveryRouter = Router();

const collectionParams = z.object({ slug: z.string().min(1).max(80) });
const collectionQuery = z.object({
  limit: z.coerce.number().int().min(1).max(120).default(60),
  offset: z.coerce.number().int().min(0).default(0)
});
const mapQuery = z.object({
  zoom: z.coerce.number().min(1).max(12).default(3),
  fromYear: z.coerce.number().int().optional(),
  toYear: z.coerce.number().int().optional()
});
const clusterBody = z.object({ photoIds: z.array(z.string().uuid()).min(1).max(60) });

// The Discovery feed — horizontal rows built from AI metadata.
discoveryRouter.get(
  '/',
  apiLimiter,
  asyncHandler(async (_req, res) => {
    const feed = await getDiscoveryFeed();
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300').json(feed);
  })
);

// Index of populated auto-collections.
discoveryRouter.get(
  '/collections',
  apiLimiter,
  asyncHandler(async (_req, res) => {
    res.json({ collections: await listCollections() });
  })
);

// Full contents of a single collection (Discovery rows are capped).
discoveryRouter.get(
  '/collections/:slug',
  apiLimiter,
  validate({ params: collectionParams, query: collectionQuery }),
  asyncHandler(async (req, res) => {
    const { limit, offset } = req.query as unknown as { limit: number; offset: number };
    res.json(await getCollection(req.params.slug, limit, offset));
  })
);

// GPS clusters for the photography map.
discoveryRouter.get(
  '/map',
  apiLimiter,
  validate({ query: mapQuery }),
  asyncHandler(async (req, res) => {
    const { zoom, fromYear, toYear } = req.query as unknown as { zoom: number; fromYear?: number; toYear?: number };
    res.set('Cache-Control', 'public, max-age=120, stale-while-revalidate=600').json(
      await getMapClusters(zoom, fromYear, toYear)
    );
  })
);

// Photos belonging to one map cluster.
discoveryRouter.post(
  '/map/photos',
  apiLimiter,
  validate({ body: clusterBody }),
  asyncHandler(async (req, res) => {
    res.json({ photos: await getPhotosAt(req.body.photoIds) });
  })
);
