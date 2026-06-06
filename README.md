# Argon-BE — Image Upload, Validation & Media Pipeline Backend

Backend for the Aragon.ai challenge. Accepts image uploads, runs them through a
configurable **validation** pipeline (Part 1), then a scalable **media
processing** pipeline — convert → compress → variants (Part 2) — asynchronously,
and streams real-time status to the frontend.

## Architecture at a glance

```
Client ─▶ Express API ─▶ S3 (originals)
                │
                ├──▶ Postgres (metadata, status, variants)
                └──▶ BullMQ (Redis)
                       │
                       ▼
        ┌────────────────────────────┐
        │ Validation worker          │   Format→Dimension→Blur→Face→Similarity
        │ (image-processing queue)   │   PENDING→PROCESSING→ACCEPTED/REJECTED
        └────────────┬───────────────┘
                     │ on ACCEPTED → enqueue convert
                     ▼
   ┌─────────────┐   ┌──────────────┐   ┌───────────────┐
   │ Conversion  │──▶│ Compression  │──▶│   Variants    │   ← 3 independent,
   │  service    │   │   service    │   │   service     │     stateless services,
   │ (q: convert)│   │ (q: compress)│   │ (q: variants) │     one queue each
   └─────────────┘   └──────────────┘   └───────┬───────┘
   PROCESSING_       PROCESSING_         PROCESSING_VARIANTS
   CONVERT           COMPRESS            → COMPLETED
                     │
                     └──▶ Redis pub/sub ─▶ SSE ─▶ Client (live status per stage)
```

- **API** is thin: parse → enqueue → 202. Never blocks on processing.
- **Validation worker** runs the Part-1 pipeline; on ACCEPT it hands off to the media pipeline.
- **Three media services** (convert / compress / variants) are **stateless** and
  **independently scalable** — each consumes its own queue. The queue boundary *is*
  the service boundary; jobs carry only an `imageId` and rehydrate state from DB + S3.
- **Validation pipeline** is Strategy + Chain of Responsibility. Each rule = one class.
- **Storage** is `IStorageAdapter`; S3 implementation works against MinIO or AWS S3.
- **Events** flow via Redis pub/sub so multiple API replicas all receive SSE updates.

## Part 2 — the media processing pipeline

After validation accepts an image, it flows automatically through three services
chained by queues. Status walks `ACCEPTED → PROCESSING_CONVERT →
PROCESSING_COMPRESS → PROCESSING_VARIANTS → COMPLETED` (or `FAILED` with a clear
`processingError`).

| Service | Queue | Does | Writes |
|---------|-------|------|--------|
| **Conversion** | `pipeline-convert` | Normalise to an upright canonical JPEG (HEIC→JPEG, EXIF rotate, flatten) | `normalizedKey` |
| **Compression** | `pipeline-compress` | Re-encode with mozjpeg at `COMPRESSION_QUALITY`; record ratio | `compressedKey`, `compressedBytes`, `compressionRatio` |
| **Variants** | `pipeline-variants` | Generate `THUMBNAIL` / `WEB` / `FULL`, upload each, upsert a `Variant` row | 3 `Variant` rows → `COMPLETED` |

### Why one queue per stage (deployment choice)

Each stage is an **independently scalable, stateless consumer**. To scale
compression alone, run more compression workers — nothing else changes. Splitting
a stage into its own deployable container is mechanical: point its worker process
at the same Redis. One codebase with three queues was chosen over three separate
HTTP services to fit the time box while still satisfying *stateless + independently
scalable*; the queue is already the service boundary.

```bash
# Run all three in one process (dev):
npm run dev:processing

# Or scale a single stage independently — run N of just that one:
PROCESSING_SERVICE=compress COMPRESS_CONCURRENCY=8 npm run dev:processing
```

### Idempotency — reprocessing never duplicates

Reprocessing the same job is safe by construction, on two layers:

1. **Deterministic S3 keys** — `users/{userId}/{imageId}/variants/{type}.jpg` etc.
   A re-run overwrites the same object in place.
2. **`upsert` on the unique `(imageId, type)` constraint** — a re-run updates the
   same three rows instead of inserting new ones.

So no matter how many times the pipeline runs for an image, there are **exactly
three variants**. (The automatic, validation-triggered enqueue also uses a
deterministic `jobId` to collapse accidental double-enqueues; explicit
`POST /:id/reprocess` uses a fresh jobId so it always runs, relying on the two
guarantees above for safety.)

### Scalability & load testing

```bash
# Start the API + both workers (validation + all 3 pipeline services):
npm run dev

# Fire a concurrent batch of images straight at the pipeline and measure:
COUNT=100 CONCURRENCY=20 npm run loadtest
```

The load test (`scripts/load-test.ts`) generates N unique synthetic JPEGs,
submits them concurrently to `POST /api/images/seed` (which injects directly into
the pipeline, bypassing face validation so we stress the *three services* in
isolation), polls to completion, and prints **throughput** + **p50/p95 latency**.

To demonstrate horizontal scaling, run it twice and compare the throughput line:

```bash
# baseline: 1 worker per stage
CONVERT_CONCURRENCY=1 COMPRESS_CONCURRENCY=1 VARIANTS_CONCURRENCY=1 npm run dev:processing
COUNT=100 npm run loadtest        # note images/sec

# scaled: 8 per stage (or run several dev:processing processes)
CONVERT_CONCURRENCY=8 COMPRESS_CONCURRENCY=8 VARIANTS_CONCURRENCY=8 npm run dev:processing
COUNT=100 npm run loadtest        # throughput rises
```

#### Reading the output

```
Results
  submitted:        48      ← reached the pipeline (HTTP 202 from /seed)
  completed:        48      ← finished all 3 stages (status COMPLETED)
  failed:           0       ← ended in FAILED (a stage errored)
  total wall time:  8.05 s  ← submit of first → completion of last
  throughput:       5.96 images/sec   ← completed ÷ wall time (the headline number)
  end-to-end latency (submit → COMPLETED):
    p50: 4609 ms   ← half of images finished within this
    p95: 6618 ms   ← 95% finished within this (tail latency)
    max: ...
```

- **throughput** is the number to compare across worker counts — more workers →
  higher images/sec until a downstream resource (CPU, Postgres, S3) saturates.
- **p50 vs p95**: a tight gap = even processing; a wide gap = queue contention /
  a slow stage. Latency rising while throughput holds means you're at capacity.
- **submitted vs completed**: any shortfall is surfaced as `failed` or
  `stuck (timeout)` — the script never hides a drop.

## Tech

| Layer        | Choice                       | Why |
|--------------|------------------------------|-----|
| Runtime      | Node 20 + TypeScript         | Required by assignment, type safety |
| Framework    | Express                      | Required by assignment |
| ORM          | Prisma                       | Best DX, typed client, migrations |
| DB           | Postgres 16                  | Required by assignment |
| Queue        | BullMQ + Redis 7             | Production-grade async with retries/DLQ |
| Storage      | S3 SDK against MinIO (local) | Same code targets AWS S3 in prod |
| Validation   | zod                          | Runtime + compile-time types in one |
| Logging      | pino                         | Fast structured JSON |
| Face detect  | @vladmandic/face-api         | Pure JS, no native deps |
| Image proc.  | sharp + heic-convert         | Native speed + portable HEIC decoder |

## Repository layout

```
src/
├── api/                      HTTP layer (controllers, routes, middleware)
├── config/                   Typed env config (zod-validated)
├── domain/services/          Business logic (framework-agnostic)
├── infra/
│   ├── db/                   Prisma client
│   ├── repositories/         Data access
│   ├── storage/              IStorageAdapter + S3 implementation
│   └── queue/                BullMQ producer
├── shared/                   Logger, errors, events, DI container
├── workers/
│   ├── validators/           One file per rule (Strategy pattern)
│   ├── pipeline/             Chain-of-Responsibility validation pipeline + factory
│   ├── processors/           HEIC convert, pHash, face detector wrapper
│   ├── processing/           Part 2 — media pipeline
│   │   ├── processors/       Pure image ops (normalize, compress, resize) + tests
│   │   ├── keys.ts           Deterministic S3 key layout
│   │   ├── conversion.worker.ts
│   │   ├── compression.worker.ts
│   │   └── variants.worker.ts
│   └── image.worker.ts       Validation BullMQ consumer
├── app.ts                    Express app factory
├── server.ts                 API process entrypoint
├── worker.ts                 Validation worker entrypoint
└── processing.ts             Media-pipeline worker entrypoint (PROCESSING_SERVICE)
```

## Data model

```
Image
  id, userId, originalName, mimeType, sizeBytes, width, height
  s3KeyOriginal, s3KeyDisplay, perceptualHash
  status         PENDING|PROCESSING|ACCEPTED|REJECTED|FAILED
                 |PROCESSING_CONVERT|PROCESSING_COMPRESS|PROCESSING_VARIANTS|COMPLETED
  rejectionReasons (json)
  normalizedKey, compressedKey, compressedBytes, compressionRatio   ← Part 2
  processingError                                                   ← Part 2
  variants  Variant[]
  createdAt, updatedAt

Variant                                                            ← Part 2
  id, imageId (FK → Image, cascade)
  type       THUMBNAIL | WEB | FULL
  s3Key, width, height, sizeBytes
  @@unique([imageId, type])    ← idempotency backbone (upsert target)
```

See `docs/architecture.md` for the full system design (diagrams, sequence,
state machine, scaling & idempotency).

## Setup

### Prerequisites

- Node 20+
- Docker + Docker Compose

### One-time

```bash
npm install
cp .env.example .env             # tweak if needed; defaults work for local
docker compose up -d             # postgres + redis + minio
npm run prisma:migrate           # create the images table
npm run setup:minio              # create the S3 bucket in MinIO
npm run setup:models             # download face-api weights (~1.6MB)
```

Or all in one shot:

```bash
npm run bootstrap
```

### Run

Three processes — easiest in one terminal with:

```bash
npm run dev           # API + validation worker + all 3 pipeline services
```

Or separately:

```bash
npm run dev:api         # API on :4000
npm run dev:worker      # validation worker
npm run dev:processing  # media pipeline (convert + compress + variants)

# …or one stage at a time, to scale independently:
npm run dev:convert
npm run dev:compress
npm run dev:variants
```

### Test

```bash
npm test                # vitest unit tests (pure image ops + key layout)
```

MinIO console: <http://localhost:9101> (login `argonadmin` / `argonadmin`)
MinIO S3 API: <http://localhost:9100>
Prisma Studio: `npm run prisma:studio`

## API

Base URL: `http://localhost:4000`
Auth: pseudo (`x-user-id` header; falls back to `demo-user`)

### Interactive docs

| Path             | What it is                                       |
|------------------|--------------------------------------------------|
| `GET /docs`      | Swagger UI rendered against the live spec        |
| `GET /openapi.json` | OpenAPI 3.1 spec as JSON — feed to FE codegen |
| `GET /openapi.yaml` | Same spec as YAML                             |

The spec is loaded once at boot from `docs/api-contract.yaml`. Edit that
file, restart, and both `/docs` and `/openapi.json` reflect the change.

### `POST /api/images`  — upload one or more files

Content type: `multipart/form-data`
Field: `images` (repeatable, up to 10)

**Response (202)**

```json
{
  "accepted": [
    {
      "id": "0f5e…",
      "userId": "demo-user",
      "originalName": "profile.jpg",
      "mimeType": "image/jpeg",
      "sizeBytes": 184_223,
      "width": null,
      "height": null,
      "status": "PENDING",
      "rejectionReasons": null,
      "originalUrl": "http://localhost:9000/argon-images/…",
      "displayUrl": null,
      "createdAt": "…",
      "updatedAt": "…"
    }
  ],
  "rejected": [
    {
      "originalName": "tiny.gif",
      "error": { "code": "UNSUPPORTED_MEDIA_TYPE", "message": "…" }
    }
  ]
}
```

Per-file rejection codes returned synchronously: `UNSUPPORTED_MEDIA_TYPE`,
`PAYLOAD_TOO_LARGE`. Anything else is reported asynchronously after the worker
runs the pipeline (see below).

### `GET /api/images?status=ACCEPTED&limit=24&cursor=<id>`

Returns `{ items: ImageView[], nextCursor: string | null }`. Keyset pagination.

### `GET /api/images/:id`

Returns the latest `ImageView` for that image — now including `processingError`,
`compression` (`{ compressedBytes, ratio, savedPct }`), and `variants[]`
(`{ type, url, width, height, sizeBytes }`) once the pipeline completes.

### `GET /api/images/:id/variants`

Returns `{ imageId, variants: VariantView[] }` — the generated thumbnail / web /
full sizes with presigned URLs and metadata.

### `POST /api/images/:id/reprocess`

Re-runs the media pipeline from the top. **Idempotent** — overwrites the same
three variants, never duplicates. Returns 202 with the (now `PROCESSING_CONVERT`)
image.

### `POST /api/images/seed`  *(load testing; non-production)*

Multipart `images`. Stores each file and injects it straight into the media
pipeline (status `ACCEPTED` → convert), skipping face/blur/duplicate validation
so the three services can be load-tested in isolation. Used by `npm run loadtest`.

### `DELETE /api/images/:id`

Hard delete: DB row + S3 objects. 204 on success.

### `GET /api/images/events`  *(Server-Sent Events)*

Streams `image.status` events for the current user. Use this to update the UI
in real time after upload.

Event payload:

```json
{
  "imageId": "0f5e…",
  "userId": "demo-user",
  "status": "PROCESSING" | "ACCEPTED" | "REJECTED" | "FAILED" | "PROCESSING_CONVERT" | "PROCESSING_COMPRESS" | "PROCESSING_VARIANTS" | "COMPLETED",
  "rejectionReasons": [{ "code": "FACE_TOO_SMALL", "message": "…", "meta": {…} }] | null,
  "at": "2025-…"
}
```

### `GET /healthz` → `{ ok: true }`

## Rejection codes (stable contract)

| Code                   | Meaning                                       |
|------------------------|-----------------------------------------------|
| `UNSUPPORTED_FORMAT`   | File is not JPEG/PNG/HEIC                     |
| `FILE_TOO_SMALL_BYTES` | Below `MIN_FILE_BYTES`                        |
| `RESOLUTION_TOO_LOW`   | Below `MIN_WIDTH` × `MIN_HEIGHT`              |
| `IMAGE_TOO_BLURRY`     | Laplacian variance below `BLUR_VARIANCE_THRESHOLD` |
| `NO_FACE_DETECTED`     | Pipeline found zero faces                     |
| `FACE_TOO_SMALL`       | Largest face area / image area below `FACE_MIN_AREA_RATIO` |
| `MULTIPLE_FACES`       | Face count > `FACE_MAX_COUNT`                 |
| `DUPLICATE_IMAGE`      | pHash Hamming distance ≤ `SIMILARITY_HAMMING_THRESHOLD` |
| `CORRUPT_FILE`         | Decoder failed                                |

## Default thresholds

| Variable                       | Default | Rationale |
|--------------------------------|--------:|-----------|
| `UPLOAD_MAX_BYTES`             | 15 MB   | Generous for phone shots; cap memory |
| `MIN_FILE_BYTES`               | 8 KB    | Reject pathologically tiny files |
| `MIN_WIDTH` / `MIN_HEIGHT`     | 200 px  | Anything smaller is a thumbnail |
| `BLUR_VARIANCE_THRESHOLD`      | 80      | Tuned on a handful of test shots; tune per dataset |
| `FACE_MIN_AREA_RATIO`          | 0.05    | Face must cover ≥5 % of frame |
| `FACE_MAX_COUNT`               | 1       | Single-subject portraits |
| `SIMILARITY_HAMMING_THRESHOLD` | 5       | ≤ 5 bits of a 64-bit pHash differ |

### Media pipeline (Part 2)

| Variable | Default | Rationale |
|----------|--------:|-----------|
| `COMPRESSION_QUALITY` | 72 | mozjpeg sweet spot — big savings, no visible loss |
| `VARIANT_THUMB_WIDTH` | 320 | Grid thumbnails / avatars |
| `VARIANT_WEB_WIDTH` | 1080 | In-app display |
| `VARIANT_FULL_WIDTH` | 2048 | Downloads / zoom (never upscales) |
| `CONVERT/COMPRESS/VARIANTS_CONCURRENCY` | 4 | Per-stage parallelism, tuned independently |
| `PROCESSING_SERVICE` | all | Which stage(s) a process runs (`all`/`convert`/`compress`/`variants`) |

## Design patterns in play

- **Strategy** — each `IValidator` is a swappable rule.
- **Chain of Responsibility** — `ValidationPipeline` runs validators in order, fails fast.
- **Pipes & Filters** — the media pipeline is queue-chained stages, each a stateless filter over bytes.
- **Factory** — `buildDefaultPipeline()` is the only place ordering changes.
- **Adapter** — `IStorageAdapter` decouples the domain from S3.
- **Repository** — `ImageRepository` shields services from Prisma.
- **Dependency Injection** — `buildContainer()` wires concrete instances.
- **DTO** — zod schemas at every external boundary.

## Production hardening (out of scope but called out)

- Direct-to-S3 uploads via presigned URLs (skip the API for the file bytes)
- Real auth (JWT / OAuth) — only `user-context.middleware.ts` changes
- pgvector for similarity at scale (>10k images/user)
- OpenTelemetry traces around the pipeline
- Image-format AV scan (ClamAV daemon)
- Multi-region S3 + lifecycle rules for cold storage
