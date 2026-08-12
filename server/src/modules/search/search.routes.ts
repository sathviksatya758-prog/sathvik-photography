import { Router } from 'express';
import { validate } from '../../middleware/validate';
import { aiLimiter } from '../../middleware/rateLimit';
import { searchQuerySchema, similarParamsSchema } from './search.schema';
import { searchHandler, similarHandler } from './search.controller';

export const searchRouter = Router();

searchRouter.get('/', aiLimiter, validate({ query: searchQuerySchema }), searchHandler);
searchRouter.get('/similar/:id', validate({ params: similarParamsSchema }), similarHandler);
