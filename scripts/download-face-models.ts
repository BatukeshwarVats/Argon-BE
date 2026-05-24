/**
 * Download face-api.js models from the official CDN.
 * Idempotent — skips files that already exist.
 *
 * We use:
 *  - tiny_face_detector  (fast, accurate enough for "is there a face + bbox")
 *  - face_landmark_68    (not used today, but keeps the option open for future)
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import * as https from 'https';

const MODEL_URL_BASE =
  'https://raw.githubusercontent.com/vladmandic/face-api/master/model';

const FILES = [
  'tiny_face_detector_model-weights_manifest.json',
  'tiny_face_detector_model.bin',
];

const TARGET_DIR = path.resolve(process.cwd(), process.env.FACE_MODEL_PATH ?? './models');

function download(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return download(res.headers.location, dest).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', async () => {
          await fs.writeFile(dest, Buffer.concat(chunks));
          resolve();
        });
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

async function main() {
  await fs.mkdir(TARGET_DIR, { recursive: true });
  for (const file of FILES) {
    const dest = path.join(TARGET_DIR, file);
    try {
      await fs.access(dest);
      console.log(`[face-models] ${file} already present.`);
      continue;
    } catch {
      /* fall through to download */
    }
    console.log(`[face-models] downloading ${file}…`);
    await download(`${MODEL_URL_BASE}/${file}`, dest);
  }
  console.log(`[face-models] all models ready in ${TARGET_DIR}`);
}

main().catch((err) => {
  console.error('[face-models] failed:', err);
  process.exit(1);
});
