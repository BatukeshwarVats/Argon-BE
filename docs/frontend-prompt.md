# Frontend Prompt — Argon Image Uploader

Paste the section below directly into the frontend agent / IDE for fast,
context-free development. The companion `api-contract.yaml` in this folder
is the single source of truth for shapes; everything below references it.

---

## Mission

Build the frontend for the Aragon.ai image-upload challenge. The backend
already exists (`http://localhost:4000`) and is fully async — the UI must show
images moving through `PENDING → PROCESSING → ACCEPTED | REJECTED | FAILED`
in real time via Server-Sent Events.

Demo reference: users upload images, see them split into **Accepted** and
**Rejected** sections with clear reasons.

## Stack — what to use

| Concern        | Choice                                                            |
|----------------|-------------------------------------------------------------------|
| Framework      | **Next.js 14 (App Router) + React 18**                            |
| Language       | TypeScript (strict)                                               |
| Styling        | Tailwind CSS + shadcn/ui (Radix primitives)                       |
| State          | React hooks + Zustand for the image store (no Redux)              |
| HTTP           | Native `fetch`                                                    |
| Realtime       | Native `EventSource`                                              |
| Drag & drop    | `react-dropzone`                                                  |
| HEIC preview   | `heic2any` (client-side conversion to a preview blob URL)         |
| Icons          | `lucide-react`                                                    |
| Toasts         | `sonner`                                                          |

> Reasoning to capture in code comments: every choice is mainstream, well-typed,
> and easy to swap. Don't introduce CSS-in-JS, GraphQL clients, or form libs —
> the surface is too small to justify them.

## Project layout (Next.js App Router)

```
src/
├── app/
│   ├── layout.tsx
│   ├── page.tsx                  # the entire uploader UI
│   └── globals.css
├── components/
│   ├── dropzone.tsx              # drag-drop + file picker, runs FE validations
│   ├── image-card.tsx            # one tile (preview, name, status, reason)
│   ├── image-grid.tsx            # "Accepted" / "Rejected" sections w/ counts
│   ├── status-badge.tsx          # PENDING / PROCESSING / ACCEPTED / REJECTED chip
│   └── rejection-reasons.tsx     # human-readable list with icons per code
├── lib/
│   ├── api.ts                    # typed wrapper over backend REST
│   ├── sse.ts                    # EventSource manager with auto-reconnect
│   ├── validation.ts             # FE-side pre-upload checks
│   ├── types.ts                  # mirrors components.schemas from api-contract
│   └── rejection-copy.ts         # code → friendly title + suggestion
├── store/
│   └── images.ts                 # Zustand store (see shape below)
└── env.ts                        # NEXT_PUBLIC_API_URL parsing
```

## State shape (Zustand)

```ts
type ImageItem = {
  // Either a fully-uploaded image (has `serverId`) or one still being uploaded.
  clientId: string;                     // local uuid, stable across renders
  serverId?: string;                    // present once upload responds 202
  file: File;                           // for preview + retry
  previewUrl: string;                   // object URL (or heic2any output)
  status: 'LOCAL' | 'UPLOADING' | ServerImageStatus;
  rejectionReasons: RejectionReason[] | null;
  serverMeta?: ImageView;               // latest server view, presigned URLs
};

interface ImagesStore {
  items: Record<string, ImageItem>;     // keyed by clientId
  addLocal(files: File[]): void;
  markUploading(clientId: string): void;
  attachServer(clientId: string, view: ImageView): void;
  applyServerEvent(ev: ImageStatusEvent): void;
  remove(clientId: string): Promise<void>;
}
```

Render-time selectors:
- `accepted` = items with `status === 'ACCEPTED'`
- `rejected` = items with `status === 'REJECTED' || 'FAILED'` OR with FE-validation rejection
- `inFlight` = everything else (LOCAL / UPLOADING / PENDING / PROCESSING)

## Required FE validations (before upload)

Run these in `lib/validation.ts` BEFORE calling the API. The user should
see immediate feedback for the easy stuff.

1. **MIME / extension** — accept only:
   - `image/jpeg` (.jpg, .jpeg)
   - `image/png`  (.png)
   - `image/heic`, `image/heif` (.heic, .heif)
   Sniff `file.type` AND extension fallback (Safari sometimes ships HEIC with empty MIME).

2. **Max size** — 15 MB (mirror backend `UPLOAD_MAX_BYTES`).

3. **Min size** — 8 KB (mirror backend `MIN_FILE_BYTES`).

Return a discriminated union:

```ts
type ClientValidation =
  | { ok: true }
  | { ok: false; code: 'UNSUPPORTED_FORMAT' | 'PAYLOAD_TOO_LARGE' | 'FILE_TOO_SMALL_BYTES'; message: string };
```

Failed files go straight to the rejected section WITHOUT hitting the network.

## Real-time updates via SSE

`lib/sse.ts` opens **one** `EventSource('/api/images/events')` on app mount.
On each `image.status` event, dispatch `applyServerEvent` to the store, which
matches on `serverId` and updates `status` + `rejectionReasons`.

Reconnect logic: `EventSource` auto-reconnects on its own; just log
`onerror` to a toast at most once every 30s.

## API client (`lib/api.ts`)

Wrap the 5 endpoints. Inject `x-user-id` header from a single constant
(`'demo-user'`) — leaves auth as a one-line change later.

```ts
export async function uploadImages(files: File[]): Promise<UploadBatchResponse>;
export async function listImages(opts?: { status?: ImageStatus; cursor?: string }): Promise<ListImagesResponse>;
export async function getImage(id: string): Promise<ImageView>;
export async function deleteImage(id: string): Promise<void>;
```

Each function:
- Sends `x-user-id`
- Throws a typed `ApiError` with `{ code, message, status }` on non-2xx
- Uses `FormData` with the field name `images` for upload

## UI / UX requirements

1. **Single-page layout** — header, dropzone, two side-by-side sections (or stacked on mobile): Accepted (green) / Rejected (red). Show counts in each header.

2. **Dropzone**
   - Accepts drag-drop AND click-to-open.
   - Multi-select up to 10 at once.
   - Shows accepted MIME types in placeholder.
   - Disabled while files are uploading (visual + actual disabled).

3. **Image card** (each tile)
   - Square thumbnail (object-cover).
   - Filename truncated with tooltip on hover.
   - Status badge with subtle animation while PENDING/PROCESSING.
   - For rejected: red border, list of rejection reasons (use `rejection-copy.ts` to map code → friendly message).
   - Delete button (trash icon) for everything except inFlight.

4. **Status badge mapping**
   | Status      | Color  | Icon       | Label             |
   |-------------|--------|------------|-------------------|
   | LOCAL       | gray   | Clock      | Queued            |
   | UPLOADING   | blue   | UploadCloud (spin) | Uploading |
   | PENDING     | amber  | Hourglass  | Waiting           |
   | PROCESSING  | violet | Loader (spin)      | Processing |
   | ACCEPTED    | emerald| Check      | Accepted          |
   | REJECTED    | rose   | XOctagon   | Rejected          |
   | FAILED      | gray   | AlertCircle| Error             |

5. **Rejection copy** (in `lib/rejection-copy.ts`)
   ```ts
   {
     UNSUPPORTED_FORMAT:   { title: 'Unsupported format',     hint: 'Use JPEG, PNG, or HEIC.' },
     FILE_TOO_SMALL_BYTES: { title: 'File too small',         hint: 'Upload a higher-quality image.' },
     RESOLUTION_TOO_LOW:   { title: 'Resolution too low',     hint: 'Use an image at least 200×200 px.' },
     IMAGE_TOO_BLURRY:     { title: 'Image is blurry',        hint: 'Try a sharper photo.' },
     NO_FACE_DETECTED:     { title: 'No face detected',       hint: 'Make sure your face is clearly visible.' },
     FACE_TOO_SMALL:       { title: 'Face is too small',      hint: 'Move closer to the camera.' },
     MULTIPLE_FACES:       { title: 'Multiple faces',         hint: 'Only one person should be in the image.' },
     DUPLICATE_IMAGE:      { title: 'Duplicate',              hint: 'You already uploaded this image.' },
     CORRUPT_FILE:         { title: 'Corrupt file',           hint: 'File could not be read. Try another.' },
     PAYLOAD_TOO_LARGE:    { title: 'File too large',         hint: 'Max 15 MB.' },
   }
   ```

6. **Toasts** (sonner)
   - On batch upload: `"Uploading N images…"` then transitions to results.
   - SSE disconnect: error toast (debounced).
   - Delete: `"Image deleted"`.

7. **Loading + empty states**
   - Initial `listImages()` on mount populates the store; show skeletons while loading.
   - When both sections empty: friendly empty state "Drop images above to get started."

8. **Accessibility**
   - Dropzone is keyboard-focusable; activates file picker on Enter/Space.
   - Status changes announced via `aria-live="polite"` region.
   - Images have meaningful alt text (`originalName`).

9. **HEIC preview**
   - HEIC files don't render in `<img>`. Use `heic2any` to convert to a blob URL **only for preview**; never re-upload the converted file.

## Environment

Add `.env.local`:

```
NEXT_PUBLIC_API_URL=http://localhost:4000
NEXT_PUBLIC_DEMO_USER_ID=demo-user
```

## Acceptance checklist

- [ ] Upload accepts JPEG, PNG, HEIC; rejects everything else with a toast + visible card in Rejected.
- [ ] Each uploaded image moves PENDING → PROCESSING → ACCEPTED/REJECTED without page refresh.
- [ ] Backend-driven rejections show the right friendly copy from the table above.
- [ ] Delete removes a card immediately and on the server.
- [ ] Initial page load shows existing images from the backend.
- [ ] Mobile layout: sections stack vertically; cards remain readable.
- [ ] No console errors in normal use.
- [ ] `npm run build` succeeds with strict TypeScript.

## Out of scope

- Authentication (use the hardcoded user header)
- Image editing / cropping
- Pagination beyond the first 24 images (cursor support is there for future)
- E2E tests; a `__tests__/` folder for `lib/validation.ts` + `lib/rejection-copy.ts` is plenty.

---

### Reference: API contract

The canonical schema is `docs/api-contract.yaml` (OpenAPI 3.1) in the backend
repo. The running backend also serves it live:

- Swagger UI: <http://localhost:4000/docs>
- JSON: <http://localhost:4000/openapi.json>  (recommended for `openapi-typescript` codegen)
- YAML: <http://localhost:4000/openapi.yaml>

Codegen example (one-line types):

```bash
npx openapi-typescript http://localhost:4000/openapi.json -o src/lib/api-types.ts
```

Mirror its types exactly in `src/lib/types.ts`. Useful key paths:

- `ImageView` (object returned by all read endpoints)
- `ImageStatus` (enum used everywhere)
- `RejectionCode` (enum — match this to `rejection-copy.ts`)
- `UploadBatchResponse` (`POST /api/images` response — note `accepted` and `rejected` arrays)
- `ImageStatusEvent` (SSE payload)

### Working sequence (one user's first upload)

1. User drops `selfie.heic`.
2. FE validation: format ok, size ok.
3. `uploadImages([file])` → 202, `accepted[0].status = 'PENDING'`.
4. Store updates: card shows "Waiting" badge.
5. SSE arrives: `status: PROCESSING`. Badge changes.
6. SSE arrives: `status: ACCEPTED`. Card moves to Accepted section.
7. (If backend converted HEIC) `serverMeta.displayUrl` is now set; swap card preview from local blob to that URL on next render.
