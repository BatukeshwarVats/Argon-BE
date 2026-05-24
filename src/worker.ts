/**
 * Worker process entrypoint.
 *
 * Run separately from the API:
 *   npm run dev:worker   # development
 *   npm run start:worker # production
 *
 * This lets us scale image-processing horizontally without scaling HTTP
 * (and vice versa).
 */
import { startWorker } from './workers/image.worker';
import { logger } from './shared/logger';
import { disconnectPrisma } from './infra/db/prisma';
import { closeEvents } from './shared/events';

const worker = startWorker();

async function shutdown(signal: string) {
  logger.info({ signal }, 'worker.shutdown.begin');
  await worker.close();
  await Promise.allSettled([disconnectPrisma(), closeEvents()]);
  logger.info('worker.shutdown.done');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'worker.unhandledRejection');
});
