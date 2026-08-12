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

// Bootstrap endpoint for the double-submit CSRF flow: a plain GET that the
// frontend calls before its first mutating request. The global
// ensureCsrfCookie middleware sets the csrf_token cookie; this returns the
// same token in the body so the client can send it as X-CSRF-Token without
// depending on cookie-read timing. Safe (GET) — not itself CSRF-protected.
authRouter.get('/csrf', (_req, res) => res.json({ csrfToken: res.locals.csrfToken }));

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
