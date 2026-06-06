/**
 * Pure image operations used by the three pipeline services.
 *
 * These are deterministic, side-effect-free functions over Buffers — no S3, no
 * DB, no queue. That keeps them trivially unit-testable (see
 * src/workers/processing/processors/__tests__) and is what lets the workers
 * stay thin orchestrators.
 *
 * All three stages standardise on JPEG. `sharp` is libvips-backed and releases
 * the event loop during native work, so these scale well under worker
 * concurrency.
 */
import sharp from 'sharp';
import { isHeic, convertHeicToJpeg } from '../../processors/heic-converter';

export interface ImageMeta {
  width: number;
  height: number;
}

export interface ProcessedImage {
  buffer: Buffer;
  width: number;
  height: number;
  sizeBytes: number;
}

/**
 * Conversion service core: normalise any supported input into a canonical
 * JPEG. Auto-orients via EXIF (so rotated phone photos come out upright) and
 * flattens onto white (JPEG has no alpha). HEIC is decoded first since some
 * libvips builds can't read it directly.
 */
export async function normalizeToJpeg(input: Buffer, mimeType: string): Promise<ProcessedImage> {
  let working = input;
  if (isHeic(mimeType)) {
    working = await convertHeicToJpeg(input);
  }

  const { data, info } = await sharp(working)
    .rotate() // apply EXIF orientation, then strip it
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .jpeg({ quality: 95 }) // near-lossless at this stage; compression happens next
    .toBuffer({ resolveWithObject: true });

  return { buffer: data, width: info.width, height: info.height, sizeBytes: data.length };
}

/**
 * Compression service core: re-encode the normalised JPEG at a target quality
 * using mozjpeg (better quality-per-byte than baseline) with a progressive
 * scan. Strips metadata to shave more bytes.
 */
export async function compressJpeg(input: Buffer, quality: number): Promise<ProcessedImage> {
  const { data, info } = await sharp(input)
    .jpeg({ quality, mozjpeg: true, progressive: true })
    .toBuffer({ resolveWithObject: true });

  return { buffer: data, width: info.width, height: info.height, sizeBytes: data.length };
}

/**
 * Variant service core: resize to a target width (long-edge), preserving aspect
 * ratio and never upscaling beyond the source. Returns the encoded JPEG plus
 * its real dimensions (which may be smaller than `targetWidth` for small
 * sources, since `withoutEnlargement` is on).
 */
export async function resizeVariant(input: Buffer, targetWidth: number): Promise<ProcessedImage> {
  const { data, info } = await sharp(input)
    .resize({ width: targetWidth, withoutEnlargement: true })
    .jpeg({ quality: 80, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  return { buffer: data, width: info.width, height: info.height, sizeBytes: data.length };
}

/** Cheap metadata read — used to record source dimensions when needed. */
export async function readMeta(input: Buffer): Promise<ImageMeta> {
  const meta = await sharp(input).metadata();
  return { width: meta.width ?? 0, height: meta.height ?? 0 };
}
