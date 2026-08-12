import { z } from 'zod';

export const askSchema = z.object({
  message: z.string().trim().min(1).max(600),
  sessionId: z.string().uuid().optional()
});
