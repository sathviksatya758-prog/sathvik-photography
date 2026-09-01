# Katnam Sathvik — Photography Portfolio

**Live:** https://sathvik-photography.vercel.app · https://sathviksatya758-prog.github.io/sathvik-photography/

A full-stack photography portfolio built for a working photographer based in
Visakhapatnam, India. It pairs a hand-built, animation-driven single-page
frontend with a production-grade Node.js API — real authentication, an
AI-assisted upload pipeline, hybrid semantic search, and a retrieval-augmented
chat assistant that only answers questions about the photographer's own work.

The project treats the archive as structured data rather than a folder of
JPEGs: every photograph carries EXIF, a computed colour palette, AI-generated
captions and composition analysis, and a vector embedding, so the site can
browse, search, and talk about the work the way a human curator would —
without depending on a page-builder template or a third-party gallery plugin.

## What it does

- **Discovery browsing.** The homepage organises photographs into
  AI-categorised horizontal rows (mood, subject, palette, season) rather than
  a single flat grid, with a masonry and a uniform-grid view available as
  alternatives, remembered per visitor.
- **Real authentication.** Argon2id password hashing, rotating JWT refresh
  tokens with theft/reuse detection, double-submit CSRF protection, and a
  server-verified admin role — the upload/delete/dashboard surface is gated
  by a signed token, not a client-side flag that could be spoofed.
- **AI-assisted uploads.** Every photograph is read for EXIF, quantised into
  a dominant colour palette, and — when an Anthropic key is configured —
  captioned, storied, and tagged by Claude, then embedded for search.
  AVIF/WebP/JPEG renditions are generated at five responsive breakpoints.
- **Hybrid search.** pgvector semantic similarity combined with lexical term
  matching, cached and reranked, surfaced through an "Ask AI" search box.
- **Studio assistant.** A streaming chat widget backed by retrieval over the
  photographer's own archive and biography, with inline citations — scoped
  so it can't be steered into general-purpose use or discussing pricing.
- **Owner dashboard.** Portfolio KPIs, camera/lens/genre breakdowns, an
  AI-written narrative summary, and AI-proposed auto-organization
  suggestions that require explicit admin approval before anything changes.
- **Accessibility and SEO.** Dynamic JSON-LD structured data, descriptive
  alt text generated per photograph, a keyboard-navigable lightbox with a
  focus trap, and reduced-motion support throughout.

## Architecture

The frontend is a single `index.html` with no build step and no framework —
plain JavaScript, animated with CSS transforms and the FLIP technique for
the masonry layout. The backend is Express and TypeScript on Node, with
Prisma over PostgreSQL (pgvector for embeddings), Redis-backed caching and
job queues when available, and a graceful in-process fallback when they're
not — the whole stack runs end to end on nothing but a Postgres connection
string, with every optional integration (Redis, object storage, Claude,
OpenAI, SMTP) switching on automatically the moment its credentials are set.

In production, the static frontend and the API run as one Vercel project —
the API as a serverless function on the same domain, which keeps
authentication cookies same-site without any special-casing. Photo storage
uses Vercel Blob rather than local disk, since a serverless function has no
persistent filesystem between invocations. The same backend also serves a
second, public mirror of the frontend on GitHub Pages, wired through CORS
and cross-site cookies so the two stay functionally identical.

## Stack

**Frontend** — vanilla JavaScript, no framework, no bundler.
**Backend** — Node.js, Express, TypeScript, Prisma, PostgreSQL + pgvector,
Redis and BullMQ (optional), Argon2, JWT, Zod, Helmet.
**AI** — Anthropic Claude for captions/chat/critique, OpenAI for embeddings —
both optional, with deterministic non-AI fallbacks when unset.
**Infrastructure** — Vercel (frontend + serverless API), Vercel Blob (object
storage), Neon (managed Postgres), GitHub Actions (lint, typecheck, test and
build on every push), GitHub Pages (public mirror).

## Security

Helmet with a strict content-security policy, rate limiting tuned per route
class (tighter on auth and AI endpoints), account lockout after repeated
failed logins, hashed and rotated refresh tokens with family-wide revocation
on reuse detection, consistent HTML-escaping of user-supplied input, and no
client-controllable authorization anywhere — every privileged action is
re-checked server-side against a signed token, independent of what the UI
shows.

## Running it locally

```bash
cd server
npm install
cp .env.example .env       # set DATABASE_URL — everything else is optional
npx prisma generate
npx prisma migrate deploy
npm run dev                # API on :4000
```

Serve the repo root over HTTP in a second terminal — cookies don't work from
a `file://` path:

```bash
npx serve -l 8080 .
```

Sign up with the address configured as `OWNER_EMAIL` to receive the admin
role. Full local setup, including a free cloud Postgres option, is in
[`docs/RUN_ON_WINDOWS.md`](docs/RUN_ON_WINDOWS.md); the complete API
reference is in [`docs/API.md`](docs/API.md).

## Project layout

```
index.html, exhibition.js, exhibition.css   Frontend — single page, no build step
api/index.ts                                Vercel serverless entrypoint (wraps the Express app)
server/                                      Backend — Express + TypeScript + Prisma
docs/API.md                                  Full endpoint reference
docs/DEPLOYMENT.md                           How the two are wired together + hosting notes
.github/workflows/ci.yml                     Lint/typecheck/test/build on every push
```
