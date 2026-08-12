import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate';
import { apiLimiter } from '../../middleware/rateLimit';
import { asyncHandler } from '../../utils/asyncHandler';
import { getRecommendations } from './recommendations.service';

export const recommendationsRouter = Router();

const idParams = z.object({ id: z.string().uuid() });

// Every "keep exploring" rail for one photograph, in display order.
recommendationsRouter.get(
  '/:id',
  apiLimiter,
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const result = await getRecommendations(req.params.id);
    res.set('Cache-Control', 'public, max-age=120, stale-while-revalidate=600').json(result);
  })
);
