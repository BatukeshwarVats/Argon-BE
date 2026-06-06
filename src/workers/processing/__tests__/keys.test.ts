/**
 * The deterministic S3 key layout is half of the idempotency guarantee:
 * the same (userId, imageId, kind) must always map to the same key, so a
 * reprocess overwrites in place instead of creating new objects.
 */
import { describe, it, expect } from 'vitest';
import { normalizedKey, compressedKey, variantKey } from '../keys';

describe('deterministic S3 keys', () => {
  const userId = 'demo-user';
  const imageId = '11111111-1111-1111-1111-111111111111';

  it('are stable across calls (idempotent overwrite target)', () => {
    expect(normalizedKey(userId, imageId)).toBe(normalizedKey(userId, imageId));
    expect(compressedKey(userId, imageId)).toBe(compressedKey(userId, imageId));
    expect(variantKey(userId, imageId, 'WEB')).toBe(variantKey(userId, imageId, 'WEB'));
  });

  it('lay out under a per-image prefix', () => {
    const prefix = `users/${userId}/${imageId}`;
    expect(normalizedKey(userId, imageId)).toBe(`${prefix}/normalized.jpg`);
    expect(compressedKey(userId, imageId)).toBe(`${prefix}/compressed.jpg`);
    expect(variantKey(userId, imageId, 'THUMBNAIL')).toBe(`${prefix}/variants/thumbnail.jpg`);
    expect(variantKey(userId, imageId, 'WEB')).toBe(`${prefix}/variants/web.jpg`);
    expect(variantKey(userId, imageId, 'FULL')).toBe(`${prefix}/variants/full.jpg`);
  });

  it('give a distinct key per variant type', () => {
    const keys = new Set([
      variantKey(userId, imageId, 'THUMBNAIL'),
      variantKey(userId, imageId, 'WEB'),
      variantKey(userId, imageId, 'FULL'),
    ]);
    expect(keys.size).toBe(3);
  });
});
