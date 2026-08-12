# Running the backend on Windows

The app is a real full-stack backend, but it no longer needs Docker, Redis,
S3, or any API keys to run. **The only hard requirement is a PostgreSQL
database with the `pgvector` extension.** Everything else degrades to a
local/in-memory equivalent and switches on later when you add the credentials
— no code change.

| Service | If configured | If not (default) |
|---|---|---|
| **Postgres + pgvector** | — | **required** |
| Redis | cross-process cache + rate limit + BullMQ worker | in-memory cache; image jobs run inline in the API |
| S3 | object store + CDN | files on local disk under `server/storage`, served at `/media/...` |
| Anthropic key | AI captions, story, tags, critique, chat, insights narrative | plain metadata from EXIF/palette; chat answers from archive stats |
| OpenAI key | real semantic search embeddings | deterministic (non-semantic) embeddings — search still returns results |
| SMTP | verification/reset/contact emails sent | emails logged to the server console (links still recoverable) |

---

## Recommended path — free cloud Postgres (no local install)

The hardest part on Windows is getting `pgvector` into Postgres. Skip it: a
free cloud Postgres ships pgvector built in.

### 1. Create a free Postgres with pgvector

Pick either:

- **Neon** — https://neon.tech → new project → copy the connection string.
- **Supabase** — https://supabase.com → new project → Settings → Database →
  Connection string (URI).

Both include `pgvector`. Copy the connection string; it looks like
`postgresql://user:password@host/dbname?sslmode=require`.

### 2. Configure the server

```powershell
cd server
npm install
Copy-Item .env.example .env
```

Open `server\.env` and set just this one line to your connection string:

```
DATABASE_URL=postgresql://user:password@host/dbname?sslmode=require
```

Leave everything else as-is (all optional blocks stay commented out).

### 3. Create the schema

```powershell
npx prisma generate
npx prisma migrate deploy
```

`migrate deploy` runs the migration **and** the pgvector setup
(`prisma/manual-additions.sql`: the `vector` extension, search functions, HNSW
indexes). If it errors that the extension can't be created, your database
doesn't have pgvector — use Neon/Supabase, which do.

### 4. Run it

```powershell
npm run dev
```

You should see `API listening on http://localhost:4000` followed by a
`service capabilities` line showing which features are on. You do **not** need
`npm run worker` in this mode — without Redis, image processing runs inline.

### 5. Serve the frontend over http (not file://)

Cookies don't work from `file://`, so serve the repo root. From the project
root in a second terminal:

```powershell
npx serve -l 8080 .
```

Then open http://localhost:8080. Sign up with the owner email
(`sathviksatya758@gmail.com`) to get the admin account; any other email is a
normal user.

---

## Turning features on later

Edit `server\.env`, uncomment the relevant block, restart `npm run dev`:

- **Real AI** — set `ANTHROPIC_API_KEY` (https://console.anthropic.com) and
  `OPENAI_API_KEY` (https://platform.openai.com). Re-run existing photos
  through the AI pipeline from the admin dashboard, or `POST /uploads/:id/retry`.
- **Redis** — set `REDIS_URL`. On Windows the easiest is
  [Memurai](https://www.memurai.com/) or Redis inside WSL. Then also run
  `npm run worker` in its own terminal.
- **S3 / R2** — set `S3_BUCKET`, `S3_KEY`, `S3_SECRET` (+ `S3_ENDPOINT`,
  `CDN_BASE` for R2/MinIO).
- **Email** — set `SMTP_HOST` (+ `SMTP_USER`/`SMTP_PASS`). A Gmail
  app-password works.

---

## Alternative — everything local with Docker

If you install [Docker Desktop](https://www.docker.com/products/docker-desktop/),
the original one-command path still works and brings up Postgres+pgvector,
Redis, MinIO and MailDev together:

```powershell
cd server
npm install
Copy-Item .env.example .env   # then uncomment the REDIS_URL / S3 / SMTP blocks
docker compose up -d
npx prisma migrate deploy
npm run dev
npm run worker                 # separate terminal
```

---

## Troubleshooting

- **"Couldn't reach the server…" / Failed to fetch on sign-up** — the API
  isn't running, or you opened `index.html` via `file://`. Start `npm run dev`
  and open the site over `http://localhost:8080`.
- **`migrate deploy` fails on `CREATE EXTENSION vector`** — the database lacks
  pgvector. Use Neon or Supabase.
- **Uploads stay "processing" forever** — check the `npm run dev` console for
  an `inline image job failed` error. Without AI keys this should still finish
  in a few seconds per photo.
- **Prisma can't connect** — confirm `DATABASE_URL` is reachable and, for cloud
  Postgres, that it ends with `?sslmode=require`.
