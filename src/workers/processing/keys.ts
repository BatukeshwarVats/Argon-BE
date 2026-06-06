/**
 * Deterministic S3 key layout for the media pipeline.
 *
 * Keys are a pure function of (userId, imageId, kind). Re-running any stage
 * writes to the *same* key, so a reprocess overwrites the previous object
 * instead of accumulating duplicates — half of our idempotency story (the
 * other half is the unique (imageId, type) row constraint).
 *
 *   users/{userId}/{imageId}/normalized.jpg
 *   users/{userId}/{imageId}/compressed.jpg
 *   users/{userId}/{imageId}/variants/{thumbnail|web|full}.jpg
 */
import type { VariantType } from '@prisma/client';

const base = (userId: string, imageId: string) => `users/${userId}/${imageId}`;

export function normalizedKey(userId: string, imageId: string): string {
  return `${base(userId, imageId)}/normalized.jpg`;
}

export function compressedKey(userId: string, imageId: string): string {
  return `${base(userId, imageId)}/compressed.jpg`;
}

export function variantKey(userId: string, imageId: string, type: VariantType): string {
  return `${base(userId, imageId)}/variants/${type.toLowerCase()}.jpg`;
}
