/**
 * Builds the default validation pipeline.
 *
 * Order matters — listed cheap → expensive, so we fail fast on bad inputs
 * before paying for face detection or duplicate scanning.
 *
 *   1. Format       — magic-byte sniff + HEIC→JPEG conversion          (cheap)
 *   2. Dimension    — byte size + pixel resolution                     (cheap)
 *   3. Blur         — variance of Laplacian on downscaled greyscale   (medium)
 *   4. Face         — TinyFaceDetector inference                       (heavy)
 *   5. Similarity   — pHash + Hamming scan against user's history      (medium)
 *
 * To add a new rule: implement IValidator, append it here at the appropriate
 * cost tier. No other file needs to change.
 */
import { ValidationPipeline } from './validation-pipeline';
import { FormatValidator } from '../validators/format.validator';
import { DimensionValidator } from '../validators/dimension.validator';
import { BlurValidator } from '../validators/blur.validator';
import { FaceValidator } from '../validators/face.validator';
import { SimilarityValidator } from '../validators/similarity.validator';

export function buildDefaultPipeline(): ValidationPipeline {
  return new ValidationPipeline([
    new FormatValidator(),
    new DimensionValidator(),
    new BlurValidator(),
    new FaceValidator(),
    new SimilarityValidator(),
  ]);
}
