import { Router } from 'express';
import { validate } from '../../middleware/validate';
import { requireAdmin } from '../../middleware/auth';
import { apiLimiter } from '../../middleware/rateLimit';
import { trackEventSchema, summaryQuerySchema } from './analytics.schema';
import { trackEventHandler, analyticsSummaryHandler } from './analytics.controller';

export const analyticsRouter = Router();

analyticsRouter.post('/event', apiLimiter, validate({ body: trackEventSchema }), trackEventHandler);
analyticsRouter.get('/summary', requireAdmin, validate({ query: summaryQuerySchema }), analyticsSummaryHandler);
