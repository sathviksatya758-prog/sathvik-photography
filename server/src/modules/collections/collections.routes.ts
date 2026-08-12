import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, optionalAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { apiLimiter, authLimiter } from '../../middleware/rateLimit';
import { asyncHandler } from '../../utils/asyncHandler';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { env } from '../../config/env';
import { createShareLink, revokeShareLink, getSharedGallery, unlockGallery } from './galleries.service';

export const collectionsRouter = Router();

const idParams = z.object({ id: z.string().uuid() });
const collectionPhotoParams = z.object({ id: z.string().uuid(), photoId: z.string().uuid() });
const createSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  isPublic: z.boolean().default(false),
  kind: z.enum(['COLLECTION', 'ALBUM', 'PROJECT', 'STORY', 'JOURNAL', 'SEASONAL']).optional()
});
const addPhotoSchema = z.object({ photoId: z.string().uuid() });

async function loadOwnedCollection(id: string, userId: string) {
  const collection = await prisma.collection.findUnique({ where: { id } });
  if (!collection) throw AppError.notFound('Collection not found');
  if (collection.userId !== userId) throw AppError.forbidden();
  return collection;
}

collectionsRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await prisma.collection.findMany({
      where: { userId: req.user!.sub },
      include: { _count: { select: { photos: true } } },
      orderBy: { updatedAt: 'desc' }
    });
    // Never ship the Argon2 password hash to the client — the management
    // UI only needs to know *whether* a password is set.
    const collections = rows.map(({ passwordHash, ...c }) => ({
      ...c,
      hasPassword: !!passwordHash,
      photoCount: c._count.photos
    }));
    res.json({ collections });
  })
);

collectionsRouter.post(
  '/',
  requireAuth,
  validate({ body: createSchema }),
  asyncHandler(async (req, res) => {
    const collection = await prisma.collection.create({ data: { ...req.body, userId: req.user!.sub } }).catch(() => {
      throw AppError.conflict('You already have a collection with that name');
    });
    res.status(201).json({ collection });
  })
);

collectionsRouter.get(
  '/:id',
  optionalAuth,
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const collection = await prisma.collection.findUnique({
      where: { id: req.params.id },
      include: { photos: { include: { photo: { include: { ai: true } } }, orderBy: { addedAt: 'desc' } } }
    });
    if (!collection) throw AppError.notFound('Collection not found');
    if (!collection.isPublic && collection.userId !== req.user?.sub) throw AppError.forbidden();
    res.json({ collection });
  })
);

collectionsRouter.delete(
  '/:id',
  requireAuth,
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    await loadOwnedCollection(req.params.id, req.user!.sub);
    await prisma.collection.delete({ where: { id: req.params.id } });
    res.status(204).end();
  })
);

collectionsRouter.post(
  '/:id/photos',
  requireAuth,
  validate({ params: idParams, body: addPhotoSchema }),
  asyncHandler(async (req, res) => {
    await loadOwnedCollection(req.params.id, req.user!.sub);
    await prisma.collectionPhoto.upsert({
      where: { collectionId_photoId: { collectionId: req.params.id, photoId: req.body.photoId } },
      create: { collectionId: req.params.id, photoId: req.body.photoId },
      update: {}
    });
    await prisma.collection.update({ where: { id: req.params.id }, data: { updatedAt: new Date() } });
    res.status(204).end();
  })
);

collectionsRouter.delete(
  '/:id/photos/:photoId',
  requireAuth,
  validate({ params: collectionPhotoParams }),
  asyncHandler(async (req, res) => {
    await loadOwnedCollection(req.params.id, req.user!.sub);
    await prisma.collectionPhoto
      .delete({ where: { collectionId_photoId: { collectionId: req.params.id, photoId: req.params.photoId } } })
      .catch(() => {});
    res.status(204).end();
  })
);

/* ============================================================
   Client galleries — shareable, optionally password-protected,
   optionally expiring deliveries of a curated collection.
   See galleries.service.ts for the access rules.
   ============================================================ */

const shareBody = z.object({
  password: z.string().min(4).max(128).optional(),
  expiresAt: z.string().datetime().optional(),
  allowDownload: z.boolean().optional(),
  watermark: z.boolean().optional()
});
const shareSlugParams = z.object({ shareSlug: z.string().min(6).max(64) });
const unlockBody = z.object({ password: z.string().min(1).max(128) });

// Owner: mint or update a share link for one of their collections.
collectionsRouter.post(
  '/:id/share',
  requireAuth,
  validate({ params: idParams, body: shareBody }),
  asyncHandler(async (req, res) => {
    res.json(await createShareLink(req.params.id, req.user!.sub, req.body));
  })
);

// Owner: revoke the link (and any password) entirely.
collectionsRouter.delete(
  '/:id/share',
  requireAuth,
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    await revokeShareLink(req.params.id, req.user!.sub);
    res.status(204).end();
  })
);

// Public: read a shared gallery. Returns {locked:true} without photos
// when a password is set and the visitor hasn't unlocked it yet.
collectionsRouter.get(
  '/shared/:shareSlug',
  apiLimiter,
  validate({ params: shareSlugParams }),
  asyncHandler(async (req, res) => {
    const token = req.cookies?.[`gallery_${req.params.shareSlug}`];
    res.json(await getSharedGallery(req.params.shareSlug, token));
  })
);

// Public: exchange the gallery password for a scoped, 12h unlock cookie.
collectionsRouter.post(
  '/shared/:shareSlug/unlock',
  authLimiter,
  validate({ params: shareSlugParams, body: unlockBody }),
  asyncHandler(async (req, res) => {
    const { token } = await unlockGallery(req.params.shareSlug, req.body.password);
    res.cookie(`gallery_${req.params.shareSlug}`, token, {
      httpOnly: true,
      secure: env.COOKIE_SECURE,
      sameSite: 'lax',
      domain: env.COOKIE_DOMAIN,
      path: '/',
      maxAge: 12 * 3600 * 1000
    });
    res.json({ ok: true });
  })
);
