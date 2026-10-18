"""Whisper backends: OpenAI API (default) or local faster-whisper."""

import logging
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .captions import Segment
from .config import Settings
from .media import FFmpeg

log = logging.getLogger(__name__)

API_MAX_BYTES = 24 * 1024 * 1024  # OpenAI limit is 25 MB per request
CHUNK_SECONDS = 600


@dataclass
class Transcript:
    text: str
    language: str | None
    segments: list[Segment]
    model: str


class Transcriber(Protocol):
    def transcribe(self, audio: Path, duration: float, workdir: Path) -> Transcript: ...


# Whisper's verbose_json reports languages by name; captions want BCP-47 codes.
_LANG_CODES = {
    "english": "en", "spanish": "es", "french": "fr", "german": "de", "italian": "it", "portuguese": "pt",
    "dutch": "nl", "japanese": "ja", "chinese": "zh", "korean": "ko", "russian": "ru", "arabic": "ar",
    "hindi": "hi", "polish": "pl", "turkish": "tr", "swedish": "sv", "ukrainian": "uk",
}


def _lang(value: str | None) -> str | None:
    if not value:
        return None
    v = value.lower()
    return v if len(v) <= 3 else _LANG_CODES.get(v, v)


class OpenAIWhisper:
    def __init__(self, settings: Settings, ffmpeg: FFmpeg):
        from openai import OpenAI

        if not settings.openai_api_key:
            raise RuntimeError("OPENAI_API_KEY is required for TRANSCRIBE_BACKEND=openai")
        self.client = OpenAI(api_key=settings.openai_api_key, max_retries=4, timeout=600)
        self.model = settings.openai_transcribe_model
        self.language = settings.transcribe_language
        self.ffmpeg = ffmpeg

    def _chunks(self, audio: Path, duration: float, workdir: Path) -> list[tuple[Path, float]]:
        if audio.stat().st_size <= API_MAX_BYTES:
            return [(audio, 0.0)]
        n = math.ceil(duration / CHUNK_SECONDS)
        return [
            (self.ffmpeg.cut_audio(audio, workdir / f"audio-{i:03d}.mp3", i * CHUNK_SECONDS, CHUNK_SECONDS), i * CHUNK_SECONDS)
            for i in range(n)
        ]

    def transcribe(self, audio: Path, duration: float, workdir: Path) -> Transcript:
        segments: list[Segment] = []
        texts: list[str] = []
        language: str | None = None
        for path, offset in self._chunks(audio, duration, workdir):
            with path.open("rb") as fh:
                kwargs = {"model": self.model, "file": fh, "response_format": "verbose_json", "timestamp_granularities": ["segment"]}
                if self.language:
                    kwargs["language"] = self.language
                res = self.client.audio.transcriptions.create(**kwargs)
            language = language or _lang(getattr(res, "language", None))
            texts.append(res.text.strip())
            for s in getattr(res, "segments", None) or []:
                segments.append(Segment(float(s.start) + offset, float(s.end) + offset, s.text.strip()))
        return Transcript(" ".join(t for t in texts if t), language, segments, self.model)


class LocalWhisper:
    def __init__(self, settings: Settings):
        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError("pip install -r requirements-local.txt for TRANSCRIBE_BACKEND=local") from exc
        self.model_name = settings.whisper_model
        self.language = settings.transcribe_language
        log.info("loading faster-whisper model %s", self.model_name)
        self.model = WhisperModel(self.model_name, device=settings.whisper_device, compute_type=settings.whisper_compute_type)

    def transcribe(self, audio: Path, duration: float, workdir: Path) -> Transcript:
        seg_iter, info = self.model.transcribe(str(audio), language=self.language, vad_filter=True, beam_size=5)
        segments = [Segment(float(s.start), float(s.end), s.text.strip()) for s in seg_iter]
        return Transcript(" ".join(s.text for s in segments), info.language, segments, f"faster-whisper/{self.model_name}")


def build_transcriber(settings: Settings, ffmpeg: FFmpeg) -> Transcriber | None:
    if settings.transcribe_backend == "none":
        return None
    if settings.transcribe_backend == "local":
        return LocalWhisper(settings)
    return OpenAIWhisper(settings, ffmpeg)
