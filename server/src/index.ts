import { createApp } from './app';
import { env, caps } from './config/env';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { seedDefaultKnowledgeIfEmpty } from './modules/chat/chat.service';

function logCapabilities() {
  const on = (b: boolean) => (b ? 'on' : 'OFF (fallback)');
  logger.info(
    {
      redis: caps.redis ? 'on' : 'OFF (in-memory cache + inline image jobs)',
      storage: caps.blob ? 'Vercel Blob' : caps.s3 ? 'S3' : 'local disk',
      gemini: on(caps.gemini),
      anthropic: on(caps.anthropic),
      openai: on(caps.openai),
      smtp: caps.smtp ? 'on' : 'OFF (email logged, not sent)'
    },
    'service capabilities'
  );
  if (!caps.gemini && !caps.anthropic) {
    logger.warn(
      'No vision AI key configured — uploads still process (renditions, EXIF, palette) but captions/chat/describe/critique run in non-AI fallback mode. Add GEMINI_API_KEY (preferred) or ANTHROPIC_API_KEY to enable.'
    );
  }
  if (!caps.openai) {
    logger.warn('OPENAI_API_KEY missing — semantic search embeddings are degraded to lexical-only matching.');
  }
}

// Serverless Postgres (e.g. Neon free tier) auto-suspends when idle and takes
// a few seconds to wake on the next connection — the first attempt often times
// out. Retry a few times so a cold database doesn't kill the whole server at
// startup instead of just waiting for it to come up.
async function connectWithRetry(attempts = 6, delayMs = 4000) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await prisma.$connect();
      if (i > 1) logger.info(`database connected on attempt ${i}`);
      return;
    } catch (err) {
      if (i === attempts) throw err;
      logger.warn(`database not reachable (attempt ${i}/${attempts}) — retrying in ${delayMs}ms`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

async function main() {
  await connectWithRetry();
  await seedDefaultKnowledgeIfEmpty().catch(err => logger.warn({ err }, 'knowledge seed skipped'));

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
    logCapabilities();
  });

  const shutdown = (signal: string) => {
    logger.info(`${signal} received, shutting down`);
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error:', err);
  process.exit(1);
});
