/**
 * Media-pipeline load test.
 *
 * Generates N unique synthetic JPEGs, submits them concurrently to the
 * load-test seed endpoint (which injects straight into the
 * convert → compress → variants pipeline), then polls until every image
 * reaches a terminal state (COMPLETED / FAILED). Reports throughput and
 * latency percentiles.
 *
 * Usage:
 *   npm run loadtest                         # defaults: 50 images, 10 concurrent
 *   COUNT=200 CONCURRENCY=20 npm run loadtest
 *   API_URL=http://localhost:4000 USER_ID=demo-user npm run loadtest
 *
 * To demonstrate horizontal scaling, run it twice while varying the number of
 * pipeline workers (or *_CONCURRENCY env), and compare the throughput line:
 *
 *   # baseline — one worker, concurrency 1 per stage
 *   CONVERT_CONCURRENCY=1 COMPRESS_CONCURRENCY=1 VARIANTS_CONCURRENCY=1 npm run dev:processing
 *   COUNT=100 npm run loadtest
 *
 *   # scaled — concurrency 8 per stage (or run several dev:processing processes)
 *   CONVERT_CONCURRENCY=8 COMPRESS_CONCURRENCY=8 VARIANTS_CONCURRENCY=8 npm run dev:processing
 *   COUNT=100 npm run loadtest
 */
import sharp from 'sharp';
import { randomBytes } from 'crypto';

const API_URL = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
const USER_ID = process.env.USER_ID ?? 'demo-user';
const COUNT = Number(process.env.COUNT ?? 50);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 10);
const IMAGE_SIZE = Number(process.env.IMAGE_SIZE ?? 1000); // px, square
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 750);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 180_000);

interface Submitted {
  id: string;
  submittedAt: number;
  completedAt?: number;
  status?: string;
}

/** A unique, realistic-sized JPEG built from random pixel noise. */
async function makeImage(): Promise<Buffer> {
  const raw = randomBytes(IMAGE_SIZE * IMAGE_SIZE * 3);
  return sharp(raw, { raw: { width: IMAGE_SIZE, height: IMAGE_SIZE, channels: 3 } })
    .jpeg({ quality: 92 })
    .toBuffer();
}

/** Run async tasks with a bounded concurrency pool. */
async function pool<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<void>) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

async function seedOne(buffer: Buffer, idx: number): Promise<string> {
  const form = new FormData();
  form.append('images', new Blob([buffer], { type: 'image/jpeg' }), `load-${idx}.jpg`);
  const res = await fetch(`${API_URL}/api/images/seed`, {
    method: 'POST',
    headers: { 'x-user-id': USER_ID },
    body: form,
  });
  if (!res.ok) throw new Error(`seed failed: HTTP ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { accepted: Array<{ id: string }> };
  const id = body.accepted?.[0]?.id;
  if (!id) throw new Error('seed returned no id');
  return id;
}

async function fetchStatus(id: string): Promise<string> {
  const res = await fetch(`${API_URL}/api/images/${id}`, { headers: { 'x-user-id': USER_ID } });
  if (!res.ok) throw new Error(`status fetch failed: HTTP ${res.status}`);
  const body = (await res.json()) as { status: string };
  return body.status;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function isTerminal(status: string): boolean {
  return status === 'COMPLETED' || status === 'FAILED';
}

async function main() {
  console.log('─'.repeat(64));
  console.log('Argon media-pipeline load test');
  console.log(`  API:          ${API_URL}`);
  console.log(`  images:       ${COUNT}`);
  console.log(`  submit conc.: ${CONCURRENCY}`);
  console.log(`  image size:   ${IMAGE_SIZE}×${IMAGE_SIZE}`);
  console.log('─'.repeat(64));

  // 1) Generate
  process.stdout.write('Generating images… ');
  const buffers = await Promise.all(Array.from({ length: COUNT }, () => makeImage()));
  console.log(`done (${COUNT} unique JPEGs).`);

  // 2) Submit concurrently
  const submitted: Submitted[] = [];
  const t0 = Date.now();
  process.stdout.write('Submitting to pipeline… ');
  await pool(buffers, CONCURRENCY, async (buf, i) => {
    const submittedAt = Date.now();
    try {
      const id = await seedOne(buf, i);
      submitted.push({ id, submittedAt });
    } catch (err) {
      console.error(`\n  submit error [${i}]:`, (err as Error).message);
    }
  });
  const submitMs = Date.now() - t0;
  console.log(`done (${submitted.length}/${COUNT} accepted in ${submitMs} ms).`);

  // 3) Poll to completion
  console.log('Processing (polling for completion)…');
  const pending = new Map(submitted.map((s) => [s.id, s]));
  const deadline = Date.now() + TIMEOUT_MS;
  let lastDone = 0;

  while (pending.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const ids = [...pending.keys()];
    await pool(ids, 20, async (id) => {
      try {
        const status = await fetchStatus(id);
        if (isTerminal(status)) {
          const s = pending.get(id)!;
          s.completedAt = Date.now();
          s.status = status;
          pending.delete(id);
        }
      } catch {
        /* transient — retry next round */
      }
    });
    const done = submitted.length - pending.size;
    if (done !== lastDone) {
      process.stdout.write(`\r  completed ${done}/${submitted.length}   `);
      lastDone = done;
    }
  }
  console.log('');

  // 4) Report
  const totalMs = Date.now() - t0;
  const finished = submitted.filter((s) => s.completedAt);
  const completed = finished.filter((s) => s.status === 'COMPLETED');
  const failed = finished.filter((s) => s.status === 'FAILED');
  const stuck = submitted.filter((s) => !s.completedAt);

  const latencies = completed
    .map((s) => s.completedAt! - s.submittedAt)
    .sort((a, b) => a - b);

  const throughput = completed.length / (totalMs / 1000);

  console.log('─'.repeat(64));
  console.log('Results');
  console.log(`  submitted:        ${submitted.length}`);
  console.log(`  completed:        ${completed.length}`);
  console.log(`  failed:           ${failed.length}`);
  if (stuck.length) console.log(`  stuck (timeout):  ${stuck.length}`);
  console.log(`  total wall time:  ${(totalMs / 1000).toFixed(2)} s`);
  console.log(`  throughput:       ${throughput.toFixed(2)} images/sec  ← compare across worker counts`);
  console.log('  end-to-end latency (submit → COMPLETED):');
  console.log(`    p50: ${percentile(latencies, 50)} ms`);
  console.log(`    p95: ${percentile(latencies, 95)} ms`);
  console.log(`    max: ${latencies[latencies.length - 1] ?? 0} ms`);
  console.log('─'.repeat(64));

  if (stuck.length > 0) {
    console.log('⚠  Some images never completed. Is the processing worker running?');
    console.log('   Start it with:  npm run dev:processing   (or npm run dev)');
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('load-test failed:', err);
  process.exit(1);
});
