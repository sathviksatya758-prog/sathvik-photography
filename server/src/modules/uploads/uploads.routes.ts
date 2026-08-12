import { Router } from 'express';
import { requireAdmin } from '../../middleware/auth';
import { uploadLimiter } from '../../middleware/rateLimit';
import { uploadSingleImage } from '../../middleware/upload';
import { uploadHandler, uploadStatusHandler, retryUploadHandler } from './uploads.controller';

export const uploadsRouter = Router();

// Owner-only, matching the existing frontend's owner-gated Upload page —
// now enforced server-side via a signed JWT role claim instead of a
// client-side flag that any visitor could spoof.
uploadsRouter.post('/', requireAdmin, uploadLimiter, uploadSingleImage, uploadHandler);
uploadsRouter.get('/:id/status', requireAdmin, uploadStatusHandler);
uploadsRouter.post('/:id/retry', requireAdmin, uploadLimiter, retryUploadHandler);
