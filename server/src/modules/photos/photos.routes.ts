import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate';
import { requireAdmin, optionalAuth } from '../../middleware/auth';
import { apiLimiter, aiLimiter } from '../../middleware/rateLimit';
import { listPhotosSchema, slugParamsSchema, idParamsSchema } from './photos.schema';
import {
  listPhotosHandler,
  getPhotoHandler,
  deletePhotoHandler,
  downloadPhotoHandler,
  critiquePhotoHandler,
  updatePhotoTitleHandler,
  describePhotoHandler
} from './photos.controller';

export const photosRouter = Router();

const titleBodySchema = z.object({ title: z.string().max(160).nullable().optional() });

photosRouter.get('/', apiLimiter, validate({ query: listPhotosSchema }), listPhotosHandler);
// On-demand AI/metadata description — public, before the catch-all /:slug.
photosRouter.get('/:id/describe', aiLimiter, validate({ params: idParamsSchema }), describePhotoHandler);
photosRouter.get('/:slug', apiLimiter, validate({ params: slugParamsSchema }), getPhotoHandler);
photosRouter.delete('/:id', requireAdmin, validate({ params: idParamsSchema }), deletePhotoHandler);
// Owner sets/clears a photo's display title.
photosRouter.patch('/:id', requireAdmin, validate({ params: idParamsSchema, body: titleBodySchema }), updatePhotoTitleHandler);
photosRouter.post('/:id/download', apiLimiter, optionalAuth, validate({ params: idParamsSchema }), downloadPhotoHandler);
// Admin-only, on-demand — a second Claude call per invocation, so it's
// never triggered automatically (see critique.service.ts).
photosRouter.post('/:id/critique', requireAdmin, aiLimiter, validate({ params: idParamsSchema }), critiquePhotoHandler);
