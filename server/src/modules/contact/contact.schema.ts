import { z } from 'zod';

export const submitContactSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email(),
  subject: z.string().trim().max(150).optional(),
  message: z.string().trim().min(1).max(4000),
  // Honeypot field — real visitors never fill this in; bots that fill
  // every field will trip it. Silently accepted-but-dropped, not a 4xx,
  // so bots don't learn to detect the honeypot.
  company: z.string().max(200).optional()
});

export const listMessagesQuerySchema = z.object({
  status: z.enum(['NEW', 'READ', 'REPLIED', 'ARCHIVED']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).default(0)
});

export const updateStatusSchema = z.object({
  status: z.enum(['NEW', 'READ', 'REPLIED', 'ARCHIVED'])
});
