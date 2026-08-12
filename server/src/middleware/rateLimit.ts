import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { redis } from '../lib/redis';
import { AppError } from '../lib/errors';

// Redis-backed so limits hold across multiple app instances, not just
// per-process memory.
export function makeLimiter(opts: { windowMs: number; max: number; prefix: string }) {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.max,
    standardHeaders: true,
    legacyHeaders: false,
    store: new RedisStore({
      prefix: `rl:${opts.prefix}:`,
      sendCommand: (...args: string[]) => (redis.call as unknown as (...a: string[]) => Promise<never>)(...args)
    }),
    handler: (_req, _res, next) => next(AppError.tooManyRequests())
  });
}

// General API traffic
export const apiLimiter = makeLimiter({ windowMs: 60_000, max: 120, prefix: 'api' });
// Auth endpoints — tighter, since these are brute-force targets
export const authLimiter = makeLimiter({ windowMs: 60_000, max: 10, prefix: 'auth' });
// Uploads — expensive (image pipeline + AI calls)
export const uploadLimiter = makeLimiter({ windowMs: 60_000, max: 20, prefix: 'upload' });
// Search / chat — call out to embeddings + Claude
export const aiLimiter = makeLimiter({ windowMs: 60_000, max: 30, prefix: 'ai' });
// Contact form — deter spam
export const contactLimiter = makeLimiter({ windowMs: 3_600_000, max: 5, prefix: 'contact' });
