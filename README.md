# Argon-BE — Image Upload & Validation Backend

Backend for the Aragon.ai SDE-2 image-upload challenge. Accepts image uploads,
runs them through a configurable validation pipeline asynchronously, and streams
real-time status to the frontend.

## Architecture at a glance

```
Client ─▶ Express API ─▶ S3 (originals)
                │
                ├──▶ Postgres (metadata, status, rejection reasons)
                └──▶ BullMQ (Redis) ─▶ Worker process
                                          │
                                          ├─▶ Validation pipeline
                                          │     1. Format     (cheap)
                                          │     2. Dimension  (cheap)
                                          │     3. Blur       (medium)
                                          │     4. Face       (heavy)
                                          │     5. Similarity (medium)
                                          │
                                          └─▶ Redis pub/sub ─▶ SSE ─▶ Client
```

- **API** is thin: parse → enqueue → 202. Never blocks on validation.
- **Worker** runs the pipeline. Scales independently from HTTP.
- **Pipeline** is Strategy + Chain of Responsibility. Each rule = one class.
- **Storage** is `IStorageAdapter`; S3 implementation works against MinIO or AWS S3.
- **Events** flow via Redis pub/sub so multiple API replicas all receive SSE updates.

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
│   ├── pipeline/             Chain-of-Responsibility pipeline + factory
│   ├── processors/           HEIC convert, pHash, face detector wrapper
│   └── image.worker.ts       BullMQ consumer
├── app.ts                    Express app factory
├── server.ts                 API process entrypoint
└── worker.ts                 Worker process entrypoint
```

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

Two processes — easiest in one terminal with:

```bash
npm run dev
```

Or separately:

```bash
npm run dev:api       # API on :4000
npm run dev:worker    # worker
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

Returns the latest `ImageView` for that image.

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
  "status": "ACCEPTED" | "PROCESSING" | "REJECTED" | "FAILED",
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

## Design patterns in play

- **Strategy** — each `IValidator` is a swappable rule.
- **Chain of Responsibility** — `ValidationPipeline` runs validators in order, fails fast.
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
