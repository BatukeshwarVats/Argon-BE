/**
 * Multer configured for in-memory uploads.
 *
 * - We buffer the file (fits in RAM since UPLOAD_MAX_BYTES is small).
 * - The downstream service streams it to S3, so no disk hop.
 * - For very large files we'd switch to disk storage or signed-URL direct uploads.
 */
import multer from 'multer';
import { config } from '../../config';

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.UPLOAD_MAX_BYTES,
    files: 10,
  },
});
