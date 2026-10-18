# Clipthread

A self-hosted platform for collecting video stories, moderating them and publishing them. It works like Vocal Video or Soapboxx: guided recording, a legal release step, moderation, and an embeddable wall.

```
clipthread/
├── web/                     Next.js 15 (App Router) + TypeScript + Tailwind v4
│   ├── app/c/[slug]/        (1) prompt-flow recorder page (modal)
│   ├── components/submission/  PromptRecorder, ConsentGate (2), SignaturePad, SubmissionFlow
│   ├── hooks/               useMediaStream, useSegmentRecorder (MediaRecorder), useCountdown
│   ├── lib/upload/          (3) resumable multipart client + IndexedDB segment store
│   ├── app/api/submissions  (2) consent-gated submission creation, finalize
│   ├── app/api/uploads/     (3) init/resume, sign parts, complete
│   ├── app/admin/moderation (5) moderation dashboard
│   ├── app/api/public/      (6) wall feed + captions for the widget
│   └── public/embed.js      (6) zero-dependency embed widget
├── worker/                  (4) FastAPI + FFmpeg + Whisper processor
├── supabase/                migrations (schema, RPCs, RLS), seed, CLI config
├── cloudflare/r2-event-forwarder/  R2 event → Queue → signed webhook relay
└── config/                  prompt-flow JSON Schema, R2 CORS + lifecycle policies
```

## How a submission flows

```
Browser                         Next.js API                    R2              FastAPI worker
───────                         ───────────                    ──              ──────────────
record prompt 1..n (MediaRecorder, 1s chunks, saved to IndexedDB)
review / retake
ConsentGate ───────────────────▶ POST /api/submissions
                                  validate flow + consent
                                  HMAC-sign canonical payload
                                  rpc create_submission (atomic:
                                  video + segments + consent)
per segment:
  ───────────────────────────────▶ POST /api/uploads/init ─────▶ CreateMultipartUpload (or ListParts to resume)
  ───────────────────────────────▶ POST /api/uploads/sign  (presigned UploadPart URLs)
  PUT 8 MiB parts ─────────────────────────────────────────────▶ (direct, parallel, retried)
  ───────────────────────────────▶ POST /api/uploads/complete ─▶ CompleteMultipartUpload + size check
POST /finalize ──────────────────▶ write manifest.json ────────▶ object-create event ─▶ Queue ─▶ forwarder ─┐
                                   status=uploaded                                                        │
                                   signed webhook ─────────────────────────────────────────────▶ /webhooks/*
                                                                                                claim (uploaded→processing)
                                                                                                normalize + concat → final.mp4
                                                                                                poster.jpg, audio.mp3
                                                                                                Whisper → .vtt/.srt
                                                                                                status=pending_review
Moderator ──▶ /admin/moderation ── rpc moderate_video ──▶ approved / rejected / flagged (+ audit log)
Third-party site ──▶ embed.js ──▶ GET /api/public/walls/:slug (approved only, presigned URLs)
```

### Video statuses

`draft` → `uploaded` → `processing` → **`pending_review`** → `approved` | `rejected` | `flagged`. A failed processing run sets `failed`, which can be retried.

## The six modules

### 1. Prompt flow and question injector
- Each campaign stores its flow as JSON in `campaigns.prompt_flow`. It is validated at runtime by `web/lib/prompt-flow.ts` (zod). `config/prompt-flow.schema.json` holds the same rules for editors and CI.
- The steps are: intro, then the details fields, then camera permission, then for each prompt a prep countdown, a timed recording (with minimum and maximum length) and a review with limited retakes. After that come the full review and the consent step.
- Each prompt is recorded as its own segment. `MediaRecorder` emits a chunk every 1 s. Accepted takes are written to IndexedDB, so a crash or reload doesn't lose them.
- Recording format: VP9/VP8 WebM is used where supported, with H.264 MP4 as the fallback for Safari. The worker normalizes both.

```jsonc
{
  "version": 1,
  "fields":  [{ "id": "name", "label": "Your name", "required": true }],
  "prompts": [
    { "id": "intro", "title": "Introduce yourself", "prepSeconds": 5, "minSeconds": 3, "maxSeconds": 30 },
    { "id": "story", "title": "What changed for you?", "maxSeconds": 120 },
    { "id": "cta",   "title": "Who should try us?",   "maxSeconds": 45, "optional": true }
  ],
  "recording": { "maxRetakes": 3, "maxSegmentBytes": 524288000 }
}
```

### 2. Legal consent and release gate
- `ConsentGate` is a step inside the submission modal. Its submit button stays disabled until the person has scrolled to the end of the terms, ticked every required box and typed their legal name. A drawn signature is optional.
- The server is the real gate. `POST /api/submissions` re-checks every required box against the current `consent_documents` row and rejects the request if the document's SHA-256 has changed. No upload URL is ever issued for a video without a consent record.
- Each record holds: user ID, IP address, user agent, client and server timestamps, the document version and its hash, the signature hash, and the canonical payload. It has three layers of tamper protection:
  1. **HMAC-SHA256** of the canonical payload, using `CONSENT_SIGNING_SECRET`. The secret lives only on the server.
  2. A **hash chain** in Postgres: each `record_hash = sha256(prev_hash ‖ payload_sha256 ‖ hmac)`, written by a trigger under an advisory lock.
  3. **Append-only triggers** that block `UPDATE` and `DELETE`, even for the service role.
- To audit everything, run `cd web && node --env-file=.env.local --experimental-strip-types scripts/verify-consent.ts`. It checks every hash, every HMAC and the whole chain.

### 3. Resumable upload pipeline
- Uploads use S3 multipart with presigned part URLs. Video bytes go straight from the browser to R2 and never pass through the serverless functions. Parts are 8 MiB, with 3 uploading in parallel, exponential-backoff retries, and fresh URLs requested automatically on a 403.
- Resuming works because the multipart `upload_id` is saved on the `video_segments` row. `/api/uploads/init` returns the parts already in R2 (via `ListParts`), and the client re-reads the blob from IndexedDB. Closing the tab and reopening the campaign page continues where the upload stopped.
- Object keys are always built on the server from database IDs. Each route checks ownership and `status = 'draft'`. `/complete` checks the object's size against the size that was declared, and deletes the object if they differ.
- **Why not tus?** R2 doesn't speak the tus protocol. Running tus would need a tusd server in the middle, which would stream every byte through your infrastructure. Multipart with presigned URLs gives the same resume behaviour directly against R2. If you'd rather use Supabase Storage, it supports tus natively: swap `lib/upload/multipart-client.ts` for `tus-js-client`.

### 4. Webhooks and Whisper transcription (`worker/`)
- There are two ways a job reaches the worker, and receiving both is harmless:
  - a signed webhook from `/finalize`
  - an R2 `object-create` event on `manifest.json`, relayed by `cloudflare/r2-event-forwarder`
- Jobs are claimed atomically (`uploaded → processing`), so duplicate deliveries do nothing. On startup the worker re-queues anything left in `uploaded` and any job stuck in `processing` for more than 30 minutes.
- Steps:
  1. FFmpeg normalizes each segment to H.264/AAC (letterboxed, orientation taken from the first take, per-take loudness normalization) and concatenates them losslessly into `final.mp4` with `+faststart`.
  2. It extracts a poster frame and 16 kHz mono audio.
  3. Whisper transcribes the audio.
  4. The worker writes readable WebVTT and SRT files (at most 2 lines of 42 characters per cue).
- Transcription backends (`TRANSCRIBE_BACKEND`):
  - `openai`: the `whisper-1` API. Audio over 24 MB is split into 10-minute chunks and the timestamps are offset back into place.
  - `local`: `faster-whisper`. Install with `requirements-local.txt`.
  - `none`
- If transcription fails, the video still goes to `pending_review` with a note, so review is never blocked. Captions are stored in both Postgres and R2.

### 5. Moderation dashboard (`/admin/moderation`)
- Tabs by status with counts. The player shows captions, and the transcript is clickable to seek, with the current line highlighted.
- Each item shows a consent panel with the signer, timestamp, payload hash and chain hash. If a video has no consent record, a red warning tells moderators not to publish it.
- Buttons for Approve, Reject and Flag, plus an optional note. Shortcuts: `A`/`R`/`F` to decide, `J`/`K` to move between items. The list updates live through Supabase Realtime.
- Decisions go through the `moderate_video` RPC. It checks the moderator role, allows only valid status transitions, and writes to `moderation_events`, all in one transaction.

### 6. Embeddable video wall (`public/embed.js`)
```html
<div data-clipthread-wall="customer-stories" data-layout="carousel" data-primary-color="#e11d48"></div>
<script src="https://YOUR_APP/embed.js" async></script>
```
- About 8 KB, with no dependencies. It renders inside Shadow DOM so the host site's CSS can't break it, and it only loads once it scrolls near the viewport.
- Layouts are a grid or a carousel. Clicking a video opens a modal player with Esc to close, focus handling and restored scroll.
- Branding comes from the campaign and can be overridden with `data-*` attributes.
- Captions are fetched as text and attached as a `blob:` track. A cross-origin `<track>` would otherwise need CORS on the video file too.
- To restrict which sites may embed a wall, set `campaigns.allowed_embed_origins`.
- There is a demo page at `/embed-demo.html`.

## Setup

### Prerequisites
Node 20+, Python 3.11+, FFmpeg, the [Supabase CLI](https://supabase.com/docs/guides/cli), and a Cloudflare account with R2 enabled.

### 1. Database
```bash
supabase start                  # local stack; prints the API URL + anon/service keys
supabase db reset               # applies migrations + seed.sql
# hosted project instead:  supabase link --project-ref <ref> && supabase db push
```
For a hosted project, turn on these settings in the dashboard:
- **Auth → Anonymous sign-ins.** Visitors can then record without creating an account, and every consent record still gets a user ID. Turn on CAPTCHA protection as well.
- **Database → Replication.** `videos` must be in `supabase_realtime`. The migration adds it.

To promote a moderator, have them sign in once via `/login`, then run:
```sql
update public.profiles set role = 'admin'
where id = (select id from auth.users where email = 'you@company.com');
```

### 2. Cloudflare R2
```bash
npx wrangler r2 bucket create clipthread-media
```
- Under **R2 → bucket → Settings → CORS**, paste `config/r2-cors.json` with your app origins. `ExposeHeaders: ["ETag"]` is required for multipart uploads.
- Add the lifecycle rule from `config/r2-lifecycle.json`. It aborts abandoned multipart uploads after 7 days.
- Under **R2 → Manage API tokens**, create an *Object Read & Write* token scoped to the bucket.

Keep the bucket **private**. All reads use short-lived presigned URLs, and the public API only signs URLs for approved videos.

### 3. Web app
```bash
cd web
cp .env.example .env.local        # fill in Supabase, R2, and two `openssl rand -hex 32` secrets
npm install
npm run dev                       # http://localhost:3000  → /c/customer-stories
npm test && npm run typecheck
```

### 4. Processing worker
```bash
cd worker
cp .env.example .env              # same R2 creds; PROCESSOR_WEBHOOK_SECRET must match web
python -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt   # or requirements-local.txt for local Whisper
uvicorn app.main:app --port 8000
pytest
```
Or with Docker: `docker compose up worker`. The compose file also starts MinIO as a local, offline stand-in for R2. Set `R2_ENDPOINT=http://127.0.0.1:9000` in `web/.env.local` to use it.

### 5. Optional: R2 event forwarder
```bash
npx wrangler queues create clipthread-r2-events
npx wrangler queues create clipthread-r2-events-dlq
npx wrangler r2 bucket notification create clipthread-media \
  --event-type object-create --queue clipthread-r2-events --suffix manifest.json
cd cloudflare/r2-event-forwarder && npm install
npx wrangler secret put PROCESSOR_WEBHOOK_SECRET
npm run deploy                     # set PROCESSOR_URL in wrangler.toml first
```
If you rely only on storage events, leave `PROCESSOR_URL` empty in the web app.

## Deploying to Vercel (services)

`vercel.json` deploys both apps as one Vercel project:

| Service | Root | Runtime | Public? |
|---|---|---|---|
| `web` | `web/` | Next.js | Yes, all paths (`/(.*)`) |
| `worker` | `worker/` | Container (`worker/Dockerfile`, includes FFmpeg) | No, internal only |

- `web` reaches `worker` through a **service binding**, which injects the worker's internal URL as `PROCESSOR_URL`. Don't set `PROCESSOR_URL` yourself on Vercel.
- On Vercel the worker runs with `PROCESS_INLINE` on (automatic when `VERCEL` is set). Each video is processed inside the webhook request instead of a background queue, because an instance may stop once it has responded. `/api/submissions/[id]/finalize` makes that call from `after()`, with `maxDuration = 300`.
- **Recovery:** `GET /api/cron/process-pending` (protected by `CRON_SECRET`) calls the worker's `/jobs/sweep`. It resets stuck jobs and processes any upload whose webhook was missed. `vercel.json` runs it once a day (04:17 UTC), which is the most a Hobby plan allows. On Pro, change the schedule to every 10 minutes, e.g. `*/10 * * * *`.
- **Environment variables:** set the `web` ones from `web/.env.example` and the `worker` ones from `worker/.env.example` (Supabase, R2, secrets, Whisper) in the Vercel project.
- **Local testing:** `vercel dev` runs both services and injects the binding.
- The optional Cloudflare forwarder needs a **public** worker URL, so it doesn't work while the worker is internal-only. Either rely on the binding plus the cron, or add a public rewrite such as `/processor/(.*)` with a `request.path` transform, and set the forwarder's `PROCESSOR_URL` to `https://<domain>/processor/`.

## Production notes and limits
- **Rate limiting.** `/api/submissions` and `/api/uploads/*` should sit behind a rate limiter, such as Cloudflare WAF rules or Upstash. They don't have one built in.
- **Worker scaling.** The queue lives inside the process (`worker/app/jobs.py`). Correctness comes from the claim in the database, so several replicas won't double-process a video. They would, however, each run the startup sweep. For real fan-out, swap the queue for Arq, Celery or Cloudflare Queues.
- **Erasure requests.** Consent records are append-only on purpose. To honour a takedown, set the video to `rejected` and delete its R2 objects. Keep the consent record as evidence of what was agreed. Get legal advice for your jurisdiction.
- **Key rotation.** If you rotate `CONSENT_SIGNING_SECRET`, keep the old value in `CONSENT_SIGNING_SECRET_PREVIOUS` so the verifier can still check older records.
- **Database types.** `npm run gen:types` generates typed Supabase clients. The code currently uses narrow inline types.
- **Discussion threads.** The Discourse-style threads aren't built yet. They belong in a later migration, with `threads` and `posts` tables keyed to `videos.id`.
