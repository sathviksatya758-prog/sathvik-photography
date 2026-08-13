import { asyncHandler } from '../../utils/asyncHandler';
import { AppError } from '../../lib/errors';
import * as photosService from './photos.service';
import { downloadQuerySchema } from './photos.schema';
import { recordEvent } from '../analytics/analytics.service';
import { getOrGenerateCritique } from './critique.service';
import { describePhoto } from './describe.service';

export const listPhotosHandler = asyncHandler(async (req, res) => {
  const { limit, cursor, category } = req.query as unknown as { limit: number; cursor?: string; category?: string };
  const result = await photosService.listPhotos({ limit, cursor, category });
  res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=120').json(result);
});

export const getPhotoHandler = asyncHandler(async (req, res) => {
  const { slug } = req.params;
  const result = await photosService.getPhotoBySlug(slug, req.headers.referer);
  recordEvent({ type: 'photo_view', photoId: result.photo.id, path: req.originalUrl, req }).catch(() => {});
  res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300').json(result);
});

export const deletePhotoHandler = asyncHandler(async (req, res) => {
  if (!req.user) throw AppError.unauthorized();
  await photosService.deletePhoto(req.params.id, req.user.sub);
  res.status(204).end();
});

export const downloadPhotoHandler = asyncHandler(async (req, res) => {
  const { format } = downloadQuerySchema.parse(req.query);
  const url = await photosService.recordDownload(req.params.id, format, {
    userId: req.user?.sub,
    ip: req.ip,
    userAgent: req.headers['user-agent']
  });
  recordEvent({ type: 'download', photoId: req.params.id, path: req.originalUrl, req }).catch(() => {});
  res.json({ url });
});

export const critiquePhotoHandler = asyncHandler(async (req, res) => {
  const critique = await getOrGenerateCritique(req.params.id, req.query.regenerate === 'true');
  res.json({ critique });
});

export const updatePhotoTitleHandler = asyncHandler(async (req, res) => {
  if (!req.user) throw AppError.unauthorized();
  const { title } = req.body as { title: string | null };
  const result = await photosService.updatePhotoTitle(req.params.id, title ?? null, req.user.sub);
  res.json(result);
});

export const describePhotoHandler = asyncHandler(async (req, res) => {
  const result = await describePhoto(req.params.id);
  res.json(result);
});
