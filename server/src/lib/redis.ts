import Redis from 'ioredis';
import { env } from '../config/env';
import { logger } from './logger';

// Separate connections for general cache/rate-limit use vs. BullMQ,
// since BullMQ requires maxRetriesPerRequest: null on its connection.
export const redis = new Redis(env.REDIS_URL, { lazyConnect: false });
export const queueRedis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });

redis.on('error', err => logger.error({ err }, 'redis connection error'));
queueRedis.on('error', err => logger.error({ err }, 'redis (queue) connection error'));

const DEFAULT_TTL_SECONDS = 60;

export async function cacheGet<T>(key: string): Promise<T | null> {
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds = DEFAULT_TTL_SECONDS): Promise<void> {
  await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
}

export async function cacheDel(pattern: string): Promise<void> {
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
