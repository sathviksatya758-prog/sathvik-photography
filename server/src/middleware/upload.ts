import multer from 'multer';
import { env } from '../config/env';
import { AppError } from '../lib/errors';

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/tiff']);

export const uploadSingleImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      cb(AppError.badRequest(`Unsupported file type: ${file.mimetype}`) as unknown as Error);
      return;
    }
    cb(null, true);
  }
}).single('file');
