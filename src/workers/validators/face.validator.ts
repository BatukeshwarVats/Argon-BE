/**
 * FaceValidator covers three rejection conditions in one pass:
 *
 *   1. No face detected     → NO_FACE_DETECTED
 *   2. Face too small       → FACE_TOO_SMALL   (bbox area / image area < threshold)
 *   3. Multiple faces       → MULTIPLE_FACES
 *
 * Running detection once and branching is much cheaper than three separate
 * passes over the same image.
 *
 * Order of checks (matches typical user expectation): count → size.
 *   - "No face" is more useful than "face too small" if both are true.
 *   - "Multiple faces" wins over "face too small" if multiple faces present.
 */
import type { IValidator, ValidationContext, ValidatorResult } from './validator.interface';
import { RejectionCode } from '../../shared/rejection-codes';
import { config } from '../../config';
import { detectFaces } from '../processors/face-detector';

export class FaceValidator implements IValidator {
  readonly name = 'FaceValidator';

  async validate(ctx: ValidationContext): Promise<ValidatorResult> {
    if (!ctx.width || !ctx.height) {
      return {
        passed: false,
        reason: { code: RejectionCode.CORRUPT_FILE, message: 'Missing dimensions for face check' },
      };
    }

    const faces = await detectFaces(ctx.buffer);

    if (faces.length === 0) {
      return {
        passed: false,
        reason: {
          code: RejectionCode.NO_FACE_DETECTED,
          message: 'No face detected in image',
        },
      };
    }

    if (faces.length > config.FACE_MAX_COUNT) {
      return {
        passed: false,
        reason: {
          code: RejectionCode.MULTIPLE_FACES,
          message: `Multiple faces detected (${faces.length}); only ${config.FACE_MAX_COUNT} allowed`,
          meta: { count: faces.length, limit: config.FACE_MAX_COUNT },
        },
      };
    }

    // Use the largest face for the size check (handles the rare case where
    // face-api returns more than one despite limit=1 elsewhere).
    const imageArea = ctx.width * ctx.height;
    const largest = faces.reduce((a, b) =>
      a.width * a.height >= b.width * b.height ? a : b,
    );
    const ratio = (largest.width * largest.height) / imageArea;

    if (ratio < config.FACE_MIN_AREA_RATIO) {
      return {
        passed: false,
        reason: {
          code: RejectionCode.FACE_TOO_SMALL,
          message: `Face is too small (${(ratio * 100).toFixed(1)}% of image; minimum ${(config.FACE_MIN_AREA_RATIO * 100).toFixed(1)}%)`,
          meta: {
            faceArea: largest.width * largest.height,
            imageArea,
            ratio,
            threshold: config.FACE_MIN_AREA_RATIO,
          },
        },
      };
    }

    return { passed: true };
  }
}
