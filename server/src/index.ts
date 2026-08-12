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
      storage: caps.s3 ? 'S3' : 'local disk',
      anthropic: on(caps.anthropic),
      openai: on(caps.openai),
      smtp: caps.smtp ? 'on' : 'OFF (email logged, not sent)'
    },
    'service capabilities'
  );
  if (!caps.anthropic || !caps.openai) {
    logger.warn(
      'AI keys missing — uploads still process (renditions, EXIF, palette) but captions/semantic search are degraded. Add ANTHROPIC_API_KEY / OPENAI_API_KEY to enable.'
    );
  }
}

async function main() {
  await prisma.$connect();
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
