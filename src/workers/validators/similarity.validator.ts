/**
 * SimilarityValidator — rejects images near-duplicate to an existing accepted one.
 *
 * - Computes the pHash on the working buffer.
 * - Scans this user's previously-ACCEPTED hashes; flags if Hamming distance
 *   to any of them is ≤ threshold (default 5).
 * - Stashes the computed hash on the context so the worker can persist it
 *   (whether or not the image is ultimately accepted).
 *
 * Scale note:
 *   N-vs-N comparison is fine to ~10k images per user.
 *   Beyond that we should:
 *     - move the hash store into pgvector (binary embedding + cosine), OR
 *     - bucket hashes by their prefix and only compare same-bucket entries.
 */
import type { IValidator, ValidationContext, ValidatorResult } from './validator.interface';
import { RejectionCode } from '../../shared/rejection-codes';
import { config } from '../../config';
import { computePerceptualHash, hammingDistance } from '../processors/phash';
import { imageRepository } from '../../infra/repositories/image.repository';

export class SimilarityValidator implements IValidator {
  readonly name = 'SimilarityValidator';

  async validate(ctx: ValidationContext): Promise<ValidatorResult> {
    const hash = await computePerceptualHash(ctx.buffer);
    ctx.perceptualHash = hash;

    const existing = await imageRepository.listAcceptedHashes(ctx.userId, ctx.imageId);

    for (const row of existing) {
      const d = hammingDistance(hash, row.perceptualHash);
      if (d <= config.SIMILARITY_HAMMING_THRESHOLD) {
        return {
          passed: false,
          reason: {
            code: RejectionCode.DUPLICATE_IMAGE,
            message: `Image is too similar to an existing one (hamming distance ${d})`,
            meta: { matchedImageId: row.id, distance: d, threshold: config.SIMILARITY_HAMMING_THRESHOLD },
          },
        };
      }
    }

    return { passed: true };
  }
}
