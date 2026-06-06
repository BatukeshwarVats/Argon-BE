/**
 * Media-processing pipeline queues (Part 2).
 *
 * The processing pipeline is decomposed into THREE independent services, each
 * fronted by its own BullMQ queue:
 *
 *     convert  →  compress  →  variants
 *
 * Why one queue per stage (instead of one queue with internal branching)?
 *   - Each stage is an independently *scalable* consumer: run more `compress`
 *     workers without touching `convert`/`variants`.
 *   - The queue boundary *is* the service boundary — splitting a stage into its
 *     own deployable is mechanical (point its worker at the same Redis).
 *   - Back-pressure and retry policy are tuned per stage.
 *
 * Jobs carry only an `imageId`; every worker is stateless and rehydrates all
 * state it needs from Postgres + S3. That is what makes the workers horizontally
 * scalable — any worker can pick up any job.
 *
 * Idempotency: each stage enqueues the next with a deterministic
 * `jobId = ${imageId}:${stage}`. BullMQ de-duplicates a job id that is still
 * present, so an accidental double-enqueue collapses to one job.
 */
import { Queue, type ConnectionOptions } from 'bullmq';
import { v4 as uuid } from 'uuid';
import { config } from '../../config';

export const queueConnection: ConnectionOptions = {
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
  maxRetriesPerRequest: null,
};

export const PIPELINE_QUEUES = {
  convert: 'pipeline-convert',
  compress: 'pipeline-compress',
  variants: 'pipeline-variants',
} as const;

export type PipelineStage = keyof typeof PIPELINE_QUEUES;

export interface PipelineJobPayload {
  imageId: string;
}

const defaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2_000 },
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 1_000 },
};

export const convertQueue = new Queue<PipelineJobPayload>(PIPELINE_QUEUES.convert, {
  connection: queueConnection,
  defaultJobOptions,
});

export const compressQueue = new Queue<PipelineJobPayload>(PIPELINE_QUEUES.compress, {
  connection: queueConnection,
  defaultJobOptions,
});

export const variantsQueue = new Queue<PipelineJobPayload>(PIPELINE_QUEUES.variants, {
  connection: queueConnection,
  defaultJobOptions,
});

/**
 * Deterministic per-stage job id — the de-dup key that guards idempotency.
 * Note: BullMQ disallows ':' in custom job ids, so we use '__' as the separator.
 */
export function stageJobId(imageId: string, stage: PipelineStage): string {
  return `${imageId}__${stage}`;
}

/**
 * Entry point into the media pipeline.
 *
 * Default (automatic, from validation): deterministic jobId, so an accidental
 * double-enqueue of the same image collapses to one job.
 *
 * `fresh: true` (explicit reprocess): a unique jobId so the job always runs,
 * even though a prior completed job with the deterministic id is still retained.
 * Reprocessing is still safe because the workers are idempotent (deterministic
 * S3 keys + upsert on the unique (imageId, type) constraint) — a reprocess
 * overwrites the same objects/rows rather than duplicating them.
 */
export async function enqueueConvert(
  imageId: string,
  opts: { fresh?: boolean } = {},
): Promise<void> {
  const jobId = opts.fresh
    ? `${stageJobId(imageId, 'convert')}__${uuid()}`
    : stageJobId(imageId, 'convert');
  await convertQueue.add('convert', { imageId }, { jobId });
}

/**
 * Internal stage hand-offs. These deliberately use auto-generated job ids (not
 * deterministic ones): each pipeline *run* must get its own compress/variants
 * jobs, otherwise a reprocess would be de-duped against the retained completed
 * job from the first run and the chain would stall. Re-running is still safe —
 * idempotency is guaranteed downstream by deterministic S3 keys + the upsert on
 * (imageId, type), not by the job id. (A convert retry that re-enqueues compress
 * is likewise safe: it just overwrites the same outputs.)
 */
export async function enqueueCompress(imageId: string): Promise<void> {
  await compressQueue.add('compress', { imageId });
}

export async function enqueueVariants(imageId: string): Promise<void> {
  await variantsQueue.add('variants', { imageId });
}

export async function closePipelineQueues(): Promise<void> {
  await Promise.allSettled([
    convertQueue.close(),
    compressQueue.close(),
    variantsQueue.close(),
  ]);
}
