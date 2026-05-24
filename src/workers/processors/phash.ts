/**
 * Perceptual hash (pHash) — 64-bit DCT-based fingerprint.
 *
 *   1. Greyscale resize to 32×32.
 *   2. 2D DCT (we approximate with a fast per-row + per-column 1D DCT-II).
 *   3. Keep the top-left 8×8 (low frequencies = "shape" of image).
 *   4. Compare each coefficient to the median; bit = 1 if above.
 *   5. Pack 64 bits into a 16-char hex string.
 *
 * Two images with Hamming distance ≤ 5 are visually near-identical.
 *
 * Designed for short demo timelines — accuracy is "good enough", and we can
 * later swap in a dedicated lib or a CNN embedding without changing callers.
 */
import sharp from 'sharp';

const N = 32;
const KEEP = 8;

function dct1d(input: Float64Array): Float64Array {
  const out = new Float64Array(N);
  const factor = Math.PI / (2 * N);
  for (let k = 0; k < N; k++) {
    let sum = 0;
    for (let n = 0; n < N; n++) {
      sum += input[n] * Math.cos((2 * n + 1) * k * factor);
    }
    out[k] = sum;
  }
  return out;
}

export async function computePerceptualHash(image: Buffer): Promise<string> {
  // Resize → greyscale → raw pixels. `sharp` gives us a flat Uint8Array.
  const { data } = await sharp(image)
    .greyscale()
    .resize(N, N, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Build a 32×32 matrix of floats.
  const matrix: Float64Array[] = [];
  for (let y = 0; y < N; y++) {
    const row = new Float64Array(N);
    for (let x = 0; x < N; x++) {
      row[x] = data[y * N + x];
    }
    matrix.push(row);
  }

  // 1D DCT along rows.
  const rowsDct = matrix.map(dct1d);

  // 1D DCT along columns.
  const dct: Float64Array[] = [];
  for (let y = 0; y < N; y++) dct.push(new Float64Array(N));
  for (let x = 0; x < N; x++) {
    const col = new Float64Array(N);
    for (let y = 0; y < N; y++) col[y] = rowsDct[y][x];
    const t = dct1d(col);
    for (let y = 0; y < N; y++) dct[y][x] = t[y];
  }

  // Keep the 8×8 low-frequency block (skip the [0][0] DC coefficient when
  // computing the median, so that overall brightness doesn't dominate).
  const coeffs: number[] = [];
  for (let y = 0; y < KEEP; y++) {
    for (let x = 0; x < KEEP; x++) {
      if (y === 0 && x === 0) continue;
      coeffs.push(dct[y][x]);
    }
  }
  const sorted = [...coeffs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  // Build the 64-bit hash. We include [0][0] but always set its bit to 0
  // (kept just so the bit count == 64).
  let bits = '';
  for (let y = 0; y < KEEP; y++) {
    for (let x = 0; x < KEEP; x++) {
      if (y === 0 && x === 0) {
        bits += '0';
        continue;
      }
      bits += dct[y][x] > median ? '1' : '0';
    }
  }

  // Pack into hex.
  let hex = '';
  for (let i = 0; i < 64; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Math.max(a.length, b.length) * 4;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    const xor = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    dist += (xor & 1) + ((xor >> 1) & 1) + ((xor >> 2) & 1) + ((xor >> 3) & 1);
  }
  return dist;
}
