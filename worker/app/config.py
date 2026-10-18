import os
from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    supabase_url: str
    supabase_service_role_key: str

    r2_account_id: str | None = None
    r2_access_key_id: str
    r2_secret_access_key: str
    r2_bucket: str
    r2_endpoint: str | None = None

    processor_webhook_secret: str = Field(min_length=32)
    webhook_tolerance_seconds: int = 300

    transcribe_backend: Literal["openai", "local", "none"] = "openai"
    openai_api_key: str | None = None
    openai_transcribe_model: str = "whisper-1"
    whisper_model: str = "small"
    whisper_device: str = "auto"
    whisper_compute_type: str = "default"
    transcribe_language: str | None = None  # None = auto-detect

    worker_concurrency: int = 2
    # Process each video inside the webhook request instead of an in-memory
    # queue. Required on Vercel, where an instance may be frozen or stopped
    # once it has responded. Defaults on when running on Vercel.
    process_inline: bool = Field(default_factory=lambda: bool(os.environ.get("VERCEL")))
    # Max videos one /jobs/sweep call processes in inline mode (bounded by function duration).
    sweep_batch_size: int = 1
    keep_source_segments: bool = True
    stale_processing_minutes: int = 30
    ffmpeg_bin: str = "ffmpeg"
    ffprobe_bin: str = "ffprobe"
    ffmpeg_timeout_seconds: int = 1800

    @property
    def s3_endpoint(self) -> str:
        if self.r2_endpoint:
            return self.r2_endpoint
        if not self.r2_account_id:
            raise ValueError("Set R2_ACCOUNT_ID or R2_ENDPOINT")
        return f"https://{self.r2_account_id}.r2.cloudflarestorage.com"


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
