import asyncio
import json
import logging
import re
import shutil
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from .config import get_settings
from .db import Database
from .jobs import JobQueue
from .media import FFmpeg
from .pipeline import Pipeline
from .security import SignatureError, verify
from .storage import Storage
from .transcribe import build_transcriber

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("clipthread.worker")

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
MANIFEST_RE = re.compile(r"^submissions/([0-9a-f-]{36})/manifest\.json$")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    db = Database(settings)
    ffmpeg = FFmpeg(settings.ffmpeg_bin, settings.ffprobe_bin, settings.ffmpeg_timeout_seconds)
    pipeline = Pipeline(settings, db, Storage(settings), ffmpeg, build_transcriber(settings, ffmpeg))
    queue: JobQueue | None = None
    app.state.settings, app.state.db, app.state.pipeline = settings, db, pipeline

    if settings.process_inline:
        # Serverless (Vercel): no background work outside a request. Recovery
        # happens through POST /jobs/sweep instead of a startup sweep.
        log.info("inline processing mode")
    else:
        queue = JobQueue(pipeline.process, settings.worker_concurrency)
        queue.start()
        # Recover: anything uploaded while we were down, or stuck mid-processing.
        try:
            stale = db.requeue_stale()
            ids = db.list_uploaded()
            for vid in ids:
                queue.enqueue(vid)
            log.info("startup sweep: %d stale reset, %d enqueued", stale, len(ids))
        except Exception:  # noqa: BLE001
            log.exception("startup sweep failed")
    app.state.queue = queue

    yield
    if queue is not None:
        await queue.stop()
    db.close()


app = FastAPI(title="Clipthread processor", lifespan=lifespan)


async def verified_body(request: Request) -> bytes:
    body = await request.body()
    try:
        verify(
            request.app.state.settings.processor_webhook_secret,
            request.headers.get("x-clipthread-timestamp"),
            request.headers.get("x-clipthread-signature"),
            body,
            request.app.state.settings.webhook_tolerance_seconds,
        )
    except SignatureError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    return body


async def dispatch(request: Request, video_id: str) -> dict[str, Any]:
    """Process now (inline mode) or hand off to the background queue."""
    queue: JobQueue | None = request.app.state.queue
    if queue is None:
        outcome = await asyncio.to_thread(request.app.state.pipeline.process, video_id)
        return {"videoId": video_id, "outcome": outcome}
    return {"videoId": video_id, "queued": queue.enqueue(video_id)}


class VideoUploaded(BaseModel):
    type: str
    videoId: str


@app.post("/webhooks/video-uploaded", status_code=202)
async def video_uploaded(request: Request) -> dict[str, Any]:
    event = VideoUploaded.model_validate_json(await verified_body(request))
    if event.type != "video.uploaded" or not UUID_RE.match(event.videoId):
        raise HTTPException(status_code=422, detail="unsupported event")
    return {"accepted": True, **await dispatch(request, event.videoId)}


@app.post("/webhooks/storage-event", status_code=202)
async def storage_event(request: Request) -> dict[str, Any]:
    """R2 event notification relayed by cloudflare/r2-event-forwarder."""
    payload = json.loads(await verified_body(request))
    key = (payload.get("object") or {}).get("key", "")
    m = MANIFEST_RE.match(key)
    if not m or not payload.get("action", "").startswith(("PutObject", "CompleteMultipartUpload", "CopyObject")):
        return {"accepted": True, "ignored": True}
    return {"accepted": True, **await dispatch(request, m.group(1))}


@app.post("/jobs/{video_id}/retry", status_code=202)
async def retry(video_id: str, request: Request) -> dict[str, Any]:
    await verified_body(request)
    if not UUID_RE.match(video_id):
        raise HTTPException(status_code=404)
    reset = request.app.state.db.reset_for_retry(video_id)
    return {"reset": reset, **await dispatch(request, video_id)}


@app.post("/jobs/sweep")
async def sweep(request: Request) -> dict[str, Any]:
    """Recovery: reset stuck jobs and pick up uploads whose webhook was missed.

    Called by web's /api/cron/process-pending. In inline mode only
    `sweep_batch_size` videos are processed per call to stay within the
    function's max duration; the next call picks up the rest.
    """
    await verified_body(request)
    s = request.app.state.settings
    db: Database = request.app.state.db
    stale = await asyncio.to_thread(db.requeue_stale)
    limit = s.sweep_batch_size if request.app.state.queue is None else 100
    ids = await asyncio.to_thread(db.list_uploaded, limit)
    results = [await dispatch(request, vid) for vid in ids]
    return {"staleReset": stale, "results": results}


@app.get("/healthz")
async def healthz(request: Request) -> dict[str, Any]:
    s = request.app.state.settings
    queue: JobQueue | None = request.app.state.queue
    return {
        "ok": bool(shutil.which(s.ffmpeg_bin) and shutil.which(s.ffprobe_bin)),
        "mode": "queue" if queue else "inline",
        "queue_depth": queue.depth if queue else 0,
        "transcribe_backend": s.transcribe_backend,
    }
