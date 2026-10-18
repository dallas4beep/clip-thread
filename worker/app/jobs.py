"""In-process async job queue. Blocking FFmpeg/Whisper work runs in threads.

Correctness doesn't depend on this queue: the DB claim (status uploaded ->
processing) makes jobs idempotent, and the startup sweep re-enqueues anything
that was missed. Swap for Arq/Celery/Cloudflare Queues if you need multi-host fan-out.
"""

import asyncio
import logging
from collections.abc import Callable

log = logging.getLogger(__name__)


class JobQueue:
    def __init__(self, handler: Callable[[str], None], concurrency: int = 2):
        self._handler = handler
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        self._pending: set[str] = set()
        self._workers: list[asyncio.Task] = []
        self._concurrency = concurrency

    def start(self) -> None:
        self._workers = [asyncio.create_task(self._worker(i)) for i in range(self._concurrency)]

    async def stop(self) -> None:
        for w in self._workers:
            w.cancel()
        await asyncio.gather(*self._workers, return_exceptions=True)

    def enqueue(self, video_id: str) -> bool:
        if video_id in self._pending:
            return False
        self._pending.add(video_id)
        self._queue.put_nowait(video_id)
        return True

    @property
    def depth(self) -> int:
        return self._queue.qsize()

    async def _worker(self, n: int) -> None:
        while True:
            video_id = await self._queue.get()
            try:
                await asyncio.to_thread(self._handler, video_id)
            except Exception:  # noqa: BLE001
                log.exception("worker %d: job %s crashed", n, video_id)
            finally:
                self._pending.discard(video_id)
                self._queue.task_done()
