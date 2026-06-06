/**
 * Media-processing pipeline entrypoint (Part 2).
 *
 * Runs one or all of the three pipeline services in a single process,
 * controlled by PROCESSING_SERVICE:
 *
 *   PROCESSING_SERVICE=all       → convert + compress + variants  (default; dev)
 *   PROCESSING_SERVICE=convert   → just the conversion service
 *   PROCESSING_SERVICE=compress  → just the compression service
 *   PROCESSING_SERVICE=variants  → just the variant service
 *
 * To scale a single stage independently, run multiple processes pinned to that
 * one stage, e.g.:
 *
 *   PROCESSING_SERVICE=compress COMPRESS_CONCURRENCY=8 npm run start:processing
 *
 * This is the "independently scalable, stateless service" requirement made
 * concrete: the queue is the service boundary, so each stage scales on its own.
 */
import type { Worker } from 'bullmq';
import { config } from './config';
import { logger } from './shared/logger';
import { buildContainer } from './shared/container';
import { disconnectPrisma } from './infra/db/prisma';
import { closeEvents } from './shared/events';
import { closePipelineQueues } from './infra/queue/pipeline-queues';
import { startConversionWorker } from './workers/processing/conversion.worker';
import { startCompressionWorker } from './workers/processing/compression.worker';
import { startVariantsWorker } from './workers/processing/variants.worker';

const { storage } = buildContainer();
const service = config.PROCESSING_SERVICE;
const workers: Worker[] = [];

if (service === 'all' || service === 'convert') workers.push(startConversionWorker(storage));
if (service === 'all' || service === 'compress') workers.push(startCompressionWorker(storage));
if (service === 'all' || service === 'variants') workers.push(startVariantsWorker(storage));

logger.info({ service, workers: workers.length }, 'processing.started');

async function shutdown(signal: string) {
  logger.info({ signal }, 'processing.shutdown.begin');
  await Promise.allSettled(workers.map((w) => w.close()));
  await Promise.allSettled([closePipelineQueues(), disconnectPrisma(), closeEvents()]);
  logger.info('processing.shutdown.done');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'processing.unhandledRejection');
});
