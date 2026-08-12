# Deployment Guide

## Architecture

```
index.html + exhibition.js/css   (static frontend — any static host/CDN)
        │  fetch(..., {credentials:'include'})
        ▼
server/  Express API  ──────────►  Postgres (pgvector) + Redis
        │                                  ▲
        ▼                                  │
   BullMQ queue  ──────────►  jobs/worker.ts (renditions, Claude, embeddings)
        │
        ▼
S3-compatible object storage (AWS S3 / Cloudflare R2 / Supabase Storage / MinIO)
```

Three deployable units: the **API**, the **worker**, and the **static frontend**.
They can live on the same host or be split across services — nothing here
assumes a specific provider beyond "Postgres with the `vector` extension
available" and "an S3-compatible bucket".

## 1. Frontend ↔ API wiring

`index.html` calls the API through a single constant near the top of its
inline script:

```js
const API_BASE=(window.API_BASE_URL||'http://localhost:4000')+'/api';
```

For any deployment other than local dev, set `window.API_BASE_URL` before that
script runs — e.g. add this right before the closing `</body>` tag's scripts,
or inject it at build/deploy time:

```html
<script>window.API_BASE_URL='https://api.yourdomain.com';</script>
```

**Cookies require a shared registrable domain.** The API sets `access_token`/
`refresh_token`/`csrf_token` as `SameSite=Lax` cookies (see
`server/src/utils/cookies.ts`). Lax cookies flow correctly across subdomains
of the same site (e.g. frontend on `www.example.com`, API on
`api.example.com` — both are `example.com`), but **not** across genuinely
different domains. Two options:

- **Recommended**: deploy the API under a subdomain of the same domain as the
  frontend, and set `COOKIE_DOMAIN=example.com` in the API's env so the
  cookie is readable by both.
- **Alternative**: put a reverse proxy in front of both (e.g. nginx/Caddy
  routing `/api/*` to the backend, everything else to the static frontend) so
  they share one origin entirely and cookies need no cross-subdomain scoping.

## 2. Environment variables

See `server/.env.example` for the full list with inline comments. The
important production changes from the local-dev defaults:

| Variable | Local dev | Production |
|---|---|---|
| `COOKIE_SECURE` | `false` | `true` (requires HTTPS) |
| `S3_ENDPOINT` | MinIO (`http://localhost:9000`) | Your real S3/R2/Supabase endpoint |
| `CDN_BASE` | MinIO bucket URL | Your CDN/bucket public URL |
| `SMTP_HOST`/`PORT` | MailDev | A real provider (SES, Resend, SendGrid, etc — any SMTP works) |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | placeholders | Generate real 48-byte random secrets, never reuse across environments |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | placeholders | Real keys — **only ever set on the server**, never shipped to the browser |

Generate secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## 3. Database

```bash
npx prisma migrate deploy
```

This applies `server/prisma/migrations/000_init/migration.sql`, which
includes both the Prisma-generated tables/indexes and the hand-written
pgvector extension/HNSW indexes/search SQL functions appended at the bottom
(see the comment block inside that file). Run this on every deploy — it's
idempotent; `docker-entrypoint.sh` already does it automatically before the
API/worker start in the Docker setup.

Your Postgres must support the `vector`, `pg_trgm`, `citext`, and `uuid-ossp`
extensions. Managed providers with `pgvector` available: Supabase, Neon
(via extension), Amazon RDS/Aurora (15.6+), Google Cloud SQL, or self-hosted
using the `pgvector/pgvector` Docker image (what `docker-compose.yml` uses
locally).

## 4. Object storage bucket

Whichever S3-compatible provider you use, the bucket needs public-read access
for the object keys under `originals/` and `renditions/` (images are served
directly from `CDN_BASE`, not presigned) — or put a real CDN in front of a
private bucket and point `CDN_BASE` at that instead. `docker-compose.yml`'s
`minio-init` service shows the equivalent local setup (`mc anonymous set
download`).

## 5. Background worker

The image pipeline (renditions, Claude captioning, embeddings) runs in
`jobs/worker.ts`, separate from the API process, so a burst of uploads or a
slow AI call never blocks request handling. Run it as its own
process/container (`node dist/jobs/worker.js`) and scale it independently —
BullMQ's Redis-backed queue means multiple worker instances safely share the
job list.

## 6. Docker

```bash
cd server
docker compose up -d --build   # postgres, redis, minio, maildev, api, worker
```

`docker-compose.yml` is meant for local development (it bundles MinIO and
MailDev as stand-ins for real services). For production, build just the
`runtime` target and point it at your real Postgres/Redis/S3/SMTP:

```bash
docker build --target runtime -t sathvik-api .
docker run --env-file .env.production -p 4000:4000 sathvik-api
docker run --env-file .env.production sathvik-api node dist/jobs/worker.js
```

## 7. CI/CD

`.github/workflows/ci.yml` runs on every push/PR to `main`: install, generate
Prisma client, lint, typecheck, unit tests, build, and a Docker build
validation — all against dummy env values, no real infrastructure required.
Extend it with a deploy job once you've picked a host (the workflow is
intentionally infrastructure-agnostic up to that point).

## 8. First admin account

There's no separate "make me admin" step — register through the normal
`/auth/register` flow (or the site's Sign Up form) using the email in
`OWNER_EMAIL`. That account is granted `ADMIN` server-side at creation time;
every other signup gets `USER`. This is checked from the signed JWT on every
admin-only request, so it can't be spoofed from the browser (unlike the
original frontend-only "isOwner" flag).
