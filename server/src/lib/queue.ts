import { Queue } from 'bullmq';
import { queueRedis } from './redis';

export const IMAGE_QUEUE_NAME = 'image-processing';

export interface ImageJobData {
  photoId: string;
  storageKey: string;
  mime: string;
  bytes: number;
  ownerNote?: string;
}

export const imageQueue = new Queue<ImageJobData>(IMAGE_QUEUE_NAME, {
  connection: queueRedis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 1000 }
  }
});
