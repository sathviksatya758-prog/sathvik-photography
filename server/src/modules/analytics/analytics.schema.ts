import { z } from 'zod';

export const trackEventSchema = z.object({
  type: z.string().min(1).max(40),
  path: z.string().max(500).optional(),
  photoId: z.string().uuid().optional(),
  meta: z.record(z.unknown()).optional()
});

export const summaryQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30)
});
