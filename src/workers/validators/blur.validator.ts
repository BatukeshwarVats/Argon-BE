/**
 * BlurValidator — rejects images whose edges aren't sharp enough.
 *
 * We compute the **variance of the Laplacian** of the greyscale image.
 *   - Sharp images have a wide spread of second-derivative values
 *     (edges of varying intensity).
 *   - Blurry images smooth those out → low variance.
 *
 * The Laplacian kernel:
 *
 *     0  1  0
 *     1 -4  1
 *     0  1  0
 *
 * Threshold ~80 works well on 200×200+ images. Tune via env if needed.
 *
 * We resize to 256px on the long edge first so the metric is comparable
 * across resolutions and the convolution stays cheap.
 */
import sharp from 'sharp';
import type { IValidator, ValidationContext, ValidatorResult } from './validator.interface';
import { RejectionCode } from '../../shared/rejection-codes';
import { config } from '../../config';

export class BlurValidator implements IValidator {
  readonly name = 'BlurValidator';

  async validate(ctx: ValidationContext): Promise<ValidatorResult> {
    const { data, info } = await sharp(ctx.buffer)
      .greyscale()
      .resize({ width: 256, height: 256, fit: 'inside' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const w = info.width;
    const h = info.height;
    let sum = 0;
    let sumSq = 0;
    let count = 0;

    // Skip border pixels; the kernel needs neighbours on all sides.
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const lap =
          data[i - w] +     // top
          data[i + w] +     // bottom
          data[i - 1] +     // left
          data[i + 1] -     // right
          4 * data[i];      // centre
        sum += lap;
        sumSq += lap * lap;
        count++;
      }
    }

    const mean = sum / count;
    const variance = sumSq / count - mean * mean;

    if (variance < config.BLUR_VARIANCE_THRESHOLD) {
      return {
        passed: false,
        reason: {
          code: RejectionCode.IMAGE_TOO_BLURRY,
          message: `Image is too blurry (variance ${variance.toFixed(1)} < ${config.BLUR_VARIANCE_THRESHOLD})`,
          meta: { variance, threshold: config.BLUR_VARIANCE_THRESHOLD },
        },
      };
    }
    return { passed: true };
  }
}
