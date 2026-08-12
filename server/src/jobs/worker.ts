import '../lib/bigintJson';
import { Worker } from 'bullmq';
import { queueRedis } from '../lib/redis';
import { caps } from '../config/env';
import { IMAGE_QUEUE_NAME, type ImageJobData } from '../lib/queue';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { processImageJob } from './imageProcessor';

// The dedicated background worker. Only meaningful when Redis is configured —
// without it, image jobs run inline in the API process (see
// lib/queue.ts::enqueueImageJob) and this process has nothing to do.
if (!caps.redis || !queueRedis) {
  logger.warn(
    'Worker started but REDIS_URL is not set — image jobs run inline in the API process instead. ' +
      'You can stop this worker; it has no queue to drain.'
  );
} else {
  const imageWorker = new Worker<ImageJobData>(
    IMAGE_QUEUE_NAME,
    async job => {
      await processImageJob(job.data, job.attemptsMade + 1);
    },
    { connection: queueRedis, concurrency: 2 }
  );

  imageWorker.on('failed', async (job, err) => {
    logger.error({ photoId: job?.data.photoId, err, attempt: job?.attemptsMade }, 'image job failed');
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      await prisma.photo.update({ where: { id: job.data.photoId }, data: { status: 'FAILED' } }).catch(() => {});
    }
  });

  imageWorker.on('completed', job => {
    logger.info({ photoId: job.data.photoId }, 'image worker: job completed');
  });

  logger.info('Image processing worker started');
}
