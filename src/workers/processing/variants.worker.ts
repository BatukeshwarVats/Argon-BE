/**
 * Variant-generation service (pipeline stage 3, terminal).
 *
 * Produces three sized JPEGs — THUMBNAIL / WEB / FULL — from the compressed
 * image, uploads each to a deterministic key, and upserts a Variant row per
 * size. Then marks the image COMPLETED.
 *
 * Idempotency: deterministic keys (overwrite the same object) + upsert on the
 * unique (imageId, type) constraint (overwrite the same row). Re-running this
 * stage any number of times yields exactly three variants — never duplicates.
 */
import { Worker, type Job } from 'bullmq';
import type { VariantType } from '@prisma/client';
import {
  PIPELINE_QUEUES,
  queueConnection,
  type PipelineJobPayload,
} from '../../infra/queue/pipeline-queues';
import { imageRepository } from '../../infra/repositories/image.repository';
import type { IStorageAdapter } from '../../infra/storage/storage.interface';
import { config } from '../../config';
import { logger } from '../../shared/logger';
import { eventBus } from '../../shared/events';
import { resizeVariant } from './processors/image-ops';
import { variantKey } from './keys';
import { wireFailureHandler } from './conversion.worker';

interface VariantSpec {
  type: VariantType;
  width: number;
}

function variantSpecs(): VariantSpec[] {
  return [
    { type: 'THUMBNAIL', width: config.VARIANT_THUMB_WIDTH },
    { type: 'WEB', width: config.VARIANT_WEB_WIDTH },
    { type: 'FULL', width: config.VARIANT_FULL_WIDTH },
  ];
}

export function startVariantsWorker(storage: IStorageAdapter): Worker<PipelineJobPayload> {
  const worker = new Worker<PipelineJobPayload>(
    PIPELINE_QUEUES.variants,
    async (job: Job<PipelineJobPayload>) => {
      const { imageId } = job.data;
      const row = await imageRepository.findById(imageId);
      if (!row) {
        logger.warn({ imageId }, 'variants.missing_row');
        return;
      }
      // Prefer the compressed image as the source; fall back to normalized.
      const sourceKey = row.compressedKey ?? row.normalizedKey;
      if (!sourceKey) {
        throw new Error('variants stage reached without a processed source image');
      }

      await imageRepository.setStatus(imageId, 'PROCESSING_VARIANTS');
      eventBus.emitStatus({
        imageId,
        userId: row.userId,
        status: 'PROCESSING_VARIANTS',
        at: new Date().toISOString(),
      });

      const source = await storage.getObject(sourceKey);

      // Generate the three sizes concurrently — independent CPU work.
      await Promise.all(
        variantSpecs().map(async (spec) => {
          const out = await resizeVariant(source, spec.width);
          const key = variantKey(row.userId, imageId, spec.type);
          await storage.putObject({
            key,
            body: out.buffer,
            contentType: 'image/jpeg',
            cacheControl: 'public, max-age=31536000, immutable',
          });
          await imageRepository.upsertVariant({
            imageId,
            type: spec.type,
            s3Key: key,
            width: out.width,
            height: out.height,
            sizeBytes: out.sizeBytes,
          });
        }),
      );

      const completed = await imageRepository.markCompleted(imageId);
      eventBus.emitStatus({
        imageId,
        userId: completed.userId,
        status: 'COMPLETED',
        at: completed.updatedAt.toISOString(),
      });

      logger.info({ imageId, variants: variantSpecs().map((s) => s.type) }, 'variants.done');
    },
    { connection: queueConnection, concurrency: config.VARIANTS_CONCURRENCY },
  );

  wireFailureHandler(worker, 'variants');
  logger.info({ concurrency: config.VARIANTS_CONCURRENCY }, 'variants.worker.started');
  return worker;
}
