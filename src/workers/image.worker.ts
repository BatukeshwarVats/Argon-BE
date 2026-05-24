/**
 * Image processing worker.
 *
 * For each job:
 *   1. Load metadata row (must exist; if not the job is dead-lettered).
 *   2. Mark PROCESSING.
 *   3. Download the original from S3 into memory.
 *   4. Run the validation pipeline.
 *   5. Persist outcome:
 *        - REJECTED with reasons[]   (status + rejectionReasons JSON)
 *        - ACCEPTED with dims + hash (and display copy if HEIC was converted)
 *   6. Emit a status event → SSE subscribers (FE) update in real time.
 *
 * Idempotency: BullMQ jobId == imageId. Re-running a finished job will
 * re-compute and overwrite, which is safe (deterministic given the same
 * input file).
 */
import { Worker, type Job } from 'bullmq';
import { QUEUE_NAME, queueConnection, type ImageJobPayload } from '../infra/queue/queue';
import { imageRepository } from '../infra/repositories/image.repository';
import { buildContainer } from '../shared/container';
import { buildDefaultPipeline } from './pipeline/pipeline.factory';
import type { ValidationContext } from './validators/validator.interface';
import { logger } from '../shared/logger';
import { eventBus } from '../shared/events';

export function startWorker() {
  const { storage } = buildContainer();
  const pipeline = buildDefaultPipeline();

  const worker = new Worker<ImageJobPayload>(
    QUEUE_NAME,
    async (job: Job<ImageJobPayload>) => {
      const { imageId } = job.data;
      logger.info({ imageId, jobId: job.id }, 'worker.job.start');

      const row = await imageRepository.findById(imageId);
      if (!row) {
        // Row deleted between enqueue and pickup. Nothing to do.
        logger.warn({ imageId }, 'worker.job.missing_row');
        return;
      }

      await imageRepository.markProcessing(imageId);
      eventBus.emitStatus({
        imageId,
        userId: row.userId,
        status: 'PROCESSING',
        at: new Date().toISOString(),
      });

      const buffer = await storage.getObject(row.s3KeyOriginal);

      const ctx: ValidationContext = {
        imageId: row.id,
        userId: row.userId,
        buffer,
        mimeType: row.mimeType,
      };

      const result = await pipeline.run(ctx);

      if (!result.passed) {
        const updated = await imageRepository.markRejected(imageId, result.reasons);
        eventBus.emitStatus({
          imageId,
          userId: row.userId,
          status: updated.status,
          rejectionReasons: result.reasons,
          at: updated.updatedAt.toISOString(),
        });
        logger.info(
          { imageId, reasons: result.reasons.map((r) => r.code) },
          'worker.job.rejected',
        );
        return;
      }

      // Persist the converted display copy if HEIC was converted in-pipeline.
      let s3KeyDisplay: string | undefined;
      if (ctx.displayBuffer && ctx.displayMime) {
        s3KeyDisplay = row.s3KeyOriginal.replace('/originals/', '/display/').replace(/\.[^.]+$/, '.jpg');
        await storage.putObject({
          key: s3KeyDisplay,
          body: ctx.displayBuffer,
          contentType: ctx.displayMime,
          cacheControl: 'public, max-age=31536000, immutable',
        });
      }

      const updated = await imageRepository.markAccepted(imageId, {
        width: ctx.width!,
        height: ctx.height!,
        perceptualHash: ctx.perceptualHash!,
        s3KeyDisplay,
      });

      eventBus.emitStatus({
        imageId,
        userId: row.userId,
        status: updated.status,
        at: updated.updatedAt.toISOString(),
      });
      logger.info({ imageId }, 'worker.job.accepted');
    },
    {
      connection: queueConnection,
      concurrency: 4,
    },
  );

  worker.on('failed', async (job, err) => {
    logger.error({ jobId: job?.id, err }, 'worker.job.failed');
    if (job?.data?.imageId && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      // Final failure: mark FAILED so the FE shows the user something useful.
      try {
        const failed = await imageRepository.markFailed(
          job.data.imageId,
          err.message ?? 'processing failed',
        );
        eventBus.emitStatus({
          imageId: failed.id,
          userId: failed.userId,
          status: failed.status,
          at: failed.updatedAt.toISOString(),
        });
      } catch (persistErr) {
        logger.error({ persistErr }, 'worker.failed.persist_error');
      }
    }
  });

  worker.on('error', (err) => logger.error({ err }, 'worker.error'));

  logger.info('worker.started');
  return worker;
}
