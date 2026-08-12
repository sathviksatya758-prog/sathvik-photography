import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate';
import { requireAdmin } from '../../middleware/auth';
import { contactLimiter } from '../../middleware/rateLimit';
import { submitContactSchema, listMessagesQuerySchema, updateStatusSchema } from './contact.schema';
import { submitContactHandler, listMessagesHandler, updateStatusHandler } from './contact.controller';

export const contactRouter = Router();
const idParams = z.object({ id: z.string().uuid() });

contactRouter.post('/', contactLimiter, validate({ body: submitContactSchema }), submitContactHandler);
contactRouter.get('/', requireAdmin, validate({ query: listMessagesQuerySchema }), listMessagesHandler);
contactRouter.patch('/:id', requireAdmin, validate({ params: idParams, body: updateStatusSchema }), updateStatusHandler);
