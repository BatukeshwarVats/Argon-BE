/**
 * Express app factory.
 *
 * Kept separate from `server.ts` so we can mount the app inside tests
 * without binding to a port.
 */
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config';
import { buildContainer } from './shared/container';
import { buildImagesRouter } from './api/routes/images.routes';
import { buildDocsRouter } from './api/routes/docs.routes';
import { userContext } from './api/middleware/user-context.middleware';
import { errorHandler, notFoundHandler } from './api/middleware/error.middleware';
import { logger } from './shared/logger';

export function buildApp() {
  const app = express();
  const container = buildContainer();

  app.disable('x-powered-by');
  // Disable CSP because (a) we only serve JSON elsewhere, and (b) Swagger UI
  // at /docs needs inline scripts/styles. We keep every other helmet protection.
  app.use(
    helmet({
      crossOriginResourcePolicy: false,
      contentSecurityPolicy: false,
    }),
  );
  app.use(
    cors({
      origin: config.CORS_ORIGIN.split(',').map((s) => s.trim()),
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '256kb' }));
  app.use(userContext);

  // Per-IP rate limiter on writes. Read endpoints are cheap, no limiter.
  const writeLimiter = rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use(['/api/images'], (req, res, next) =>
    req.method === 'GET' ? next() : writeLimiter(req, res, next),
  );

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // Public API docs — Swagger UI + raw spec.
  app.use('/', buildDocsRouter());

  app.use('/api/images', buildImagesRouter(container));

  // Light request log — Pino transport keeps it pretty in dev.
  app.use((req, _res, next) => {
    logger.debug({ method: req.method, path: req.path }, 'request');
    next();
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
