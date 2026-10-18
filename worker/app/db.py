"""Minimal PostgREST client using the Supabase service role (bypasses RLS)."""

from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

from .config import Settings


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Database:
    def __init__(self, settings: Settings):
        self._client = httpx.Client(
            base_url=f"{settings.supabase_url.rstrip('/')}/rest/v1",
            headers={
                "apikey": settings.supabase_service_role_key,
                "Authorization": f"Bearer {settings.supabase_service_role_key}",
                "Content-Type": "application/json",
            },
            timeout=30,
        )
        self._stale_minutes = settings.stale_processing_minutes

    def close(self) -> None:
        self._client.close()

    def _patch(self, table: str, params: dict[str, str], body: dict[str, Any]) -> list[dict[str, Any]]:
        r = self._client.patch(f"/{table}", params=params, json=body, headers={"Prefer": "return=representation"})
        r.raise_for_status()
        return r.json()

    def claim(self, video_id: str) -> dict[str, Any] | None:
        """Atomically move uploaded -> processing. Returns None if someone else claimed it (idempotent webhooks)."""
        rows = self._patch(
            "videos",
            {"id": f"eq.{video_id}", "status": "eq.uploaded"},
            {"status": "processing", "processing_started_at": _now(), "processing_error": None},
        )
        return rows[0] if rows else None

    def reset_for_retry(self, video_id: str) -> bool:
        rows = self._patch("videos", {"id": f"eq.{video_id}", "status": "eq.failed"}, {"status": "uploaded"})
        return bool(rows)

    def requeue_stale(self) -> int:
        """Videos stuck in processing (worker crashed mid-job) go back to uploaded."""
        cutoff = (datetime.now(timezone.utc) - timedelta(minutes=self._stale_minutes)).isoformat()
        rows = self._patch(
            "videos",
            {"status": "eq.processing", "processing_started_at": f"lt.{cutoff}"},
            {"status": "uploaded"},
        )
        return len(rows)

    def list_uploaded(self, limit: int = 100) -> list[str]:
        r = self._client.get(
            "/videos", params={"select": "id", "status": "eq.uploaded", "order": "submitted_at.asc", "limit": str(limit)}
        )
        r.raise_for_status()
        return [row["id"] for row in r.json()]

    def segments(self, video_id: str) -> list[dict[str, Any]]:
        r = self._client.get(
            "/video_segments",
            params={
                "select": "segment_index,prompt_id,object_key,mime_type,size_bytes,duration_ms,upload_completed_at",
                "video_id": f"eq.{video_id}",
                "order": "segment_index.asc",
            },
        )
        r.raise_for_status()
        return r.json()

    def update_video(self, video_id: str, **fields: Any) -> None:
        self._patch("videos", {"id": f"eq.{video_id}"}, fields)

    def upsert_transcript(self, row: dict[str, Any]) -> None:
        r = self._client.post(
            "/transcripts",
            params={"on_conflict": "video_id"},
            json=row,
            headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
        )
        r.raise_for_status()
