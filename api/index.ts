// Vercel serverless entrypoint. An Express app is itself a valid
// (req, res) => void handler, so exporting it directly is all Vercel's
// Node runtime needs — no adapter required.
//
// Lives at the repo root (Vercel only auto-detects functions under a
// top-level /api) but the real app is in server/src — this file just
// re-exports it so the frontend (also at the repo root) and the API stay
// on one Vercel project / one domain. Module resolution for everything
// server/src imports (express, @prisma/client, etc.) still comes from
// server/node_modules, since Node resolves each import relative to the
// file that wrote it, not to this entrypoint.
//
// Deliberately skips the Postgres connect-with-retry loop and knowledge
// seeding that server/src/index.ts runs at startup: those exist to smooth
// over a cold/sleeping database on a long-lived process's *one* boot. Here
// every cold start would re-pay that cost, and Prisma already connects
// lazily and retries internally on first query, so there's nothing to
// gain by doing it eagerly.
import { createApp } from '../server/src/app';

const app = createApp();

export default app;
