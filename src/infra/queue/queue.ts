/**
 * BullMQ queue + connection singletons.
 *
 * - One Queue instance (producer) used by the API.
 * - One Worker instance is created in src/worker.ts using the same connection options.
 * - Connection is reused so we don't spawn a Redis socket per job.
 */
import { Queue, type ConnectionOptions } from 'bullmq';
import { config } from '../../config';

export const QUEUE_NAME = 'image-processing';

export const queueConnection: ConnectionOptions = {
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
  // BullMQ requires this for blocking operations.
  maxRetriesPerRequest: null,
};

export interface ImageJobPayload {
  imageId: string;
}

export const imageQueue = new Queue<ImageJobPayload>(QUEUE_NAME, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: { count: 100 },     // keep last 100 for inspection
    removeOnFail: { count: 500 },         // larger so we can debug failures
  },
});

export async function closeQueue() {
  await imageQueue.close();
}
