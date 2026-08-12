import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate';
import { requireAdmin } from '../../middleware/auth';
import { aiLimiter } from '../../middleware/rateLimit';
import {
  adminListPhotosQuerySchema,
  adminListUsersQuerySchema,
  updateUserRoleSchema,
  auditLogQuerySchema,
  reindexKnowledgeSchema,
  listSuggestionsQuerySchema,
  reviewSuggestionSchema
} from './admin.schema';
import {
  dashboardStatsHandler,
  adminListPhotosHandler,
  adminListUsersHandler,
  updateUserRoleHandler,
  auditLogsHandler,
  reindexKnowledgeHandler,
  listSuggestionsHandler,
  reviewSuggestionHandler,
  retryPhotoHandler,
  portfolioInsightsHandler
} from './admin.controller';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

const idParams = z.object({ id: z.string().uuid() });

adminRouter.get('/stats', dashboardStatsHandler);
adminRouter.get('/photos', validate({ query: adminListPhotosQuerySchema }), adminListPhotosHandler);
adminRouter.post('/photos/:id/retry', validate({ params: idParams }), retryPhotoHandler);
adminRouter.get('/users', validate({ query: adminListUsersQuerySchema }), adminListUsersHandler);
adminRouter.patch('/users/:id/role', validate({ params: idParams, body: updateUserRoleSchema }), updateUserRoleHandler);
adminRouter.get('/audit-logs', validate({ query: auditLogQuerySchema }), auditLogsHandler);
adminRouter.post('/knowledge/reindex', validate({ body: reindexKnowledgeSchema }), reindexKnowledgeHandler);

// Additive AI auto-organization: proposals only, approval required
// before anything is applied (see suggestions.service.ts).
adminRouter.get('/suggestions', validate({ query: listSuggestionsQuerySchema }), listSuggestionsHandler);
adminRouter.patch('/suggestions/:id', validate({ params: idParams, body: reviewSuggestionSchema }), reviewSuggestionHandler);

// Aggregated portfolio statistics + a cached AI-generated narrative
// summary (regenerated at most every 6h, or on demand with ?refresh=true).
adminRouter.get('/insights', aiLimiter, portfolioInsightsHandler);
