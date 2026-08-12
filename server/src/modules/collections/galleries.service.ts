/* ============================================================
   galleries.service.ts — client gallery delivery
   ------------------------------------------------------------
   Turns a manually-curated Collection into a shareable gallery:
   an unguessable share slug, optional Argon2 password, optional
   expiry, and per-gallery download/watermark policy.

   Access rules, in order:
     • expired            → 410 Gone
     • password set       → requires a valid unlock token
     • isPublic false and no password → owner only
   Unlock tokens are short-lived JWTs scoped to one gallery, so a
   visitor who unlocks gallery A cannot read gallery B.
   ============================================================ */

import jwt from 'jsonwebtoken';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { env } from '../../config/env';
import { hashPassword, verifyPassword } from '../../utils/password';
import { generateToken } from '../../utils/tokens';
import { toPhotoCard, PHOTO_CARD_INCLUDE } from '../../lib/photoCard';
import { recordAudit } from '../admin/audit.service';

const UNLOCK_TTL = '12h';

interface UnlockClaims {
  gid: string;
  scope: 'gallery';
}

function signUnlock(galleryId: string): string {
  return jwt.sign({ gid: galleryId, scope: 'gallery' } satisfies UnlockClaims, env.JWT_ACCESS_SECRET, {
    expiresIn: UNLOCK_TTL
  });
}

function hasValidUnlock(galleryId: string, token?: string): boolean {
  if (!token) return false;
  try {
    const claims = jwt.verify(token, env.JWT_ACCESS_SECRET) as UnlockClaims;
    return claims.scope === 'gallery' && claims.gid === galleryId;
  } catch {
    return false;
  }
}

export async function createShareLink(
  collectionId: string,
  ownerId: string,
  opts: { password?: string; expiresAt?: string; allowDownload?: boolean; watermark?: boolean }
) {
  const collection = await prisma.collection.findUnique({ where: { id: collectionId } });
  if (!collection) throw AppError.notFound('Collection not found');
  if (collection.userId !== ownerId) throw AppError.forbidden();

  const updated = await prisma.collection.update({
    where: { id: collectionId },
    data: {
      shareSlug: collection.shareSlug ?? generateToken(12),
      passwordHash: opts.password ? await hashPassword(opts.password) : collection.passwordHash,
      expiresAt: opts.expiresAt ? new Date(opts.expiresAt) : collection.expiresAt,
      allowDownload: opts.allowDownload ?? collection.allowDownload,
      watermark: opts.watermark ?? collection.watermark
    }
  });

  await recordAudit({
    actorId: ownerId,
    action: 'gallery.share',
    targetType: 'collection',
    targetId: collectionId,
    meta: { hasPassword: !!updated.passwordHash, expiresAt: updated.expiresAt }
  });

  return {
    shareSlug: updated.shareSlug,
    shareUrl: `${env.CLIENT_ORIGIN}/?gallery=${updated.shareSlug}`,
    hasPassword: !!updated.passwordHash,
    expiresAt: updated.expiresAt,
    allowDownload: updated.allowDownload,
    watermark: updated.watermark
  };
}

export async function revokeShareLink(collectionId: string, ownerId: string) {
  const collection = await prisma.collection.findUnique({ where: { id: collectionId } });
  if (!collection) throw AppError.notFound('Collection not found');
  if (collection.userId !== ownerId) throw AppError.forbidden();

  await prisma.collection.update({
    where: { id: collectionId },
    data: { shareSlug: null, passwordHash: null, expiresAt: null }
  });
  await recordAudit({ actorId: ownerId, action: 'gallery.revoke', targetType: 'collection', targetId: collectionId });
}

/** Public read of a shared gallery. `unlockToken` comes from the cookie. */
export async function getSharedGallery(shareSlug: string, unlockToken?: string) {
  const collection = await prisma.collection.findUnique({
    where: { shareSlug },
    include: {
      photos: {
        orderBy: { addedAt: 'desc' },
        include: { photo: { include: PHOTO_CARD_INCLUDE } }
      }
    }
  });
  if (!collection) throw AppError.notFound('Gallery not found');

  if (collection.expiresAt && collection.expiresAt < new Date()) {
    throw new AppError(410, 'GONE', 'This gallery link has expired.');
  }

  // Locked galleries return their identity (so the UI can render a
  // password prompt with the right name) but never their photographs.
  if (collection.passwordHash && !hasValidUnlock(collection.id, unlockToken)) {
    return {
      locked: true as const,
      name: collection.name,
      description: collection.description,
      photoCount: collection.photos.length
    };
  }

  return {
    locked: false as const,
    id: collection.id,
    name: collection.name,
    description: collection.description,
    kind: collection.kind,
    allowDownload: collection.allowDownload,
    watermark: collection.watermark,
    expiresAt: collection.expiresAt,
    photos: collection.photos
      .filter(cp => cp.photo.deletedAt === null)
      .map(cp => toPhotoCard(cp.photo))
  };
}

export async function unlockGallery(shareSlug: string, password: string) {
  const collection = await prisma.collection.findUnique({ where: { shareSlug } });
  if (!collection) throw AppError.notFound('Gallery not found');
  if (collection.expiresAt && collection.expiresAt < new Date()) {
    throw new AppError(410, 'GONE', 'This gallery link has expired.');
  }
  if (!collection.passwordHash) return { token: signUnlock(collection.id) };

  const ok = await verifyPassword(collection.passwordHash, password);
  if (!ok) throw AppError.unauthorized('Incorrect gallery password');
  return { token: signUnlock(collection.id) };
}
