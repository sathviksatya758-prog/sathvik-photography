import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';

export const favoritesRouter = Router();
const photoIdParams = z.object({ photoId: z.string().uuid() });

favoritesRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const favorites = await prisma.favorite.findMany({
      where: { userId: req.user!.sub },
      include: { photo: { include: { ai: true } } },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ favorites: favorites.map(f => ({ addedAt: f.createdAt, photo: f.photo })) });
  })
);

favoritesRouter.put(
  '/:photoId',
  requireAuth,
  validate({ params: photoIdParams }),
  asyncHandler(async (req, res) => {
    const photo = await prisma.photo.findFirst({ where: { id: req.params.photoId, deletedAt: null } });
    if (!photo) throw AppError.notFound('Photo not found');
    await prisma.favorite.upsert({
      where: { userId_photoId: { userId: req.user!.sub, photoId: req.params.photoId } },
      create: { userId: req.user!.sub, photoId: req.params.photoId },
      update: {}
    });
    res.status(204).end();
  })
);

favoritesRouter.delete(
  '/:photoId',
  requireAuth,
  validate({ params: photoIdParams }),
  asyncHandler(async (req, res) => {
    await prisma.favorite
      .delete({ where: { userId_photoId: { userId: req.user!.sub, photoId: req.params.photoId } } })
      .catch(() => {});
    res.status(204).end();
  })
);
