/**
 * Data access for the Image aggregate.
 *
 * - The only place Prisma calls for `Image` live.
 * - Returns plain typed records (not Prisma's runtime types) where it matters
 *   for the domain, but for this assignment we let Prisma's generated types
 *   flow through since they already match the Image entity 1:1.
 */
import type { Image, ImageStatus, Variant, VariantType } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import type { RejectionReason } from '../../shared/rejection-codes';

export interface CreateImageInput {
  id: string;
  userId: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  s3KeyOriginal: string;
  // Optional initial status. Defaults to PENDING (validation path); the
  // load-test seed path passes ACCEPTED to inject straight into the pipeline.
  status?: ImageStatus;
}

export interface ListImagesParams {
  userId: string;
  status?: ImageStatus;
  limit: number;
  cursor?: string; // image id for keyset pagination
}

export class ImageRepository {
  create(input: CreateImageInput): Promise<Image> {
    return prisma.image.create({ data: input });
  }

  findById(id: string): Promise<Image | null> {
    return prisma.image.findUnique({ where: { id } });
  }

  /**
   * Keyset pagination by createdAt (descending) for efficient list views.
   * The compound index (userId, status, createdAt DESC) is hit directly.
   */
  async list({ userId, status, limit, cursor }: ListImagesParams): Promise<Image[]> {
    return prisma.image.findMany({
      where: { userId, ...(status && { status }) },
      orderBy: { createdAt: 'desc' },
      take: limit,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    });
  }

  delete(id: string): Promise<Image> {
    return prisma.image.delete({ where: { id } });
  }

  markProcessing(id: string): Promise<Image> {
    return prisma.image.update({
      where: { id },
      data: { status: 'PROCESSING' },
    });
  }

  markAccepted(
    id: string,
    fields: { width: number; height: number; perceptualHash: string; s3KeyDisplay?: string },
  ): Promise<Image> {
    return prisma.image.update({
      where: { id },
      data: {
        status: 'ACCEPTED',
        width: fields.width,
        height: fields.height,
        perceptualHash: fields.perceptualHash,
        s3KeyDisplay: fields.s3KeyDisplay,
        rejectionReasons: Prisma.JsonNull,
      },
    });
  }

  markRejected(id: string, reasons: RejectionReason[]): Promise<Image> {
    return prisma.image.update({
      where: { id },
      data: {
        status: 'REJECTED',
        rejectionReasons: reasons as unknown as Prisma.InputJsonValue,
      },
    });
  }

  markFailed(id: string, errorMessage: string): Promise<Image> {
    return prisma.image.update({
      where: { id },
      data: {
        status: 'FAILED',
        rejectionReasons: [
          { code: 'INTERNAL_ERROR', message: errorMessage },
        ] as unknown as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * Used by SimilarityValidator: returns hashes of every ACCEPTED image
   * for this user. With ~10k images per user this still fits in memory;
   * past that we'd push the Hamming-distance comparison into Postgres
   * (e.g. pg_similarity, or pgvector with binary embeddings).
   */
  async listAcceptedHashes(userId: string, excludeId: string): Promise<Array<{ id: string; perceptualHash: string }>> {
    const rows = await prisma.image.findMany({
      where: {
        userId,
        status: 'ACCEPTED',
        perceptualHash: { not: null },
        id: { not: excludeId },
      },
      select: { id: true, perceptualHash: true },
    });
    return rows.map((r) => ({ id: r.id, perceptualHash: r.perceptualHash! }));
  }

  // ── Media processing pipeline (Part 2) ──────────────────────────────

  /** Move an image to a pipeline stage status, clearing any prior error. */
  setStatus(id: string, status: ImageStatus): Promise<Image> {
    return prisma.image.update({
      where: { id },
      data: { status, processingError: null },
    });
  }

  /** Conversion stage output (status advances at the next stage's start). */
  setNormalized(id: string, normalizedKey: string): Promise<Image> {
    return prisma.image.update({
      where: { id },
      data: { normalizedKey },
    });
  }

  /** Compression stage output + accounting. */
  setCompressed(
    id: string,
    fields: { compressedKey: string; compressedBytes: number; compressionRatio: number },
  ): Promise<Image> {
    return prisma.image.update({
      where: { id },
      data: {
        compressedKey: fields.compressedKey,
        compressedBytes: fields.compressedBytes,
        compressionRatio: fields.compressionRatio,
      },
    });
  }

  /** Terminal success. */
  markCompleted(id: string): Promise<Image> {
    return prisma.image.update({
      where: { id },
      data: { status: 'COMPLETED', processingError: null },
    });
  }

  /** A pipeline stage failed cleanly — surface the reason, stop the job. */
  markProcessingFailed(id: string, stage: string, errorMessage: string): Promise<Image> {
    return prisma.image.update({
      where: { id },
      data: { status: 'FAILED', processingError: `[${stage}] ${errorMessage}` },
    });
  }

  /**
   * Idempotent variant write. Keyed on the unique (imageId, type) constraint:
   * the first run inserts, every reprocess updates the same row in place. No
   * matter how many times the variant stage runs, there are at most three rows.
   */
  upsertVariant(input: {
    imageId: string;
    type: VariantType;
    s3Key: string;
    width: number;
    height: number;
    sizeBytes: number;
  }): Promise<Variant> {
    const { imageId, type, ...rest } = input;
    return prisma.variant.upsert({
      where: { imageId_type: { imageId, type } },
      create: { imageId, type, ...rest },
      update: rest,
    });
  }

  listVariants(imageId: string): Promise<Variant[]> {
    return prisma.variant.findMany({ where: { imageId }, orderBy: { sizeBytes: 'asc' } });
  }

  /** Bulk-load variants for many images in one query (list view). */
  async listVariantsForImages(imageIds: string[]): Promise<Map<string, Variant[]>> {
    const grouped = new Map<string, Variant[]>();
    if (imageIds.length === 0) return grouped;
    const rows = await prisma.variant.findMany({
      where: { imageId: { in: imageIds } },
      orderBy: { sizeBytes: 'asc' },
    });
    for (const v of rows) {
      const list = grouped.get(v.imageId) ?? [];
      list.push(v);
      grouped.set(v.imageId, list);
    }
    return grouped;
  }
}

export const imageRepository = new ImageRepository();
