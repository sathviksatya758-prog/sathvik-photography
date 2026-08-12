# Backend — Sathvik Photography Portfolio

Production backend for the single-page portfolio in the repo root (`index.html` +
`exhibition.js`/`exhibition.css`). Node.js + Express + TypeScript, PostgreSQL +
Prisma + pgvector, Redis, S3-compatible storage, Claude for AI captioning/chat,
OpenAI for embeddings.

The frontend is untouched in terms of design/animation — `index.html` now calls
this API instead of faking auth/storage/AI in the browser. See
[`../docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md) for how the two are wired together,
and [`../docs/API.md`](../docs/API.md) for the full endpoint reference.

`legacy/` holds the original `lib.ts` / `routes.ts` / `schema.sql` blueprint this
backend was built from (Next.js route-handler style). Nothing imports from it —
its logic was ported into `src/` and adapted to Express + Prisma + BullMQ; it's
kept only as a reference for the design this followed.

## Project structure

```
server/
  prisma/
    schema.prisma          All models (users, photos, embeddings, chat, contact, ...)
    migrations/000_init/   Prisma-generated DDL + hand-written pgvector/HNSW/search SQL
  src/
    config/env.ts          Zod-validated environment config — fails fast on boot if misconfigured
    lib/                   Shared clients: prisma, redis, storage (S3), mailer, anthropic,
                            embeddings, queue (BullMQ), logger, image pipeline, media URLs
    middleware/             auth (JWT), csrf, rateLimit, upload (multer), validate, error, logging
    modules/
      discovery/           taxonomy.ts (declarative auto-collections), discovery feed, GPS map
      recommendations/     multi-signal "keep exploring" rails
      auth/                register, login, logout, refresh, verify-email, forgot/reset password
      uploads/              POST /uploads (fast sync path), AI vision enrichment + on-demand critique, retry
      photos/                list/detail/delete/download, on-demand AI critique
      search/                hybrid pgvector + trigram search (cached), similar photos
      chat/                  RAG: retrieval + live stats + Claude (streaming + non-streaming), caching, session persistence
      contact/               real contact form, admin inbox
      analytics/             event tracking + dashboard summary
      admin/                 dashboard stats, photo/user management, audit log, knowledge reindex,
                             AI suggestions review (approve/reject), portfolio insights
      favorites/, collections/
    jobs/worker.ts          BullMQ worker: renditions, AI captioning, embeddings, auto-organization
                            suggestions (see below)
    app.ts, index.ts        Express app assembly + entrypoint
  Dockerfile, docker-compose.yml, docker-entrypoint.sh
  .env.example
```

## Why a background worker

Uploading is split in two:

1. **`POST /api/uploads`** (fast, synchronous): validates the file, reads EXIF,
   extracts a colour palette, generates a 24px blur placeholder, uploads the
   original to object storage, writes a `Photo` row with `status=PROCESSING`,
   and enqueues a job. Responds `202` immediately so the UI can show something
   right away.
2. **`jobs/worker.ts`** (background, via BullMQ/Redis): builds AVIF/WebP/JPEG
   renditions at 5 widths, calls Claude for caption/story/tags/mood/genre/etc,
   generates an OpenAI embedding, writes everything transactionally, and flips
   `status` to `READY` (or `FAILED` after 3 retries).

Run it as a separate process (`npm run worker` in dev, `node dist/jobs/worker.js`
in prod — docker-compose already does this as its own `worker` service).

## AI features

Everything below runs through the backend — no API key ever reaches the
browser. See [`../docs/API.md`](../docs/API.md) for exact request/response
shapes.

- **Enrichment (automatic, on upload)**: one Claude vision call per photo
  produces title, short/long captions, story, alt text, tags/categories/
  collections/SEO keywords/hashtags, mood, composition/lighting/color
  analysis, editing style, genre, Instagram/LinkedIn/X captions, and
  AI-estimated composition analysis (rule of thirds, symmetry, leading
  lines, composition/quality scores, scene classification, weather/time-of-
  day guess). See the disclosure comment in `modules/uploads/ai.service.ts`
  — the composition/quality fields are Claude's holistic judgment, not a
  dedicated CV/object-detection model.
- **Semantic search**: pgvector hybrid search (`modules/search`), Redis-
  cached per query for 5 minutes, invalidated on any upload/delete.
- **RAG chat**: retrieval over photo + bio/FAQ embeddings, augmented with a
  live-computed stats block (total count, most recent upload, camera/lens
  diversity — never cached, so "how many photos so far" is always current).
  Available as a normal JSON endpoint or as Server-Sent Events for
  progressive rendering (`POST /chat/stream`). First-turn answers are
  cached 10 minutes; follow-ups always hit Claude live since they depend on
  conversation context.
- **On-demand critique**: a *separate* Claude call (never automatic — see
  `modules/photos/critique.service.ts`) giving exposure/composition/
  cropping/white-balance/sharpness/noise/editing feedback for one photo at
  a time, cached in the DB until explicitly regenerated.
- **Auto-organization suggestions**: after each upload, the worker checks
  for near-duplicate embeddings (`find_duplicate_photos` SQL function) and
  proposes "featured" status for photos scoring highly on both composition
  and quality. Both are stored as `PENDING` `PhotoSuggestion` rows — an
  admin approves or rejects them via `/admin/suggestions`; nothing is ever
  applied automatically, and duplicates are never auto-deleted.
- **Portfolio insights**: aggregate stats (top subjects, genre/camera/lens/
  focal-length/ISO distribution, color trends, shooting locations, seasonal
  + monthly trends) computed from existing data, plus a short cached
  AI-written narrative summary — `GET /admin/insights`.
- **Discovery feed** (`modules/discovery`): horizontal AI-categorised rows.
  Collections are declared in `taxonomy.ts` and matched against each
  photo's generated metadata, so they populate themselves on upload with
  no manual tagging. One photo lands in several collections at once — a
  tiger in a forest appears under Wildlife, Nature *and* Forest Stories —
  because the enrichment pass now returns explicit detection buckets
  (`detectedAnimals`, `detectedBirds`, `detectedNature`, …) which the
  worker writes as tags.
- **Recommendation engine** (`modules/recommendations`): the rails under an
  opened photograph, fusing semantic embeddings, colour distance, shared
  categories/tags, mood, camera, lens and GPS proximity. See
  [`../docs/API.md`](../docs/API.md) for the exact weights.
- **Photography map**: EXIF GPS clustered server-side on a zoom-scaled
  grid, so the payload stays flat no matter how many geotagged frames
  exist — `GET /discovery/map`.
- **Client galleries**: share slugs, Argon2 gallery passwords, expiry, and
  per-gallery download/watermark policy on top of curated collections.

## Local development

```bash
npm install
cp .env.example .env        # fill in real keys when you have them; placeholders work for local dev
docker compose up -d        # postgres (pgvector) + redis + minio (local S3) + maildev (email preview)
npx prisma migrate deploy   # applies prisma/migrations/000_init (tables + pgvector/HNSW/search fns)
npm run dev                 # API on :4000
npm run worker              # separate terminal — background image processing
```

Then open `../index.html` in a browser (or serve the repo root as static files)
with `window.API_BASE_URL` pointing at `http://localhost:4000` (the default the
frontend already assumes — see the top of `index.html`'s script block).

Email (verification/reset/contact notifications) is caught by MailDev at
`http://localhost:1080` instead of actually sending anything in dev.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API with hot reload (`tsx watch`) |
| `npm run worker` | Background image-processing worker with hot reload |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` / `npm run worker:build` | Run the compiled API / worker |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm test` | Vitest unit tests (pure utils — no DB required) |
| `npm run prisma:migrate:dev` | Create + apply a new migration during development |
| `npm run prisma:studio` | Prisma's DB browser GUI |

## Security notes

- **Passwords**: Argon2id (OWASP-recommended params), never PBKDF2/bcrypt.
- **Sessions**: short-lived JWT access token + longer-lived JWT refresh token,
  both httpOnly cookies. The refresh token's hash (not the token itself) is
  stored server-side so it can be revoked/rotated; reuse of an already-rotated
  refresh token revokes the entire token family (theft detection).
- **Admin role**: set server-side at registration only if the email matches
  `OWNER_EMAIL`, checked from a signed JWT claim on every admin request
  (`requireAdmin` middleware) — this replaces the original frontend's
  client-only "isOwner" flag, which any visitor could spoof.
- **CSRF**: double-submit cookie (a non-httpOnly `csrf_token` cookie the
  frontend echoes back as `X-CSRF-Token` on mutating requests).
- **Rate limiting**: Redis-backed, tighter windows on `/auth/*`, `/uploads`,
  and AI-backed endpoints (`/search`, `/chat`) than general reads.
- **Uploads**: MIME allowlist + size cap enforced by multer before anything
  touches disk/memory beyond the buffer.
