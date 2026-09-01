import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate';
import { apiLimiter } from '../../middleware/rateLimit';
import { asyncHandler } from '../../utils/asyncHandler';
import { getDiscoveryFeed, getCollection, listCollections } from './discovery.service';

export const discoveryRouter = Router();

const collectionParams = z.object({ slug: z.string().min(1).max(80) });
const collectionQuery = z.object({
  limit: z.coerce.number().int().min(1).max(120).default(60),
  offset: z.coerce.number().int().min(0).default(0)
});

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
