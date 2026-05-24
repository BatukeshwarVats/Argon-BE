/**
 * HEIC → JPEG conversion.
 *
 * `sharp` cannot always read HEIC (depends on the libvips build), so we
 * decode via `heic-convert` (pure JS) and hand the JPEG buffer to the rest
 * of the pipeline. Downstream validators only ever see JPEG/PNG.
 */
import heicConvert from 'heic-convert';

const HEIC_MIMES = new Set(['image/heic', 'image/heif']);

export function isHeic(mime: string): boolean {
  return HEIC_MIMES.has(mime);
}

export async function convertHeicToJpeg(buffer: Buffer): Promise<Buffer> {
  const out = await heicConvert({
    // heic-convert accepts ArrayBufferLike; Buffer is a Uint8Array view over
    // one, so this cast is safe.
    buffer: buffer as unknown as ArrayBufferLike,
    format: 'JPEG',
    quality: 0.9,
  });
  return Buffer.from(out);
}
