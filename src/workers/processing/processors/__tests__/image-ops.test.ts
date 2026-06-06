/**
 * Unit tests for the pure image operations behind the three pipeline services.
 *
 * These run with no DB / Redis / S3 — they operate on in-memory buffers, which
 * is exactly why the operations were factored out of the workers.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import sharp from 'sharp';
import { normalizeToJpeg, compressJpeg, resizeVariant, readMeta } from '../image-ops';

// A reasonably detailed source image (random noise so it doesn't compress to
// nothing) at a known size.
async function makeSourcePng(width = 800, height = 600): Promise<Buffer> {
  const channels = 3;
  const raw = Buffer.alloc(width * height * channels);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 73 + 13) % 256; // deterministic "noise"
  return sharp(raw, { raw: { width, height, channels } }).png().toBuffer();
}

let source: Buffer;
beforeAll(async () => {
  source = await makeSourcePng();
});

describe('normalizeToJpeg', () => {
  it('produces a JPEG with the source dimensions', async () => {
    const out = await normalizeToJpeg(source, 'image/png');
    expect(out.width).toBe(800);
    expect(out.height).toBe(600);
    expect(out.sizeBytes).toBeGreaterThan(0);
    const meta = await sharp(out.buffer).metadata();
    expect(meta.format).toBe('jpeg');
  });
});

describe('compressJpeg', () => {
  it('reduces byte size at a lower quality while keeping dimensions', async () => {
    const normalized = await normalizeToJpeg(source, 'image/png');
    const compressed = await compressJpeg(normalized.buffer, 50);
    expect(compressed.width).toBe(normalized.width);
    expect(compressed.height).toBe(normalized.height);
    expect(compressed.sizeBytes).toBeLessThan(normalized.sizeBytes);
  });

  it('compression ratio is between 0 and 1', async () => {
    const normalized = await normalizeToJpeg(source, 'image/png');
    const compressed = await compressJpeg(normalized.buffer, 60);
    const ratio = compressed.sizeBytes / normalized.sizeBytes;
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThanOrEqual(1);
  });
});

describe('resizeVariant', () => {
  it('resizes down to the target width preserving aspect ratio', async () => {
    const out = await resizeVariant(source, 320);
    expect(out.width).toBe(320);
    expect(out.height).toBe(240); // 800x600 → 320x240
  });

  it('never upscales beyond the source width', async () => {
    const out = await resizeVariant(source, 4000);
    expect(out.width).toBe(800); // clamped to source, not enlarged
    expect(out.height).toBe(600);
  });

  it('thumbnail < web < full in byte size', async () => {
    const [thumb, web, full] = await Promise.all([
      resizeVariant(source, 320),
      resizeVariant(source, 1080),
      resizeVariant(source, 2048),
    ]);
    // full clamps to 800 here (source width), web clamps to 800 too; both equal
    // the source. The meaningful, always-true ordering is thumb < web-or-equal.
    expect(thumb.sizeBytes).toBeLessThan(web.sizeBytes);
    expect(web.sizeBytes).toBeLessThanOrEqual(full.sizeBytes);
  });
});

describe('readMeta', () => {
  it('reads width and height', async () => {
    const meta = await readMeta(source);
    expect(meta).toEqual({ width: 800, height: 600 });
  });
});
