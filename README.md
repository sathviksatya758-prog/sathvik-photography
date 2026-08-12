# Katnam Sathvik — Photography Portfolio

A full-stack photography portfolio: a static, animation-heavy single-page
frontend backed by a production Node.js/Express API with real auth, an
AI-powered upload pipeline, semantic search, and a RAG chat assistant scoped
to the photographer's own work.

```
index.html, exhibition.js, exhibition.css   Frontend — SPA, no build step
server/                                     Backend — Express + TypeScript + Prisma
docs/API.md                                 Full endpoint reference
docs/DEPLOYMENT.md                          How the two are wired together + hosting notes
.github/workflows/ci.yml                    Lint/typecheck/test/build/docker-build on every push
```

## Quickstart

```bash
cd server
npm install
cp .env.example .env
docker compose up -d           # postgres (pgvector) + redis + minio + maildev
npx prisma migrate deploy
npm run dev                    # API on :4000
npm run worker                 # separate terminal — background image processing
```

Then open `index.html` in a browser (or serve the repo root as static files).
It talks to `http://localhost:4000` by default — see
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for pointing it elsewhere in
production. Full backend details: [`server/README.md`](server/README.md).

## Frontend

Single page, four sections (Work / Upload / About / Contact), no framework,
no build step — just `index.html` plus the `exhibition.js`/`.css` upgrade
layer.

| Feature | Notes |
|---|---|
| Discovery view | Default browsing experience — horizontal AI-categorised rails (Wildlife, Golden Hour, Ocean Blues…) that scroll sideways while the page scrolls down |
| View switcher | Discovery / Masonry / Grid, remembered per visitor. The original masonry layout is untouched and still one click away |
| Masonry gallery | FLIP-animated layout, lazy loading, auto-generated category filters, offline lexical search |
| Recommendation rails | Opening a photo reveals AI Recommended, Related, More Like This, Shares Subjects, Same Palette/Mood/Camera/Lens, Nearby and Recently Captured |
| Photography map | GPS-plotted world map (self-contained SVG, no external tiles) with count-scaled markers, density heatmap, and a year-range timeline |
| Analytics dashboard | Owner-only: KPI tiles, camera/lens/focal/ISO/genre/subject/seasonal bars, colour-trend strip, most-viewed/downloaded leaderboards, AI narrative |
| Client galleries | Owner-only management (create collections, add photos, mint password/expiry share links) plus the public shared-gallery view clients see at `/?gallery=<slug>` |
| Lightbox | Keyboard nav, zoom/pan, filmstrip, EXIF viewer, focus trap |
| Upload | Drag-and-drop, real EXIF extraction, colour palette, blur placeholder — owner-only, now server-verified |
| Auth | Sign in/up UI; passwords hashed server-side with Argon2, sessions in httpOnly JWT cookies |
| Studio assistant | Chat widget with streaming replies, clickable citations, backed by pgvector retrieval + Claude, scoped to photography-only questions |
| Contact | Real form (name/email/subject/message) alongside the mailto fallback |
| SEO | Dynamic JSON-LD + meta tags |

The Upload nav link is visible only to the signed-in owner account — enforced
by the server (`role: ADMIN`, checked from a signed JWT), not just hidden in
the UI.

## Backend

Node.js + Express + TypeScript, PostgreSQL + Prisma + pgvector, Redis, an
S3-compatible object store, Claude for captioning/chat/critique, OpenAI for
embeddings. Covers auth (JWT + refresh rotation, email verification,
password reset), a background-queued image pipeline (EXIF → palette → LQIP →
AVIF/WebP/JPEG renditions → AI caption/story/tags/mood/genre/multi-platform
captions/composition analysis → embeddings), hybrid semantic+lexical search
(cached), a streaming RAG chat endpoint, on-demand AI photo critique,
AI-generated auto-organization suggestions (featured picks, duplicate
detection — admin-approved before anything applies), portfolio insights
with an AI narrative summary, favorites/collections, a real contact form,
analytics, and admin endpoints — plus Helmet, CORS, CSRF, rate limiting,
structured logging, and Docker/CI. See [`server/README.md`](server/README.md)
for the full breakdown and [`docs/API.md`](docs/API.md) for every endpoint.

`server/legacy/` holds the original `lib.ts`/`routes.ts`/`schema.sql`
blueprint (Next.js route-handler style) this backend was built from — kept
for reference, not imported by anything.
