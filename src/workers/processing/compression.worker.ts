/**
 * Compression service (pipeline stage 2).
 *
 * Re-encodes the normalised JPEG at a target quality (mozjpeg) and records the
 * compression ratio + output size. Hands off to the variant queue.
 *
 * Ratio = compressedBytes / normalizedBytes. We read the normalised object to
 * get its byte length rather than persisting it separately — keeps the schema
 * lean and the worker stateless.
 */
import { Worker, type Job } from 'bullmq';
import {
  PIPELINE_QUEUES,
  queueConnection,
  enqueueVariants,
  type PipelineJobPayload,
} from '../../infra/queue/pipeline-queues';
import { imageRepository } from '../../infra/repositories/image.repository';
import type { IStorageAdapter } from '../../infra/storage/storage.interface';
import { config } from '../../config';
import { logger } from '../../shared/logger';
import { eventBus } from '../../shared/events';
import { compressJpeg } from './processors/image-ops';
import { compressedKey } from './keys';
import { wireFailureHandler } from './conversion.worker';

export function startCompressionWorker(storage: IStorageAdapter): Worker<PipelineJobPayload> {
  const worker = new Worker<PipelineJobPayload>(
    PIPELINE_QUEUES.compress,
    async (job: Job<PipelineJobPayload>) => {
      const { imageId } = job.data;
      const row = await imageRepository.findById(imageId);
      if (!row) {
        logger.warn({ imageId }, 'compress.missing_row');
        return;
      }
      if (!row.normalizedKey) {
        throw new Error('compress stage reached without a normalized image');
      }

      await imageRepository.setStatus(imageId, 'PROCESSING_COMPRESS');
      eventBus.emitStatus({
        imageId,
        userId: row.userId,
        status: 'PROCESSING_COMPRESS',
        at: new Date().toISOString(),
      });

      const normalized = await storage.getObject(row.normalizedKey);
      const compressed = await compressJpeg(normalized, config.COMPRESSION_QUALITY);

      const key = compressedKey(row.userId, imageId);
      await storage.putObject({ key, body: compressed.buffer, contentType: 'image/jpeg' });

      const ratio = normalized.length > 0 ? compressed.sizeBytes / normalized.length : 1;
      await imageRepository.setCompressed(imageId, {
        compressedKey: key,
        compressedBytes: compressed.sizeBytes,
        compressionRatio: Number(ratio.toFixed(4)),
      });
      await enqueueVariants(imageId);

      logger.info(
        {
          imageId,
          normalizedBytes: normalized.length,
          compressedBytes: compressed.sizeBytes,
          ratio: Number(ratio.toFixed(4)),
          savedPct: Number(((1 - ratio) * 100).toFixed(1)),
        },
        'compress.done',
      );
    },
    { connection: queueConnection, concurrency: config.COMPRESS_CONCURRENCY },
  );

  wireFailureHandler(worker, 'compress');
  logger.info({ concurrency: config.COMPRESS_CONCURRENCY }, 'compress.worker.started');
  return worker;
}
