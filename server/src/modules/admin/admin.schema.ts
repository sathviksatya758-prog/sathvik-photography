import { z } from 'zod';

export const adminListPhotosQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['PROCESSING', 'READY', 'FAILED', 'HIDDEN']).optional()
});

export const adminListUsersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).default(0)
});

export const updateUserRoleSchema = z.object({
  role: z.enum(['USER', 'ADMIN'])
});

export const auditLogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

export const reindexKnowledgeSchema = z.object({
  entries: z
    .array(z.object({ kind: z.enum(['bio', 'faq', 'press', 'service']), title: z.string().min(1), body: z.string().min(1) }))
    .min(1)
});

export const listSuggestionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
  kind: z.enum(['FEATURED', 'DUPLICATE', 'SIMILAR_GROUP', 'COLLECTION']).optional()
});

export const reviewSuggestionSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED'])
});
