import { Router } from 'express';
import { validate } from '../../middleware/validate';
import { optionalAuth } from '../../middleware/auth';
import { aiLimiter } from '../../middleware/rateLimit';
import { askSchema } from './chat.schema';
import { askHandler, askStreamHandler, getSessionHandler } from './chat.controller';

export const chatRouter = Router();

chatRouter.post('/', aiLimiter, optionalAuth, validate({ body: askSchema }), askHandler);
chatRouter.post('/stream', aiLimiter, optionalAuth, validate({ body: askSchema }), askStreamHandler);
chatRouter.get('/:sessionId', optionalAuth, getSessionHandler);
