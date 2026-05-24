/**
 * One validator per rule, each implementing this Strategy interface.
 *
 * - The pipeline iterates over validators in declared order (cheap → expensive).
 * - Validators receive a mutable `ValidationContext` so they can:
 *     a) read prior validators' results (e.g. dimensions from FormatValidator)
 *     b) annotate the context with derived state (e.g. perceptual hash)
 *     c) replace the working buffer (HEIC → JPEG conversion)
 */
import type { RejectionReason } from '../../shared/rejection-codes';

export interface ValidationContext {
  imageId: string;
  userId: string;
  // The buffer being validated. Mutable — converters can replace it.
  buffer: Buffer;
  mimeType: string;
  // Filled in by FormatValidator + DimensionValidator.
  width?: number;
  height?: number;
  // Set by the (eventual) pHash step; SimilarityValidator consumes it.
  perceptualHash?: string;
  // If a converter ran (HEIC→JPEG), this is the converted buffer that
  // should be persisted as the display copy. Workers upload it to S3.
  displayBuffer?: Buffer;
  displayMime?: string;
}

export interface ValidatorResult {
  passed: boolean;
  reason?: RejectionReason;
}

export interface IValidator {
  readonly name: string;
  validate(ctx: ValidationContext): Promise<ValidatorResult>;
}
