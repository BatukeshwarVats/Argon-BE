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
import type { Image, ImageStatus } from '@prisma/client';
import { config } from '../../config';
import { ImageRepository } from '../../infra/repositories/image.repository';
import type { IStorageAdapter } from '../../infra/storage/storage.interface';
import { imageQueue } from '../../infra/queue/queue';
import { UnsupportedMediaError, NotFoundError, PayloadTooLargeError } from '../../shared/errors';
import { logger } from '../../shared/logger';

const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/heic', 'image/heif']);

export interface UploadImageInput {
  userId: string;
  originalName: string;
  buffer: Buffer;
  declaredMime: string;
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

  async getById(id: string): Promise<Image> {
    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundError('Image', id);
    return row;
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

  /**
   * Convert a DB row into the public-facing view, including presigned S3 URLs.
   * Controllers should always go through this so we don't leak internal keys.
   */
  async toView(row: Image): Promise<ImageView> {
    const [originalUrl, displayUrl] = await Promise.all([
      this.storage.getSignedUrl(row.s3KeyOriginal, config.SIGNED_URL_TTL_SECONDS),
      row.s3KeyDisplay
        ? this.storage.getSignedUrl(row.s3KeyDisplay, config.SIGNED_URL_TTL_SECONDS)
        : Promise.resolve(null),
    ]);

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
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
