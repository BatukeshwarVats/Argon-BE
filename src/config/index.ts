/**
 * Typed, validated environment configuration.
 *
 * - Parses .env once at module load.
 * - Throws fast on misconfiguration so we fail at boot, not at request time.
 * - The exported `config` object is the only place env vars are read.
 */
import * as dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),

  DATABASE_URL: z.string().url(),

  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),

  AWS_REGION: z.string().default('us-east-1'),
  AWS_S3_BUCKET: z.string(),
  AWS_S3_ENDPOINT: z.string().optional(),
  AWS_S3_FORCE_PATH_STYLE: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  AWS_ACCESS_KEY_ID: z.string(),
  AWS_SECRET_ACCESS_KEY: z.string(),

  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(15 * 1024 * 1024),
  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(600),

  MIN_WIDTH: z.coerce.number().int().positive().default(200),
  MIN_HEIGHT: z.coerce.number().int().positive().default(200),
  MIN_FILE_BYTES: z.coerce.number().int().positive().default(8 * 1024),
  BLUR_VARIANCE_THRESHOLD: z.coerce.number().positive().default(80),
  FACE_MIN_AREA_RATIO: z.coerce.number().positive().default(0.05),
  FACE_MAX_COUNT: z.coerce.number().int().positive().default(1),
  SIMILARITY_HAMMING_THRESHOLD: z.coerce.number().int().nonnegative().default(5),

  FACE_MODEL_PATH: z.string().default('./models'),

  // ── Media processing pipeline (Part 2) ──
  // Compression: mozjpeg quality (1–100). Lower = smaller file, less quality.
  COMPRESSION_QUALITY: z.coerce.number().int().min(1).max(100).default(72),

  // Variant target widths (px on the long edge). Height auto-scales to preserve
  // aspect ratio; we never upscale past the source.
  VARIANT_THUMB_WIDTH: z.coerce.number().int().positive().default(320),
  VARIANT_WEB_WIDTH: z.coerce.number().int().positive().default(1080),
  VARIANT_FULL_WIDTH: z.coerce.number().int().positive().default(2048),

  // Per-service worker concurrency. Each service is an independent process, so
  // these are tuned separately (compression/variants are CPU-heavier).
  CONVERT_CONCURRENCY: z.coerce.number().int().positive().default(4),
  COMPRESS_CONCURRENCY: z.coerce.number().int().positive().default(4),
  VARIANTS_CONCURRENCY: z.coerce.number().int().positive().default(4),

  // Which pipeline service(s) a worker process should run.
  // "all" (default) runs all three in one process — handy for `npm run dev`.
  // Set to "convert" | "compress" | "variants" to scale a single stage
  // independently (run N processes of just that one).
  PROCESSING_SERVICE: z
    .enum(['all', 'convert', 'compress', 'variants'])
    .default('all'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Print a readable error then die — there's no recovering from bad config.
  // eslint-disable-next-line no-console
  console.error('[config] invalid environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
