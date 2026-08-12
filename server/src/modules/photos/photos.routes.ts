import { Router } from 'express';
import { validate } from '../../middleware/validate';
import { requireAdmin, optionalAuth } from '../../middleware/auth';
import { apiLimiter, aiLimiter } from '../../middleware/rateLimit';
import { listPhotosSchema, slugParamsSchema, idParamsSchema } from './photos.schema';
import {
  listPhotosHandler,
  getPhotoHandler,
  deletePhotoHandler,
  downloadPhotoHandler,
  critiquePhotoHandler
} from './photos.controller';

export const photosRouter = Router();

photosRouter.get('/', apiLimiter, validate({ query: listPhotosSchema }), listPhotosHandler);
photosRouter.get('/:slug', apiLimiter, validate({ params: slugParamsSchema }), getPhotoHandler);
photosRouter.delete('/:id', requireAdmin, validate({ params: idParamsSchema }), deletePhotoHandler);
photosRouter.post('/:id/download', apiLimiter, optionalAuth, validate({ params: idParamsSchema }), downloadPhotoHandler);
// Admin-only, on-demand — a second Claude call per invocation, so it's
// never triggered automatically (see critique.service.ts).
photosRouter.post('/:id/critique', requireAdmin, aiLimiter, validate({ params: idParamsSchema }), critiquePhotoHandler);
