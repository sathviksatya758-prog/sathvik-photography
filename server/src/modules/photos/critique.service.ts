import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { getObject } from '../../lib/storage';
import { buildAiPreview } from '../../lib/imagePipeline';
import { critiquePhoto } from '../uploads/ai.service';
import { env } from '../../config/env';

// On-demand only — see PhotoCritique in schema.prisma for why this isn't
// generated automatically on upload. Cached in the DB; pass
// `regenerate: true` to force a fresh call.
export async function getOrGenerateCritique(photoId: string, regenerate = false) {
  const photo = await prisma.photo.findFirst({
    where: { id: photoId, deletedAt: null },
    include: { exif: true, critique: true }
  });
  if (!photo) throw AppError.notFound('Photo not found');
  if (photo.status !== 'READY') throw AppError.badRequest('Photo is still processing');

  if (photo.critique && !regenerate) return photo.critique;

  const original = await getObject(photo.storageKey);
  const preview = await buildAiPreview(original);
  const exif = photo.exif;

  const result = await critiquePhoto(
    preview.toString('base64'),
    'image/jpeg',
    exif && {
      make: exif.make,
      model: exif.model,
      lens: exif.lens,
      focal_mm: exif.focalMm,
      focal_35mm: exif.focal35mm,
      aperture: exif.aperture,
      shutter_sec: exif.shutterSec,
      iso: exif.iso,
      exposure_bias: exif.exposureBias,
      flash: exif.flash,
      white_balance: exif.whiteBalance,
      software: exif.software,
      taken_at: exif.takenAt,
      gps_lat: exif.gpsLat,
      gps_lon: exif.gpsLon,
      raw: exif.raw
    }
  );

  return prisma.photoCritique.upsert({
    where: { photoId },
    create: { photoId, ...result, modelVersion: env.ANTHROPIC_MODEL },
    update: { ...result, modelVersion: env.ANTHROPIC_MODEL, generatedAt: new Date() }
  });
}
