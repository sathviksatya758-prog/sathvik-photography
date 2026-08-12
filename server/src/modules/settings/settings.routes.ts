import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { getHeroPhoto, setHeroPhoto, clearHeroPhoto } from './settings.service';

export const settingsRouter = Router();

// Public: which photo (if any) the owner picked as the homepage hero/intro.
settingsRouter.get(
  '/hero',
  asyncHandler(async (_req, res) => {
    res.json({ hero: await getHeroPhoto() });
  })
);

// Owner only: set / clear the hero photo.
settingsRouter.put(
  '/hero',
  requireAdmin,
  validate({ body: z.object({ photoId: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    await setHeroPhoto(req.body.photoId);
    res.json({ hero: await getHeroPhoto() });
  })
);

settingsRouter.delete(
  '/hero',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    await clearHeroPhoto();
    res.status(204).end();
  })
);
