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
    queue = JobQueue(pipeline.process, settings.worker_concurrency)
    queue.start()
    app.state.settings, app.state.db, app.state.queue = settings, db, queue

    # Recover: anything uploaded while we were down, or stuck mid-processing.
    try:
        stale = db.requeue_stale()
        ids = db.list_uploaded()
        for vid in ids:
            queue.enqueue(vid)
        log.info("startup sweep: %d stale reset, %d enqueued", stale, len(ids))
    except Exception:  # noqa: BLE001
        log.exception("startup sweep failed")

    yield
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


class VideoUploaded(BaseModel):
    type: str
    videoId: str


@app.post("/webhooks/video-uploaded", status_code=202)
async def video_uploaded(request: Request) -> dict[str, Any]:
    event = VideoUploaded.model_validate_json(await verified_body(request))
    if event.type != "video.uploaded" or not UUID_RE.match(event.videoId):
        raise HTTPException(status_code=422, detail="unsupported event")
    queued = request.app.state.queue.enqueue(event.videoId)
    return {"accepted": True, "queued": queued}


@app.post("/webhooks/storage-event", status_code=202)
async def storage_event(request: Request) -> dict[str, Any]:
    """R2 event notification relayed by cloudflare/r2-event-forwarder."""
    payload = json.loads(await verified_body(request))
    key = (payload.get("object") or {}).get("key", "")
    m = MANIFEST_RE.match(key)
    if not m or not payload.get("action", "").startswith(("PutObject", "CompleteMultipartUpload", "CopyObject")):
        return {"accepted": True, "ignored": True}
    return {"accepted": True, "queued": request.app.state.queue.enqueue(m.group(1))}


@app.post("/jobs/{video_id}/retry", status_code=202)
async def retry(video_id: str, request: Request) -> dict[str, Any]:
    await verified_body(request)
    if not UUID_RE.match(video_id):
        raise HTTPException(status_code=404)
    reset = request.app.state.db.reset_for_retry(video_id)
    return {"reset": reset, "queued": request.app.state.queue.enqueue(video_id)}


@app.get("/healthz")
async def healthz(request: Request) -> dict[str, Any]:
    s = request.app.state.settings
    return {
        "ok": bool(shutil.which(s.ffmpeg_bin) and shutil.which(s.ffprobe_bin)),
        "queue_depth": request.app.state.queue.depth,
        "transcribe_backend": s.transcribe_backend,
    }
