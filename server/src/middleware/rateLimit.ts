import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { redis } from '../lib/redis';
import { AppError } from '../lib/errors';

// Redis-backed when available so limits hold across multiple app instances.
// Without Redis, express-rate-limit's default in-process memory store is
// used — correct for a single-instance dev/demo run.
export function makeLimiter(opts: { windowMs: number; max: number; prefix: string }) {
  const client = redis; // capture for the sendCommand closure so TS can narrow it
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.max,
    standardHeaders: true,
    legacyHeaders: false,
    store: client
      ? new RedisStore({
          prefix: `rl:${opts.prefix}:`,
          sendCommand: (...args: string[]) => (client.call as unknown as (...a: string[]) => Promise<never>)(...args)
        })
      : undefined,
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
