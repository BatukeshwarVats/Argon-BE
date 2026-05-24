/**
 * FormatValidator
 *
 * - Sniffs magic bytes to confirm the file is genuinely a JPEG/PNG/HEIC.
 * - If it's HEIC, converts to JPEG *inside the pipeline* so later validators
 *   (blur, face detect, pHash) operate on a format sharp can decode.
 * - The converted JPEG is stashed on the context as `displayBuffer` so the
 *   worker can persist it as the "display copy" in S3.
 */
import FileType from 'file-type';
import sharp from 'sharp';
import type { IValidator, ValidationContext, ValidatorResult } from './validator.interface';
import { RejectionCode } from '../../shared/rejection-codes';
import { convertHeicToJpeg, isHeic } from '../processors/heic-converter';

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/heic', 'image/heif']);

export class FormatValidator implements IValidator {
  readonly name = 'FormatValidator';

  async validate(ctx: ValidationContext): Promise<ValidatorResult> {
    const sniffed = await FileType.fromBuffer(ctx.buffer);
    if (!sniffed || !ALLOWED.has(sniffed.mime)) {
      return {
        passed: false,
        reason: {
          code: RejectionCode.UNSUPPORTED_FORMAT,
          message: `Format not supported: ${sniffed?.mime ?? 'unknown'}. Allowed: JPEG, PNG, HEIC.`,
          meta: { detectedMime: sniffed?.mime ?? null },
        },
      };
    }

    ctx.mimeType = sniffed.mime;

    // Transparent HEIC handling: replace working buffer with JPEG, keep
    // original for storage. Downstream code sees only JPEG.
    if (isHeic(sniffed.mime)) {
      try {
        const jpeg = await convertHeicToJpeg(ctx.buffer);
        ctx.buffer = jpeg;
        ctx.mimeType = 'image/jpeg';
        ctx.displayBuffer = jpeg;
        ctx.displayMime = 'image/jpeg';
      } catch (err) {
        return {
          passed: false,
          reason: {
            code: RejectionCode.CORRUPT_FILE,
            message: 'Could not decode HEIC file',
            meta: { error: (err as Error).message },
          },
        };
      }
    }

    // Capture metadata (used by DimensionValidator) so we only decode once.
    try {
      const meta = await sharp(ctx.buffer).metadata();
      ctx.width = meta.width;
      ctx.height = meta.height;
    } catch {
      return {
        passed: false,
        reason: { code: RejectionCode.CORRUPT_FILE, message: 'Could not decode image' },
      };
    }

    return { passed: true };
  }
}
