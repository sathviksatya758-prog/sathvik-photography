import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { putObject } from '../../lib/storage';
import { readExif, extractPalette, quickPreview } from '../../lib/imagePipeline';
import { uniqueSlug } from '../../utils/slug';
import { enqueueImageJob } from '../../lib/queue';
import { cacheDel } from '../../lib/redis';
import { recordAudit } from '../admin/audit.service';
import { withMediaPublic, groupTerms } from '../../lib/media';

export async function startUpload(
  file: { buffer: Buffer; mimetype: string; size: number; originalname: string },
  ownerNote: string | undefined,
  actorId: string
) {
  if (!file.size) throw AppError.badRequest('Empty file');

  const [exif, preview, palette] = await Promise.all([
    readExif(file.buffer),
    quickPreview(file.buffer),
    extractPalette(file.buffer)
  ]);

  const slug = uniqueSlug(file.originalname.replace(/\.[a-z0-9]+$/i, '') || 'frame');
  const storageKey = `originals/${slug}`;
  await putObject(storageKey, file.buffer, file.mimetype);

  const photo = await prisma.$transaction(async tx => {
    const created = await tx.photo.create({
      data: {
        slug,
        storageKey,
        mime: file.mimetype,
        bytes: BigInt(file.size),
        width: preview.width,
        height: preview.height,
        aspect: preview.aspect,
        lqip: preview.lqip,
        status: 'PROCESSING',
        ownerNote,
        capturedAt: exif?.taken_at ?? null
      }
    });

    if (exif) {
      await tx.photoExif.create({
        data: {
          photoId: created.id,
          make: exif.make,
          model: exif.model,
          lens: exif.lens,
          focalMm: exif.focal_mm,
          focal35mm: exif.focal_35mm,
          aperture: exif.aperture,
          shutterSec: exif.shutter_sec,
          iso: exif.iso,
          exposureBias: exif.exposure_bias,
          flash: exif.flash,
          whiteBalance: exif.white_balance,
          software: exif.software,
          takenAt: exif.taken_at,
          gpsLat: exif.gps_lat,
          gpsLon: exif.gps_lon,
          raw: exif.raw as never
        }
      });
    }

    if (palette.length) {
      await tx.photoColor.createMany({
        data: palette.map((c, i) => ({ photoId: created.id, hex: c.hex, r: c.r, g: c.g, b: c.b, share: c.share, rank: i }))
      });
    }

    return created;
  });

  await enqueueImageJob({ photoId: photo.id, storageKey, mime: file.mimetype, bytes: file.size, ownerNote });
  await recordAudit({ actorId, action: 'photo.upload', targetType: 'photo', targetId: photo.id });
  await cacheDel('photos:list:*');

  return { id: photo.id, slug: photo.slug, status: photo.status, lqip: photo.lqip, exif, palette };
}

export async function getUploadStatus(photoId: string) {
  const photo = await prisma.photo.findUnique({
    where: { id: photoId },
    include: { ai: true, exif: true, colors: { orderBy: { rank: 'asc' } }, terms: true }
  });
  if (!photo) throw AppError.notFound('Photo not found');
  return { ...withMediaPublic(photo, photo.ai), exif: photo.exif, colors: photo.colors, terms: groupTerms(photo.terms) };
}

// Re-enqueues the background AI/rendition job for a photo stuck in
// FAILED (e.g. a transient Claude/OpenAI outage exhausted BullMQ's 3
// automatic retries). Admin-triggered, not automatic.
export async function retryUpload(photoId: string, actorId: string): Promise<void> {
  const photo = await prisma.photo.findUnique({ where: { id: photoId } });
  if (!photo) throw AppError.notFound('Photo not found');
  if (photo.status !== 'FAILED') throw AppError.badRequest('Only failed photos can be retried');

  await prisma.photo.update({ where: { id: photoId }, data: { status: 'PROCESSING' } });
  await enqueueImageJob({ photoId, storageKey: photo.storageKey, mime: photo.mime ?? 'image/jpeg', bytes: Number(photo.bytes ?? 0) });
  await recordAudit({ actorId, action: 'photo.retry', targetType: 'photo', targetId: photoId });
  await cacheDel('photos:list:*');
}
