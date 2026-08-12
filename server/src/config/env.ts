import 'dotenv/config';
import { z } from 'zod';

// The only hard requirement to boot is a Postgres connection string.
// Everything else — Redis, S3, the AI keys, SMTP — is optional: when a
// service isn't configured the app degrades to a local/in-memory
// equivalent (disk storage, in-memory cache + inline job processing,
// deterministic-but-non-AI enrichment, logged-instead-of-sent email) so a
// developer can run the whole stack against nothing but a free cloud
// Postgres URL. Add the real credentials later and the matching feature
// switches on with no code change. See docs/RUN_ON_WINDOWS.md.
const optional = () => z.string().trim().min(1).optional();

// z.coerce.boolean() uses Boolean(value), so the STRING "false" becomes true
// (any non-empty string is truthy) — a footgun for env vars. Parse the usual
// textual booleans instead so COOKIE_SECURE=false actually means false.
const boolish = (def: boolean) =>
  z.preprocess(v => {
    if (typeof v === 'boolean') return v;
    if (v == null || v === '') return def;
    const s = String(v).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(s)) return true;
    if (['false', '0', 'no', 'off'].includes(s)) return false;
    return def;
  }, z.boolean());

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  API_BASE_URL: z.string().url().default('http://localhost:4000'),
  CLIENT_ORIGIN: z.string().min(1).default('http://localhost:8080'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: optional(),

  // Defaulted so the app boots in dev; a startup guard (below) refuses to
  // run in production with these insecure defaults still in place.
  JWT_ACCESS_SECRET: z.string().min(16).default('dev-insecure-access-secret-change-me'),
  JWT_REFRESH_SECRET: z.string().min(16).default('dev-insecure-refresh-secret-change-me'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL: z.string().default('30d'),
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: boolish(false),
  OWNER_EMAIL: z.string().email().default('sathviksatya758@gmail.com'),

  // Object storage. When S3_BUCKET/S3_KEY/S3_SECRET are all present the
  // S3-compatible driver is used; otherwise files live on local disk under
  // LOCAL_STORAGE_DIR and are served from `${API_BASE_URL}/media/...`.
  S3_REGION: z.string().default('auto'),
  S3_ENDPOINT: z.string().optional(),
  S3_BUCKET: optional(),
  S3_KEY: optional(),
  S3_SECRET: optional(),
  S3_FORCE_PATH_STYLE: boolish(true),
  CDN_BASE: optional(),
  LOCAL_STORAGE_DIR: z.string().default('storage'),

  ANTHROPIC_API_KEY: optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-5'),
  OPENAI_API_KEY: optional(),
  EMBED_MODEL: z.string().default('text-embedding-3-small'),

  SMTP_HOST: optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASS: z.string().optional().default(''),
  SMTP_SECURE: boolish(false),
  MAIL_FROM: z.string().default('Photography Portfolio <no-reply@localhost>'),
  CONTACT_TO_EMAIL: z.string().email().default('sathviksatya758@gmail.com'),

  MAX_UPLOAD_MB: z.coerce.number().default(25)
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  throw new Error('Invalid environment configuration — see above and check .env against .env.example');
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';

// Capability flags — the rest of the codebase branches on these instead of
// re-checking individual env vars, so "is Redis configured?" is asked in
// exactly one place.
export const caps = {
  redis: Boolean(env.REDIS_URL),
  s3: Boolean(env.S3_BUCKET && env.S3_KEY && env.S3_SECRET),
  anthropic: Boolean(env.ANTHROPIC_API_KEY),
  openai: Boolean(env.OPENAI_API_KEY),
  smtp: Boolean(env.SMTP_HOST)
} as const;

// A production deployment must not silently run on the insecure dev
// defaults — that would ship guessable JWT signing keys. Fail fast instead.
if (isProd) {
  const usingDefaultSecrets =
    env.JWT_ACCESS_SECRET === 'dev-insecure-access-secret-change-me' ||
    env.JWT_REFRESH_SECRET === 'dev-insecure-refresh-secret-change-me';
  if (usingDefaultSecrets) {
    throw new Error('Refusing to start in production with default JWT secrets — set JWT_ACCESS_SECRET and JWT_REFRESH_SECRET.');
  }
}
