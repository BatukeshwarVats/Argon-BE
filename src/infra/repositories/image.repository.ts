/**
 * Data access for the Image aggregate.
 *
 * - The only place Prisma calls for `Image` live.
 * - Returns plain typed records (not Prisma's runtime types) where it matters
 *   for the domain, but for this assignment we let Prisma's generated types
 *   flow through since they already match the Image entity 1:1.
 */
import type { Image, ImageStatus } from '@prisma/client';
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
}

export const imageRepository = new ImageRepository();
