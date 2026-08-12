import { z } from 'zod';

export const listPhotosSchema = z.object({
  limit: z.coerce.number().int().min(1).max(60).default(24),
  cursor: z.string().datetime().optional(),
  category: z.string().max(60).optional()
});

export const slugParamsSchema = z.object({ slug: z.string().min(1) });
export const idParamsSchema = z.object({ id: z.string().uuid() });

export const downloadQuerySchema = z.object({
  format: z.enum(['avif', 'webp', 'jpeg']).default('jpeg'),
  width: z.coerce.number().int().optional()
});
