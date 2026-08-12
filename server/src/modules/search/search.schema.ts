import { z } from 'zod';

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  k: z.coerce.number().int().min(1).max(30).default(12)
});

export const similarParamsSchema = z.object({ id: z.string().uuid() });
