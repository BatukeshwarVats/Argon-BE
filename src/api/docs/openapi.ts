/**
 * Loads the OpenAPI 3.1 spec from `docs/api-contract.yaml` once at boot.
 *
 * - Single source of truth: the YAML lives next to the README and ships in the
 *   repo. The API serves it as JSON (`/openapi.json`) and renders it via
 *   Swagger UI (`/docs`).
 * - At runtime we patch the `servers[].url` to whatever the API is actually
 *   bound to, so "Try it out" in Swagger UI hits the correct origin even when
 *   the spec was authored for localhost.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { config } from '../../config';

const CONTRACT_PATH = path.resolve(process.cwd(), 'docs/api-contract.yaml');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cached: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadOpenApiSpec(): any {
  if (cached) return cached;

  let raw: string;
  try {
    raw = fs.readFileSync(CONTRACT_PATH, 'utf8');
  } catch (err) {
    throw new Error(
      `OpenAPI contract missing at ${CONTRACT_PATH}: ${(err as Error).message}`,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc = yaml.load(raw) as any;

  // Override `servers` so Swagger UI's "Try it out" targets the real bind.
  doc.servers = [
    {
      url: `http://localhost:${config.PORT}`,
      description: `Local (NODE_ENV=${config.NODE_ENV})`,
    },
  ];

  cached = doc;
  return cached;
}
