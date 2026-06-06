/**
 * Conversion service (pipeline stage 1).
 *
 * Normalises the uploaded original into a canonical, upright JPEG and stores it
 * at a deterministic key. On success it hands off to the compression queue.
 *
 * Stateless: everything it needs (the original bytes, the row) is fetched from
 * S3 + Postgres per job, so any number of these workers can run in parallel.
 */
import { Worker, type Job } from 'bullmq';
import {
  PIPELINE_QUEUES,
  queueConnection,
  enqueueCompress,
  type PipelineJobPayload,
} from '../../infra/queue/pipeline-queues';
import { imageRepository } from '../../infra/repositories/image.repository';
import type { IStorageAdapter } from '../../infra/storage/storage.interface';
import { config } from '../../config';
import { logger } from '../../shared/logger';
import { eventBus } from '../../shared/events';
import { normalizeToJpeg } from './processors/image-ops';
import { normalizedKey } from './keys';

export function startConversionWorker(storage: IStorageAdapter): Worker<PipelineJobPayload> {
  const worker = new Worker<PipelineJobPayload>(
    PIPELINE_QUEUES.convert,
    async (job: Job<PipelineJobPayload>) => {
      const { imageId } = job.data;
      const row = await imageRepository.findById(imageId);
      if (!row) {
        logger.warn({ imageId }, 'convert.missing_row');
        return;
      }

      await imageRepository.setStatus(imageId, 'PROCESSING_CONVERT');
      eventBus.emitStatus({
        imageId,
        userId: row.userId,
        status: 'PROCESSING_CONVERT',
        at: new Date().toISOString(),
      });

      const original = await storage.getObject(row.s3KeyOriginal);
      const normalized = await normalizeToJpeg(original, row.mimeType);

      const key = normalizedKey(row.userId, imageId);
      await storage.putObject({ key, body: normalized.buffer, contentType: 'image/jpeg' });

      await imageRepository.setNormalized(imageId, key);
      await enqueueCompress(imageId);

      logger.info(
        { imageId, bytes: normalized.sizeBytes, w: normalized.width, h: normalized.height },
        'convert.done',
      );
    },
    { connection: queueConnection, concurrency: config.CONVERT_CONCURRENCY },
  );

  wireFailureHandler(worker, 'convert');
  logger.info({ concurrency: config.CONVERT_CONCURRENCY }, 'convert.worker.started');
  return worker;
}

/**
 * Shared final-attempt failure handler: when BullMQ exhausts retries, mark the
 * image FAILED with a clear, stage-tagged reason and emit it so the UI shows
 * something rather than the job silently disappearing.
 */
export function wireFailureHandler(worker: Worker<PipelineJobPayload>, stage: string): void {
  worker.on('failed', async (job, err) => {
    if (!job?.data?.imageId) return;
    if (job.attemptsMade < (job.opts.attempts ?? 1)) return; // retries remain
    try {
      const failed = await imageRepository.markProcessingFailed(
        job.data.imageId,
        stage,
        err.message ?? 'processing failed',
      );
      eventBus.emitStatus({
        imageId: failed.id,
        userId: failed.userId,
        status: 'FAILED',
        at: failed.updatedAt.toISOString(),
      });
      logger.error({ imageId: job.data.imageId, stage, err: err.message }, 'pipeline.stage.failed');
    } catch (persistErr) {
      logger.error({ persistErr, stage }, 'pipeline.failed.persist_error');
    }
  });
  worker.on('error', (err) => logger.error({ err, stage }, 'pipeline.worker.error'));
}
