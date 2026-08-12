import Redis from 'ioredis';
import { env, caps } from '../config/env';
import { logger } from './logger';

// Redis is optional. When REDIS_URL is set we use it for caching, rate
// limiting and the BullMQ job queue. When it isn't, cacheGet/Set/Del fall
// back to an in-process Map with TTL expiry — correct for a single-instance
// dev/demo run, just not shared across processes (which is exactly why the
// image queue also runs inline in that mode; see lib/queue.ts).

// Separate connections for general cache/rate-limit use vs. BullMQ, since
// BullMQ requires maxRetriesPerRequest: null on its connection.
export const redis: Redis | null = caps.redis ? new Redis(env.REDIS_URL as string, { lazyConnect: false }) : null;
export const queueRedis: Redis | null = caps.redis
  ? new Redis(env.REDIS_URL as string, { maxRetriesPerRequest: null, lazyConnect: false })
  : null;

redis?.on('error', err => logger.error({ err }, 'redis connection error'));
queueRedis?.on('error', err => logger.error({ err }, 'redis (queue) connection error'));

if (!caps.redis) {
  logger.info('redis: not configured — using in-memory cache and inline job processing');
}

const DEFAULT_TTL_SECONDS = 60;

// --- In-memory fallback store ---
interface MemEntry {
  value: string;
  expiresAt: number;
}
const memStore = new Map<string, MemEntry>();

function memGet(key: string): string | null {
  const hit = memStore.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    memStore.delete(key);
    return null;
  }
  return hit.value;
}

function memSet(key: string, value: string, ttlSeconds: number): void {
  memStore.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

// Translate a Redis-style glob (only `*` is used in this codebase) into a
// RegExp so cacheDel('photos:list:*') works the same way in memory.
function memDeletePattern(pattern: string): void {
  if (!pattern.includes('*')) {
    memStore.delete(pattern);
    return;
  }
  const rx = new RegExp('^' + pattern.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  for (const key of memStore.keys()) {
    if (rx.test(key)) memStore.delete(key);
  }
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  const raw = redis ? await redis.get(key) : memGet(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds = DEFAULT_TTL_SECONDS): Promise<void> {
  const raw = JSON.stringify(value);
  if (redis) {
    await redis.set(key, raw, 'EX', ttlSeconds);
  } else {
    memSet(key, raw, ttlSeconds);
  }
}

export async function cacheDel(pattern: string): Promise<void> {
  if (!redis) {
    memDeletePattern(pattern);
    return;
  }
  if (!pattern.includes('*')) {
    await redis.del(pattern);
    return;
  }
  const stream = redis.scanStream({ match: pattern, count: 100 });
  const keys: string[] = [];
  for await (const chunk of stream) keys.push(...(chunk as string[]));
  if (keys.length) await redis.del(keys);
}

// Wraps a DB/compute call with a cache-aside pattern.
export async function cached<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T> {
  const hit = await cacheGet<T>(key);
  if (hit !== null) return hit;
  const value = await fn();
  await cacheSet(key, value, ttlSeconds);
  return value;
}
