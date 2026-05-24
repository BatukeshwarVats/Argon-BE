/**
 * Documentation routes.
 *
 *   GET /openapi.json   — raw OpenAPI 3.1 spec (machine-readable)
 *   GET /openapi.yaml   — same spec in YAML (convenient for FE codegen)
 *   GET /docs           — Swagger UI rendered against /openapi.json
 *
 * Mounted at the app root so they're easy to discover.
 */
import { Router } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import swaggerUi from 'swagger-ui-express';
import { loadOpenApiSpec } from '../docs/openapi';

export function buildDocsRouter(): Router {
  const router = Router();
  const spec = loadOpenApiSpec();

  router.get('/openapi.json', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=60');
    res.json(spec);
  });

  router.get('/openapi.yaml', (_req, res) => {
    const yamlPath = path.resolve(process.cwd(), 'docs/api-contract.yaml');
    res.set('Content-Type', 'application/yaml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=60');
    fs.createReadStream(yamlPath).pipe(res);
  });

  router.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(spec, {
      customSiteTitle: 'Argon-BE — API Reference',
      explorer: false,
      swaggerOptions: {
        persistAuthorization: true,
        displayRequestDuration: true,
        defaultModelsExpandDepth: 1,
        defaultModelExpandDepth: 2,
        docExpansion: 'list',
        tryItOutEnabled: true,
        // Pre-fill the x-user-id header in "Try it out" so people don't have
        // to type it for every request.
        requestInterceptor: (req: { headers: Record<string, string> }) => {
          if (!req.headers['x-user-id']) {
            req.headers['x-user-id'] = 'demo-user';
          }
          return req;
        },
      },
    }),
  );

  return router;
}
