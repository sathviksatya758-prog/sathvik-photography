import type { Response } from 'express';
import { env } from '../config/env';
import { ttlToMs } from './jwt';

// SameSite=Lax cookies aren't sent on cross-site fetch/XHR at all (only on
// top-level GET navigation) — fine when the frontend and API share a site
// (the Vercel deploy), but this app is also mirrored on GitHub Pages, a
// genuinely different site from the API's domain. The actual CSRF defense
// here is the double-submit token (see middleware/csrf.ts), not SameSite,
// so relaxing to None costs nothing once already on HTTPS (None requires
// Secure) and lets auth work from either frontend.
const baseCookie = {
  httpOnly: true as const,
  secure: env.COOKIE_SECURE,
  sameSite: (env.COOKIE_SECURE ? 'none' : 'lax') as 'none' | 'lax',
  domain: env.COOKIE_DOMAIN,
  path: '/'
};

export function setAccessCookie(res: Response, token: string) {
  res.cookie('access_token', token, { ...baseCookie, maxAge: ttlToMs(env.ACCESS_TOKEN_TTL) });
}

export function setRefreshCookie(res: Response, token: string) {
  // Scoped to /api/auth so it's never sent on unrelated requests.
  res.cookie('refresh_token', token, { ...baseCookie, path: '/api/auth', maxAge: ttlToMs(env.REFRESH_TOKEN_TTL) });
}

export function clearAuthCookies(res: Response) {
  res.clearCookie('access_token', { ...baseCookie });
  res.clearCookie('refresh_token', { ...baseCookie, path: '/api/auth' });
}
