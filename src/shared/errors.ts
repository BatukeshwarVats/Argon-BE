/**
 * Domain error hierarchy.
 *
 * - Every error has a stable `code` (machine-readable, for clients & logs)
 *   and an HTTP status (used by the error middleware to set the response).
 * - Throw these from services/controllers; the middleware translates them.
 */

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super('VALIDATION_ERROR', message, 400, details);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super('NOT_FOUND', `${resource} not found: ${id}`, 404, { resource, id });
  }
}

export class UnsupportedMediaError extends AppError {
  constructor(mime: string) {
    super(
      'UNSUPPORTED_MEDIA_TYPE',
      `Unsupported media type: ${mime}. Allowed: image/jpeg, image/png, image/heic, image/heif.`,
      415,
      { mime },
    );
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(limit: number) {
    super('PAYLOAD_TOO_LARGE', `File exceeds maximum size of ${limit} bytes`, 413, { limit });
  }
}
