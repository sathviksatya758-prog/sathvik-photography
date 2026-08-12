import { Queue } from 'bullmq';
import { queueRedis } from './redis';
import { caps } from '../config/env';
import { logger } from './logger';
import { prisma } from './prisma';
import { processImageJob } from '../jobs/imageProcessor';

export const IMAGE_QUEUE_NAME = 'image-processing';

export interface ImageJobData {
  photoId: string;
  storageKey: string;
  mime: string;
  bytes: number;
  ownerNote?: string;
}

// BullMQ queue — only created when Redis is configured. A separate worker
// process (npm run worker) drains it. Without Redis this stays null and jobs
// run inline instead (see enqueueImageJob).
export const imageQueue =
  caps.redis && queueRedis
    ? new Queue<ImageJobData>(IMAGE_QUEUE_NAME, {
        connection: queueRedis,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: { count: 500 },
          removeOnFail: { count: 1000 }
        }
      })
    : null;

// Single entry point the rest of the app uses to schedule image processing.
//
//   Redis present  → hand the job to BullMQ; the worker process picks it up.
//   Redis absent   → run the pipeline inline, in this process, in the
//                    background (fire-and-forget). The upload endpoint has
//                    already returned 202 with a PROCESSING status, and the
//                    frontend polls /uploads/:id/status, so the work
//                    finishing a few seconds later is exactly the same
//                    observable behaviour — just without a broker.
export async function enqueueImageJob(data: ImageJobData): Promise<void> {
  if (imageQueue) {
    await imageQueue.add('process', data);
    return;
  }

  // imageProcessor only imports a *type* from this file, so the static import
  // above is not a runtime cycle. Run in the background so the upload request
  // (already 202'd with a PROCESSING status) returns immediately.
  setImmediate(async () => {
    try {
      await processImageJob(data);
    } catch (err) {
      logger.error({ err, photoId: data.photoId }, 'inline image job failed');
      await prisma.photo.update({ where: { id: data.photoId }, data: { status: 'FAILED' } }).catch(() => {});
    }
  });
}
