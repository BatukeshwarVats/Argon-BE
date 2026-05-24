/**
 * Stable, machine-readable codes for every reason a validator can reject an image.
 *
 * - The frontend should branch on `code`, never the human-readable `message`.
 * - Adding a new validator? Add its code(s) here so they appear in the API contract.
 */

export const RejectionCode = {
  UNSUPPORTED_FORMAT: 'UNSUPPORTED_FORMAT',
  FILE_TOO_SMALL_BYTES: 'FILE_TOO_SMALL_BYTES',
  RESOLUTION_TOO_LOW: 'RESOLUTION_TOO_LOW',
  IMAGE_TOO_BLURRY: 'IMAGE_TOO_BLURRY',
  NO_FACE_DETECTED: 'NO_FACE_DETECTED',
  FACE_TOO_SMALL: 'FACE_TOO_SMALL',
  MULTIPLE_FACES: 'MULTIPLE_FACES',
  DUPLICATE_IMAGE: 'DUPLICATE_IMAGE',
  CORRUPT_FILE: 'CORRUPT_FILE',
} as const;

export type RejectionCode = (typeof RejectionCode)[keyof typeof RejectionCode];

export interface RejectionReason {
  code: RejectionCode;
  message: string;
  meta?: Record<string, unknown>;
}
