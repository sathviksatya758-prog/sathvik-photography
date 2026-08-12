import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors';
import { verifyAccessToken, type AccessTokenPayload } from '../utils/jwt';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AccessTokenPayload;
    }
  }
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return req.cookies?.access_token ?? null;
}

// Populates req.user if a valid access token is present; never rejects.
// Use for endpoints whose behavior varies by auth state but doesn't require it.
export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const token = extractToken(req);
  if (token) {
    try {
      req.user = verifyAccessToken(token);
    } catch {
      // Expired/invalid token on an optional route — treat as anonymous.
    }
  }
  next();
}

// Requires a valid access token. 401 if missing/expired/invalid.
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = extractToken(req);
  if (!token) return next(AppError.unauthorized());
  try {
    req.user = verifyAccessToken(token);
    next();
  } catch {
    next(AppError.unauthorized('Session expired, please sign in again'));
  }
}

// Requires an authenticated ADMIN. This is the real, server-verified
// counterpart to the old client-only "isOwner" flag in index.html —
// role is set at registration (OWNER_EMAIL match) and checked here
// against a signed JWT, so it can't be spoofed from the browser.
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  requireAuth(req, res, err => {
    if (err) return next(err);
    if (req.user?.role !== 'ADMIN') return next(AppError.forbidden('Admin access required'));
    next();
  });
}
