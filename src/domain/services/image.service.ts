/**
 * ImageService — orchestrates the upload flow.
 *
 *   1. Client posts multipart → controller hands buffer to this service.
 *   2. Service uploads to S3, persists metadata row (PENDING),
 *      enqueues a job, returns the row.
 *   3. Worker dequeues, runs the validation pipeline, mutates row to ACCEPTED/REJECTED.
 *
 * Keeps controllers thin and the worker side completely separate.
 */
import FileType from 'file-type';
import { v4 as uuid } from 'uuid';
import type { Image, ImageStatus, Variant, VariantType } from '@prisma/client';
import { config } from '../../config';
import { ImageRepository } from '../../infra/repositories/image.repository';
import type { IStorageAdapter } from '../../infra/storage/storage.interface';
import { imageQueue } from '../../infra/queue/queue';
import { enqueueConvert } from '../../infra/queue/pipeline-queues';
import { UnsupportedMediaError, NotFoundError, PayloadTooLargeError } from '../../shared/errors';
import { logger } from '../../shared/logger';

const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/heic', 'image/heif']);

export interface UploadImageInput {
  userId: string;
  originalName: string;
  buffer: Buffer;
  declaredMime: string;
}

export interface VariantView {
  type: VariantType;
  url: string;
  width: number;
  height: number;
  sizeBytes: number;
}

export interface ImageView {
  id: string;
  userId: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  status: ImageStatus;
  rejectionReasons: unknown;
  originalUrl: string;
  displayUrl: string | null;
  // ── Media pipeline (Part 2) ──
  processingError: string | null;
  compression: { compressedBytes: number; ratio: number; savedPct: number } | null;
  variants: VariantView[];
  createdAt: string;
  updatedAt: string;
}

export class ImageService {
  constructor(
    private readonly repo: ImageRepository,
    private readonly storage: IStorageAdapter,
  ) {}

  /**
   * Accepts an uploaded file: validates type/size at the boundary,
   * uploads to S3, persists metadata, enqueues for async validation.
   *
   * Returns the persisted row (status PENDING).
   */
  async upload(input: UploadImageInput): Promise<Image> {
    if (input.buffer.length > config.UPLOAD_MAX_BYTES) {
      throw new PayloadTooLargeError(config.UPLOAD_MAX_BYTES);
    }

    // Sniff the actual MIME from bytes — never trust the client header.
    const sniffed = await FileType.fromBuffer(input.buffer);
    const mime = sniffed?.mime ?? input.declaredMime;
    if (!ALLOWED_MIMES.has(mime)) {
      throw new UnsupportedMediaError(mime);
    }

    // Same UUID for DB id and S3 key — keeps the two stores trivially correlatable.
    const id = uuid();
    const ext = sniffed?.ext ?? 'bin';
    const s3KeyOriginal = `users/${input.userId}/originals/${id}.${ext}`;

    await this.storage.putObject({
      key: s3KeyOriginal,
      body: input.buffer,
      contentType: mime,
    });

    const row = await this.repo.create({
      id,
      userId: input.userId,
      originalName: input.originalName,
      mimeType: mime,
      sizeBytes: input.buffer.length,
      s3KeyOriginal,
    });

    await imageQueue.add('validate', { imageId: row.id }, { jobId: row.id });
    logger.info({ imageId: row.id, mime, bytes: input.buffer.length }, 'image.uploaded');
    return row;
  }

  /**
   * Load-test seed path: store the original and inject the image directly into
   * the media-processing pipeline (status ACCEPTED → convert), skipping the
   * face/blur/duplicate validators.
   *
   * Why a separate path? The processing pipeline is what Part 2 scales, and we
   * want to load-test *it* in isolation. Routing through face validation would
   * make throughput a function of TinyFaceDetector, not the three services —
   * and synthetic load images have no real faces. Guarded to non-production.
   */
  async seedForPipeline(input: UploadImageInput): Promise<Image> {
    if (input.buffer.length > config.UPLOAD_MAX_BYTES) {
      throw new PayloadTooLargeError(config.UPLOAD_MAX_BYTES);
    }
    const sniffed = await FileType.fromBuffer(input.buffer);
    const mime = sniffed?.mime ?? input.declaredMime;
    if (!ALLOWED_MIMES.has(mime)) throw new UnsupportedMediaError(mime);

    const id = uuid();
    const ext = sniffed?.ext ?? 'bin';
    const s3KeyOriginal = `users/${input.userId}/originals/${id}.${ext}`;

    await this.storage.putObject({ key: s3KeyOriginal, body: input.buffer, contentType: mime });

    const row = await this.repo.create({
      id,
      userId: input.userId,
      originalName: input.originalName,
      mimeType: mime,
      sizeBytes: input.buffer.length,
      s3KeyOriginal,
      status: 'ACCEPTED',
    });

    await enqueueConvert(row.id);
    logger.info({ imageId: row.id, mime, bytes: input.buffer.length }, 'image.seeded');
    return row;
  }

  /**
   * Re-run the media pipeline for an image from the top. Idempotent: produces
   * the same three variants (overwriting in place), never duplicates.
   */
  async reprocess(id: string): Promise<Image> {
    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundError('Image', id);
    await this.repo.setStatus(id, 'PROCESSING_CONVERT');
    await enqueueConvert(id, { fresh: true });
    logger.info({ imageId: id }, 'image.reprocess.enqueued');
    return row;
  }

  async getById(id: string): Promise<Image> {
    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundError('Image', id);
    return row;
  }

  async getVariants(id: string): Promise<VariantView[]> {
    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundError('Image', id);
    const variants = await this.repo.listVariants(id);
    return this.toVariantViews(variants);
  }

  list(params: { userId: string; status?: ImageStatus; limit?: number; cursor?: string }) {
    return this.repo.list({
      userId: params.userId,
      status: params.status,
      limit: Math.min(params.limit ?? 24, 100),
      cursor: params.cursor,
    });
  }

  async remove(id: string): Promise<void> {
    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundError('Image', id);

    // Best-effort S3 cleanup. We don't fail the API call if the object is
    // already gone — the DB row is the source of truth for "exists to user".
    await Promise.allSettled([
      this.storage.deleteObject(row.s3KeyOriginal),
      row.s3KeyDisplay ? this.storage.deleteObject(row.s3KeyDisplay) : Promise.resolve(),
    ]);

    await this.repo.delete(id);
  }

  /** Sign a list of Variant rows into presigned view objects. */
  private async toVariantViews(variants: Variant[]): Promise<VariantView[]> {
    return Promise.all(
      variants.map(async (v) => ({
        type: v.type,
        url: await this.storage.getSignedUrl(v.s3Key, config.SIGNED_URL_TTL_SECONDS),
        width: v.width,
        height: v.height,
        sizeBytes: v.sizeBytes,
      })),
    );
  }

  /**
   * Convert a DB row into the public-facing view, including presigned S3 URLs
   * and (if generated) the media-pipeline variants + compression accounting.
   *
   * `variants` may be passed in to avoid an N+1 query when rendering a list;
   * if omitted, they're loaded on demand (used by the single-image endpoints).
   */
  async toView(row: Image, variants?: Variant[]): Promise<ImageView> {
    const variantRows = variants ?? (await this.repo.listVariants(row.id));

    const [originalUrl, displayUrl, variantViews] = await Promise.all([
      this.storage.getSignedUrl(row.s3KeyOriginal, config.SIGNED_URL_TTL_SECONDS),
      row.s3KeyDisplay
        ? this.storage.getSignedUrl(row.s3KeyDisplay, config.SIGNED_URL_TTL_SECONDS)
        : Promise.resolve(null),
      this.toVariantViews(variantRows),
    ]);

    const compression =
      row.compressedBytes != null && row.compressionRatio != null
        ? {
            compressedBytes: row.compressedBytes,
            ratio: row.compressionRatio,
            savedPct: Number(((1 - row.compressionRatio) * 100).toFixed(1)),
          }
        : null;

    return {
      id: row.id,
      userId: row.userId,
      originalName: row.originalName,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      width: row.width,
      height: row.height,
      status: row.status,
      rejectionReasons: row.rejectionReasons ?? null,
      originalUrl,
      displayUrl,
      processingError: row.processingError ?? null,
      compression,
      variants: variantViews,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Bulk row→view for list endpoints: loads variants for every row in a single
   * query, then maps, avoiding an N+1 against the variants table.
   */
  async toViews(rows: Image[]): Promise<ImageView[]> {
    const grouped = await this.repo.listVariantsForImages(rows.map((r) => r.id));
    return Promise.all(rows.map((r) => this.toView(r, grouped.get(r.id) ?? [])));
  }
}
