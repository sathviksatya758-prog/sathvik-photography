import { Router } from 'express';
import { validate } from '../../middleware/validate';
import { requireAuth } from '../../middleware/auth';
import { authLimiter } from '../../middleware/rateLimit';
import {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  resendVerificationSchema
} from './auth.schema';
import {
  registerHandler,
  loginHandler,
  logoutHandler,
  refreshHandler,
  verifyEmailHandler,
  resendVerificationHandler,
  forgotPasswordHandler,
  resetPasswordHandler,
  meHandler
} from './auth.controller';

export const authRouter = Router();

authRouter.post('/register', authLimiter, validate({ body: registerSchema }), registerHandler);
authRouter.post('/login', authLimiter, validate({ body: loginSchema }), loginHandler);
authRouter.post('/logout', logoutHandler);
authRouter.post('/refresh', authLimiter, refreshHandler);
authRouter.post('/verify-email', authLimiter, validate({ body: verifyEmailSchema }), verifyEmailHandler);
authRouter.post(
  '/resend-verification',
  authLimiter,
  validate({ body: resendVerificationSchema }),
  resendVerificationHandler
);
authRouter.post('/forgot-password', authLimiter, validate({ body: forgotPasswordSchema }), forgotPasswordHandler);
authRouter.post('/reset-password', authLimiter, validate({ body: resetPasswordSchema }), resetPasswordHandler);
authRouter.get('/me', requireAuth, meHandler);
