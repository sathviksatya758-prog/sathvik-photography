import type { NextFunction, Request, Response } from 'express';
import { generateToken } from '../utils/tokens';
import { env } from '../config/env';
import { AppError } from '../lib/errors';

const COOKIE_NAME = 'csrf_token';
const HEADER_NAME = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Double-submit cookie CSRF protection (csurf is deprecated/unmaintained,
// this is its recommended replacement pattern). The cookie is readable
// by JS on purpose — the frontend reads it and echoes it back as a
// header, which a cross-site form/script can't do since it can't read
// cookies set for this origin. Runs on every request so a token always
// exists; only enforced (compared) on state-changing methods.
export function ensureCsrfCookie(req: Request, res: Response, next: NextFunction) {
  if (!req.cookies?.[COOKIE_NAME]) {
    res.cookie(COOKIE_NAME, generateToken(24), {
      httpOnly: false,
      secure: env.COOKIE_SECURE,
      sameSite: 'lax',
      domain: env.COOKIE_DOMAIN,
      path: '/'
    });
  }
  next();
}

export function verifyCsrf(req: Request, _res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) return next();
  const cookieToken = req.cookies?.[COOKIE_NAME];
  const headerToken = req.headers[HEADER_NAME];
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return next(AppError.forbidden('Invalid or missing CSRF token'));
  }
  next();
}
