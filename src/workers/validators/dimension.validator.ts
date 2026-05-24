/**
 * DimensionValidator — reject images that are too small in bytes OR resolution.
 *
 * - Two checks (byte size + pixel resolution) live in one validator because
 *   they share a motivation ("the user uploaded a thumbnail-sized image").
 * - Thresholds are configurable via env so we can tune per environment.
 */
import type { IValidator, ValidationContext, ValidatorResult } from './validator.interface';
import { RejectionCode } from '../../shared/rejection-codes';
import { config } from '../../config';

export class DimensionValidator implements IValidator {
  readonly name = 'DimensionValidator';

  async validate(ctx: ValidationContext): Promise<ValidatorResult> {
    if (ctx.buffer.length < config.MIN_FILE_BYTES) {
      return {
        passed: false,
        reason: {
          code: RejectionCode.FILE_TOO_SMALL_BYTES,
          message: `File is too small (${ctx.buffer.length} bytes < ${config.MIN_FILE_BYTES})`,
          meta: { bytes: ctx.buffer.length, threshold: config.MIN_FILE_BYTES },
        },
      };
    }

    const { width, height } = ctx;
    if (!width || !height) {
      return {
        passed: false,
        reason: { code: RejectionCode.CORRUPT_FILE, message: 'Could not read image dimensions' },
      };
    }

    if (width < config.MIN_WIDTH || height < config.MIN_HEIGHT) {
      return {
        passed: false,
        reason: {
          code: RejectionCode.RESOLUTION_TOO_LOW,
          message: `Resolution too low: ${width}×${height} (minimum ${config.MIN_WIDTH}×${config.MIN_HEIGHT})`,
          meta: { width, height, minWidth: config.MIN_WIDTH, minHeight: config.MIN_HEIGHT },
        },
      };
    }

    return { passed: true };
  }
}
