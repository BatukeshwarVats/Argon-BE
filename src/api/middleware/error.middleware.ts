/**
 * Central error handler.
 *
 * - Maps AppError subclasses to their HTTP code + a stable JSON shape.
 * - Unknown errors → 500 with a generic message (never leak internals).
 *
 * Response shape:
 *   { error: { code, message, details? } }
 */
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError } from '../../shared/errors';
import { logger } from '../../shared/logger';
import { MulterError } from 'multer';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `Route not found: ${req.method} ${req.path}`,
    },
  });
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof AppError) {
    logger.warn({ err: { code: err.code, status: err.status }, path: req.path }, 'request.app_error');
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  if (err instanceof MulterError) {
    const map: Record<string, { status: number; code: string }> = {
      LIMIT_FILE_SIZE: { status: 413, code: 'PAYLOAD_TOO_LARGE' },
      LIMIT_UNEXPECTED_FILE: { status: 400, code: 'UNEXPECTED_FILE_FIELD' },
    };
    const m = map[err.code] ?? { status: 400, code: 'BAD_UPLOAD' };
    res.status(m.status).json({ error: { code: m.code, message: err.message } });
    return;
  }

  logger.error({ err, path: req.path }, 'request.unhandled_error');
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
  });
};
