import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { withMediaPublic, groupTerms } from '../../lib/media';

const HERO_KEY = 'hero_photo_id';

/** The owner-chosen homepage hero/intro photo, serialized like a list item —
 *  or null when unset or the chosen photo is gone. Public. */
export async function getHeroPhoto() {
  const setting = await prisma.siteSetting.findUnique({ where: { key: HERO_KEY } });
  if (!setting) return null;
  const photo = await prisma.photo.findFirst({
    where: { id: setting.value, deletedAt: null, status: 'READY' },
    include: { ai: true, exif: true, colors: { orderBy: { rank: 'asc' } }, terms: true }
  });
  if (!photo) return null; // chosen photo was deleted/hidden — fall back on the client
  return { ...withMediaPublic(photo, photo.ai), exif: photo.exif, colors: photo.colors, terms: groupTerms(photo.terms) };
}

/** Set the hero to an existing, visible photo. Owner only. */
export async function setHeroPhoto(photoId: string): Promise<void> {
  const photo = await prisma.photo.findFirst({ where: { id: photoId, deletedAt: null, status: 'READY' } });
  if (!photo) throw AppError.badRequest('Choose a photo that has finished processing');
  await prisma.siteSetting.upsert({
    where: { key: HERO_KEY },
    create: { key: HERO_KEY, value: photoId },
    update: { value: photoId }
  });
}

/** Clear the hero selection (reverts to the automatic latest-photo behaviour). */
export async function clearHeroPhoto(): Promise<void> {
  await prisma.siteSetting.deleteMany({ where: { key: HERO_KEY } });
}
