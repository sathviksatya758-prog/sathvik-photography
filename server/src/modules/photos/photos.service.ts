import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { cached, cacheDel } from '../../lib/redis';
import { recordAudit } from '../admin/audit.service';
import { renditionUrl, withMediaPublic, groupTerms } from '../../lib/media';

export async function listPhotos(opts: { limit: number; cursor?: string; category?: string }) {
  const cacheKey = `photos:list:${opts.limit}:${opts.cursor ?? ''}:${opts.category ?? ''}`;
  return cached(cacheKey, 45, async () => {
    const photos = await prisma.photo.findMany({
      where: {
        deletedAt: null,
        status: 'READY',
        ...(opts.cursor ? { createdAt: { lt: new Date(opts.cursor) } } : {}),
        ...(opts.category ? { terms: { some: { kind: 'category', value: opts.category.toLowerCase() } } } : {})
      },
      include: { ai: true, terms: true, exif: true, colors: { orderBy: { rank: 'asc' } } },
      orderBy: { createdAt: 'desc' },
      take: opts.limit
    });

    return {
      // exif/colors are attached below, not through withMediaPublic, since
      // that helper is also used for related/search results that only
      // need ai + media urls.
      photos: photos.map(p => ({ ...withMediaPublic(p, p.ai), exif: p.exif, colors: p.colors, terms: groupTerms(p.terms) })),
      nextCursor: photos.length === opts.limit ? photos[photos.length - 1]!.createdAt.toISOString() : null
    };
  });
}

export async function getPhotoBySlug(slug: string, referrer?: string) {
  const photo = await prisma.photo.findFirst({
    where: { slug, deletedAt: null },
    include: { ai: true, exif: true, colors: { orderBy: { rank: 'asc' } }, terms: true, renditions: true }
  });
  if (!photo) throw AppError.notFound('Photo not found');

  const related = await prisma.$queryRaw<{ photo_id: string; score: number }[]>`
    SELECT * FROM similar_photos(${photo.id}::uuid, 6)
  `.catch(() => []);

  const relatedPhotos = related.length
    ? await prisma.photo.findMany({
        where: { id: { in: related.map(r => r.photo_id) }, deletedAt: null },
        include: { ai: true, exif: true, colors: { orderBy: { rank: 'asc' } } }
      })
    : [];

  // Fire-and-forget view tracking — must never fail the read request.
  prisma.photoView.create({ data: { photoId: photo.id, referrer } }).catch(() => {});

  return {
    photo: { ...withMediaPublic(photo, photo.ai), exif: photo.exif, colors: photo.colors, terms: groupTerms(photo.terms) },
    related: relatedPhotos
      .sort((a, b) => related.findIndex(r => r.photo_id === a.id) - related.findIndex(r => r.photo_id === b.id))
      .map(p => ({ ...withMediaPublic(p, p.ai), exif: p.exif, colors: p.colors }))
  };
}

export async function deletePhoto(id: string, actorId: string): Promise<void> {
  const photo = await prisma.photo.findUnique({ where: { id } });
  if (!photo || photo.deletedAt) throw AppError.notFound('Photo not found');

  await prisma.photo.update({ where: { id }, data: { deletedAt: new Date(), status: 'HIDDEN' } });
  await recordAudit({ actorId, action: 'photo.delete', targetType: 'photo', targetId: id });
  await cacheDel('photos:list:*');
  await cacheDel(`photo:${id}`);
  await cacheDel('search:q:*');
  await cacheDel('discovery:*');
  await cacheDel('recs:*');
}

export async function recordDownload(
  photoId: string,
  rendition: string,
  meta: { userId?: string; ip?: string; userAgent?: string }
) {
  const photo = await prisma.photo.findFirst({ where: { id: photoId, deletedAt: null } });
  if (!photo) throw AppError.notFound('Photo not found');

  await prisma.download.create({
    data: { photoId, rendition, userId: meta.userId, ip: meta.ip, userAgent: meta.userAgent }
  });

  return renditionUrl(photo.slug, 'jpeg', 2048);
}
