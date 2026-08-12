import type { Request } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { AppError } from '../../lib/errors';
import * as uploadsService from './uploads.service';
import { z } from 'zod';

const paramsSchema = z.object({ id: z.string().uuid() });

export const uploadHandler = asyncHandler(async (req: Request, res) => {
  if (!req.file) throw AppError.badRequest('No file provided (multipart field name: "file")');
  if (!req.user) throw AppError.unauthorized();
  const result = await uploadsService.startUpload(
    { buffer: req.file.buffer, mimetype: req.file.mimetype, size: req.file.size, originalname: req.file.originalname },
    typeof req.body?.ownerNote === 'string' ? req.body.ownerNote : undefined,
    req.user.sub
  );
  res.status(202).json(result);
});

export const uploadStatusHandler = asyncHandler(async (req, res) => {
  const { id } = paramsSchema.parse(req.params);
  const photo = await uploadsService.getUploadStatus(id);
  res.json({ photo: { ...photo, bytes: photo.bytes?.toString() } });
});

export const retryUploadHandler = asyncHandler(async (req, res) => {
  if (!req.user) throw AppError.unauthorized();
  const { id } = paramsSchema.parse(req.params);
  await uploadsService.retryUpload(id, req.user.sub);
  res.status(202).json({ ok: true });
});
