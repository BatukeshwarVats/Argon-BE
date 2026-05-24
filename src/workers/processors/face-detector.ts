/**
 * Face detection wrapper.
 *
 * - Lazily loads `@vladmandic/face-api` and its TinyFaceDetector weights on first use.
 *   (Loading at module import would slow the worker boot for no reason if a job
 *    never reaches FaceValidator.)
 * - Uses `canvas` to decode arbitrary JPEG/PNG buffers into a tensor source.
 * - Returns a small DTO; the validator decides the business rules.
 */
import * as path from 'path';
import { config } from '../../config';
import { logger } from '../../shared/logger';

export interface FaceDetection {
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
}

let initialized: Promise<void> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let faceapi: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let canvas: any = null;

async function ensureInitialized(): Promise<void> {
  if (initialized) return initialized;
  initialized = (async () => {
    // Lazy require so the test runner / API process doesn't pull in tfjs.
    // CRITICAL: load tfjs-node BEFORE face-api so the native backend
    // registers itself as the default tf backend.
    /* eslint-disable @typescript-eslint/no-require-imports */
    require('@tensorflow/tfjs-node');
    faceapi = require('@vladmandic/face-api');
    canvas = require('canvas');
    /* eslint-enable @typescript-eslint/no-require-imports */

    // Tell face-api to use node-canvas for Image/Canvas implementations.
    const { Canvas, Image, ImageData } = canvas;
    faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

    const modelDir = path.resolve(process.cwd(), config.FACE_MODEL_PATH);
    await faceapi.nets.tinyFaceDetector.loadFromDisk(modelDir);
    logger.info({ modelDir }, 'face-api.loaded');
  })();
  return initialized;
}

export async function detectFaces(imageBuffer: Buffer): Promise<FaceDetection[]> {
  await ensureInitialized();

  // Decode buffer → node-canvas image → face-api detection.
  const img = await canvas.loadImage(imageBuffer);
  const detections = await faceapi.detectAllFaces(
    img as never,
    new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 }),
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return detections.map((d: any) => ({
    x: d.box.x,
    y: d.box.y,
    width: d.box.width,
    height: d.box.height,
    score: d.score,
  }));
}
