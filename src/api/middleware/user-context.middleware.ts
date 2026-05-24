/**
 * Pseudo-auth: every request carries a userId.
 *
 * - Reads `x-user-id` header, falls back to a `demo-user`.
 * - When real auth is added, this middleware is the only thing that changes:
 *   parse the JWT, set req.userId, leave the rest of the app untouched.
 */
import type { RequestHandler } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId: string;
    }
  }
}

export const userContext: RequestHandler = (req, _res, next) => {
  const fromHeader = req.header('x-user-id');
  req.userId = typeof fromHeader === 'string' && fromHeader.trim() ? fromHeader.trim() : 'demo-user';
  next();
};
