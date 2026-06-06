# Argon-BE — System Architecture

A two-stage asynchronous image platform:

1. **Validation** (Part 1) — accept an upload and run it through quality gates.
2. **Media processing** (Part 2) — convert → compress → generate variants.

Both stages run **off the request path** as queue-driven workers, share one
Postgres + object-storage backbone, and are **stateless and independently
scalable**.

![Architecture diagram](./architecture.svg)

---

## 1. System overview

```mermaid
flowchart LR
    Client([Browser · Next.js])

    subgraph API["API process — server.ts (Express)"]
        UP[Upload controller<br/>sniff MIME · size cap]
        SVC[ImageService<br/>S3 put · DB row · enqueue]
        REST[REST: list / get / variants<br/>reprocess / seed]
        SSE[SSE /events fan-out]
    end

    subgraph REDIS["Redis — BullMQ + Pub/Sub"]
        QV[[queue: image-processing]]
        QC[[queue: pipeline-convert]]
        QK[[queue: pipeline-compress]]
        QX[[queue: pipeline-variants]]
        PS{{channel: argon:image.status}}
    end

    subgraph VW["Validation worker — worker.ts"]
        VAL[Format → Dimension → Blur → Face → Similarity]
    end

    subgraph PIPE["Media pipeline — processing.ts (3 stateless services)"]
        CONV[1 Conversion<br/>HEIC→JPEG, rotate]
        COMP[2 Compression<br/>mozjpeg + ratio]
        VAR[3 Variants<br/>thumb/web/full]
    end

    DB[(Postgres<br/>images · variants)]
    S3[(MinIO / S3<br/>image bytes)]

    Client -- "POST /api/images" --> UP
    Client <-. "SSE live status" .-> SSE
    UP --> SVC
    SVC -- INSERT --> DB
    SVC -- PUT original --> S3
    SVC -- enqueue --> QV

    QV -- dequeue --> VAL
    VAL -- GET --> S3
    VAL -- UPDATE status --> DB
    VAL -- "on ACCEPT: enqueue convert" --> QC
    VAL -- publish --> PS

    QC -- dequeue --> CONV --> QK
    QK -- dequeue --> COMP --> QX
    QX -- dequeue --> VAR
    CONV & COMP & VAR -- read/write bytes --> S3
    CONV & COMP & VAR -- update status / upsert variants --> DB
    CONV & COMP & VAR -- publish --> PS

    PS -- subscribe --> SSE
```

---

## 2. The media pipeline, end to end

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser
    participant A as API
    participant R as Redis (queues)
    participant V as Validation worker
    participant C as Conversion svc
    participant K as Compression svc
    participant X as Variants svc
    participant DB as Postgres
    participant S3 as MinIO/S3

    B->>A: POST /api/images (multipart)
    A->>S3: PUT original
    A->>DB: INSERT row (PENDING)
    A->>R: enqueue validate
    A-->>B: 202 PENDING
    R->>V: job
    V->>DB: status PROCESSING
    V->>S3: GET original
    Note over V: Format→Dimension→Blur→Face→Similarity
    alt rejected
        V->>DB: REJECTED + reasons
    else accepted
        V->>DB: ACCEPTED
        V->>R: enqueue convert
        R->>C: job
        C->>DB: PROCESSING_CONVERT
        C->>S3: PUT normalized.jpg
        C->>R: enqueue compress
        R->>K: job
        K->>DB: PROCESSING_COMPRESS + ratio
        K->>S3: PUT compressed.jpg
        K->>R: enqueue variants
        R->>X: job
        X->>DB: PROCESSING_VARIANTS
        X->>S3: PUT thumbnail/web/full
        X->>DB: upsert 3 variants → COMPLETED
    end
    Note over V,X: every transition published to argon:image.status
    R-->>A: status events (subscribe)
    A-->>B: SSE push (live card updates)
```

---

## 3. Status state machine

```mermaid
stateDiagram-v2
    [*] --> PENDING
    PENDING --> PROCESSING
    PROCESSING --> REJECTED: a validator failed
    PROCESSING --> FAILED: infra error
    PROCESSING --> ACCEPTED: all validators passed
    ACCEPTED --> PROCESSING_CONVERT
    PROCESSING_CONVERT --> PROCESSING_COMPRESS
    PROCESSING_COMPRESS --> PROCESSING_VARIANTS
    PROCESSING_VARIANTS --> COMPLETED
    PROCESSING_CONVERT --> FAILED: stage error
    PROCESSING_COMPRESS --> FAILED: stage error
    PROCESSING_VARIANTS --> FAILED: stage error
    REJECTED --> [*]
    FAILED --> [*]
    COMPLETED --> [*]
    COMPLETED --> PROCESSING_CONVERT: reprocess (idempotent)
```

---

## 4. Data model

```mermaid
erDiagram
    IMAGE ||--o{ VARIANT : has
    IMAGE {
        uuid   id PK
        string userId
        string status
        int    sizeBytes
        string normalizedKey
        string compressedKey
        int    compressedBytes
        float  compressionRatio
        string processingError
        json   rejectionReasons
    }
    VARIANT {
        uuid   id PK
        uuid   imageId FK
        enum   type "THUMBNAIL|WEB|FULL"
        string s3Key
        int    width
        int    height
        int    sizeBytes
    }
```

`VARIANT` has a **`UNIQUE(imageId, type)`** constraint — the backbone of
idempotent reprocessing.

---

## 5. Components & responsibilities

### API process — `server.ts`
- Thin HTTP layer. Sniffs MIME from magic bytes, enforces the size cap, PUTs the
  original to S3, writes the row, enqueues a validation job, returns **202**
  immediately — never blocks on processing.
- Serves reads (`list` / `get` / `variants`), control (`reprocess`), and the
  load-test entry (`seed`).
- Owns one Redis subscription and fans status events out to all SSE clients.

### Validation worker — `worker.ts`
- Runs the Part-1 pipeline: **Strategy + Chain of Responsibility**, ordered
  cheap → expensive, short-circuits on first failure.
- On `ACCEPTED`, enqueues the media pipeline (hand-off point between the two stages).

### Media pipeline — `processing.ts`
Three services, **one BullMQ queue each**, chained `convert → compress → variants`:

| # | Service | Reads | Does | Writes |
|---|---------|-------|------|--------|
| 1 | Conversion | original | normalise to an upright canonical JPEG (HEIC→JPEG, EXIF rotate, flatten) | `normalized.jpg`, `normalizedKey` |
| 2 | Compression | normalized | mozjpeg re-encode at quality; compute ratio | `compressed.jpg`, `compressedBytes`, `compressionRatio` |
| 3 | Variants | compressed | resize to thumbnail/web/full, upsert a row each | `variants/*.jpg`, 3 `Variant` rows → `COMPLETED` |

`PROCESSING_SERVICE` selects which service(s) a process runs (`all` for dev, or a
single stage to scale it alone); `*_CONCURRENCY` tunes each independently.

### Redis (BullMQ + Pub/Sub)
- **Queues** decouple producers from consumers and provide retries (3×,
  exponential backoff) and retention for inspection.
- **Pub/Sub** carries status events cross-process so any API replica can serve
  SSE for any image.

### Postgres (Prisma)
- Source of truth for metadata + status. Indexed for list-by-user and similarity
  lookup. Holds the `variants` table with the unique constraint.

### MinIO / S3
- Stores all image bytes under **deterministic keys**; the DB stores only the
  keys. Same SDK code targets real AWS S3 (flip `AWS_S3_ENDPOINT`).

---

## 6. Why this shape — design rationale

- **Two processes, three services, one backbone.** Each unit does one thing and
  is independently deployable. The **queue is the service boundary**: splitting a
  stage into its own container means pointing its worker at the same Redis.
- **Stateless workers.** A job carries only an `imageId`; the worker rehydrates
  everything from Postgres + S3. So *any* worker can take *any* job — that is what
  makes horizontal scaling trivial.
- **Fail-fast validation, fail-safe processing.** Validation short-circuits to
  save the expensive face/duplicate checks; processing marks `FAILED` with a
  stage-tagged `processingError` instead of silently dropping a job.
- **Idempotency by construction** (see below) rather than by coordination.

---

## 7. Scalability model

```mermaid
flowchart LR
    QK[[pipeline-compress]] --> W1[compress replica 1]
    QK --> W2[compress replica 2]
    QK --> W3[compress replica N]
```

- A stage that backs up is its own queue → run more consumers of *just that
  queue*: `PROCESSING_SERVICE=compress COMPRESS_CONCURRENCY=8 npm run dev:processing`.
- Because workers are stateless, adding replicas needs no coordination, sticky
  routing, or shared memory.
- The load test (`npm run loadtest`) submits a concurrent batch and reports
  throughput + p50/p95 so you can measure the effect of adding workers.

---

## 8. Idempotency — reprocessing never duplicates

1. **Deterministic S3 keys** per `(userId, imageId, kind)` → a re-run overwrites
   the same objects.
2. **`upsert` on `UNIQUE(imageId, type)`** → a re-run updates the same three rows.

Result: **exactly three variants**, no matter how many times the pipeline runs.
Internal stage hand-offs use fresh job ids so an explicit reprocess always runs;
safety comes from the two guarantees above, not from queue de-duplication.

---

## 9. Failure handling

- Each stage wraps work in a handler: on the final retry it sets `status=FAILED`
  and writes a human-readable `processingError` (e.g. `[convert] corrupt header`),
  then publishes the event — the job never disappears silently.
- Transient/infra errors throw and let BullMQ retry (3×, exponential backoff);
  clean rejections do not retry.
