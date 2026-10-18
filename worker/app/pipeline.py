"""uploaded -> processing -> pending_review: stitch segments, poster, transcribe, captions."""

import logging
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from .captions import to_srt, to_vtt
from .config import Settings
from .db import Database
from .media import FFmpeg
from .storage import Storage
from .transcribe import Transcriber

log = logging.getLogger(__name__)


class Pipeline:
    def __init__(self, settings: Settings, db: Database, storage: Storage, ffmpeg: FFmpeg, transcriber: Transcriber | None):
        self.settings = settings
        self.db = db
        self.storage = storage
        self.ffmpeg = ffmpeg
        self.transcriber = transcriber

    def process(self, video_id: str) -> str:
        """Returns the outcome: "skipped", "pending_review" or "failed"."""
        video = self.db.claim(video_id)
        if video is None:
            log.info("video %s not claimable (already processed or in progress)", video_id)
            return "skipped"
        log.info("processing video %s", video_id)
        prefix = video["source_prefix"]
        try:
            with tempfile.TemporaryDirectory(prefix=f"ct-{video_id[:8]}-") as tmp:
                result = self._run(video_id, prefix, Path(tmp))
            self.db.update_video(
                video_id,
                status="pending_review",
                processed_at=datetime.now(timezone.utc).isoformat(),
                **result,
            )
            log.info("video %s ready for review", video_id)
            return "pending_review"
        except Exception as exc:  # noqa: BLE001 — any failure must land in the DB, not just the log
            log.exception("video %s failed", video_id)
            self.db.update_video(video_id, status="failed", processing_error=f"{type(exc).__name__}: {exc}"[:2000])
            return "failed"

    def _run(self, video_id: str, prefix: str, work: Path) -> dict:
        segments = self.db.segments(video_id)
        if not segments:
            raise RuntimeError("submission has no segments")
        if any(not s["upload_completed_at"] for s in segments):
            raise RuntimeError("submission has incomplete segment uploads")

        # 1. Download + probe
        sources: list[tuple[Path, object]] = []
        for s in segments:
            ext = Path(s["object_key"]).suffix or ".webm"
            local = self.storage.download(s["object_key"], work / f"src-{s['segment_index']:02d}{ext}")
            sources.append((local, self.ffmpeg.probe(local)))

        # 2. Normalize to a common size (orientation of the first take) and concatenate
        size = self.ffmpeg.output_size(sources[0][1])  # type: ignore[arg-type]
        normalized = [
            self.ffmpeg.normalize(path, work / f"norm-{i:02d}.mp4", size, probe.has_audio)  # type: ignore[attr-defined]
            for i, (path, probe) in enumerate(sources)
        ]
        final = self.ffmpeg.concat(normalized, work / "final.mp4")
        duration = self.ffmpeg.probe(final).duration or 0.0

        # 3. Poster frame
        poster = self.ffmpeg.poster(final, work / "poster.jpg", at=min(1.5, duration / 3) if duration else 0)

        final_key = self.storage.upload(final, f"{prefix}final.mp4", "video/mp4")
        poster_key = self.storage.upload(poster, f"{prefix}poster.jpg", "image/jpeg")
        result: dict = {
            "final_key": final_key,
            "poster_key": poster_key,
            "duration_seconds": round(duration, 3),
            "processing_error": None,
        }

        # 4. Transcribe. A transcription failure should not block human review.
        if self.transcriber is not None:
            try:
                audio = self.ffmpeg.extract_audio(final, work / "audio.mp3")
                t = self.transcriber.transcribe(audio, duration, work)
                vtt, srt = to_vtt(t.segments), to_srt(t.segments)
                vtt_key = self.storage.put_text(f"{prefix}captions.vtt", vtt, "text/vtt; charset=utf-8")
                srt_key = self.storage.put_text(f"{prefix}captions.srt", srt, "application/x-subrip; charset=utf-8")
                self.db.upsert_transcript({
                    "video_id": video_id,
                    "language": t.language,
                    "text": t.text,
                    "segments": [s.to_dict() for s in t.segments],
                    "vtt": vtt,
                    "srt": srt,
                    "vtt_key": vtt_key,
                    "srt_key": srt_key,
                    "model": t.model,
                })
            except Exception as exc:  # noqa: BLE001
                log.exception("transcription failed for %s", video_id)
                result["processing_error"] = f"Transcription failed: {exc}"[:2000]

        if not self.settings.keep_source_segments:
            self.storage.delete([s["object_key"] for s in segments])
        return result
