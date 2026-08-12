import type { Response } from 'express';
import { env } from '../config/env';
import { ttlToMs } from './jwt';

const baseCookie = {
  httpOnly: true as const,
  secure: env.COOKIE_SECURE,
  sameSite: 'lax' as const,
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
