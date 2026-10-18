"use client";
import { MAX_PARTS_PER_SIGN_REQUEST, PART_SIZE } from "./constants";

export interface SegmentUploadOptions {
  videoId: string;
  segmentIndex: number;
  blob: Blob;
  onProgress?: (uploadedBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
  concurrency?: number;
}

interface InitResponse {
  completed: boolean;
  partSize: number;
  uploadId: string;
  uploadedParts: { partNumber: number; etag: string; size: number }[];
}

class UploadError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

async function postJSON<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new UploadError(data.error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });

/** PUT one part with XHR (fetch has no upload progress). Resolves the part's ETag. */
function putPart(url: string, body: Blob, onProgress: (loaded: number) => void, signal?: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const etag = xhr.getResponseHeader("ETag");
        if (!etag) reject(new UploadError("Missing ETag header — add ExposeHeaders: [\"ETag\"] to the bucket CORS policy"));
        else resolve(etag);
      } else reject(new UploadError(`Part upload failed (${xhr.status})`, xhr.status));
    };
    xhr.onerror = () => reject(new UploadError("Network error"));
    xhr.ontimeout = () => reject(new UploadError("Timed out"));
    xhr.timeout = 10 * 60 * 1000;
    signal?.addEventListener("abort", () => {
      xhr.abort();
      reject(new DOMException("Aborted", "AbortError"));
    });
    xhr.send(body);
  });
}

/**
 * Resumable S3/R2 multipart upload via presigned part URLs:
 *  1. /api/uploads/init      -> uploadId + parts already in R2 (resume)
 *  2. /api/uploads/sign      -> presigned PUT URLs for missing parts
 *  3. PUT parts directly to R2 (parallel, retried with backoff, re-signed on 403)
 *  4. /api/uploads/complete  -> server stitches parts and verifies size
 */
export async function uploadSegment(opts: SegmentUploadOptions): Promise<void> {
  const { videoId, segmentIndex, blob, onProgress, signal } = opts;
  const concurrency = opts.concurrency ?? 3;
  const total = blob.size;

  const init = await postJSON<InitResponse>("/api/uploads/init", { videoId, segmentIndex }, signal);
  if (init.completed) {
    onProgress?.(total, total);
    return;
  }
  if (init.partSize !== PART_SIZE) throw new UploadError("Client/server part size mismatch; reload the page");

  const totalParts = Math.max(1, Math.ceil(total / PART_SIZE));
  const etags = new Map<number, string>();
  for (const p of init.uploadedParts) {
    const expected = Math.min(PART_SIZE, total - (p.partNumber - 1) * PART_SIZE);
    if (p.partNumber <= totalParts && p.size === expected) etags.set(p.partNumber, p.etag);
  }

  const inFlight = new Map<number, number>();
  const doneBytes = () =>
    [...etags.keys()].reduce((sum, n) => sum + Math.min(PART_SIZE, total - (n - 1) * PART_SIZE), 0);
  const report = () => onProgress?.(doneBytes() + [...inFlight.values()].reduce((a, b) => a + b, 0), total);
  report();

  const queue = Array.from({ length: totalParts }, (_, i) => i + 1).filter((n) => !etags.has(n));
  const urls = new Map<number, string>();

  async function sign(partNumbers: number[]) {
    for (let i = 0; i < partNumbers.length; i += MAX_PARTS_PER_SIGN_REQUEST) {
      const batch = partNumbers.slice(i, i + MAX_PARTS_PER_SIGN_REQUEST);
      const res = await postJSON<{ urls: Record<string, string> }>(
        "/api/uploads/sign",
        { videoId, segmentIndex, uploadId: init.uploadId, partNumbers: batch },
        signal,
      );
      for (const [n, u] of Object.entries(res.urls)) urls.set(Number(n), u);
    }
  }
  if (queue.length) await sign(queue);

  async function uploadOne(partNumber: number) {
    const start = (partNumber - 1) * PART_SIZE;
    const chunk = blob.slice(start, Math.min(start + PART_SIZE, total));
    for (let attempt = 0; ; attempt++) {
      try {
        const etag = await putPart(urls.get(partNumber)!, chunk, (loaded) => {
          inFlight.set(partNumber, loaded);
          report();
        }, signal);
        inFlight.delete(partNumber);
        etags.set(partNumber, etag);
        report();
        return;
      } catch (err) {
        inFlight.delete(partNumber);
        if ((err as Error).name === "AbortError" || attempt >= 5) throw err;
        if ((err as UploadError).status === 403) await sign([partNumber]); // URL expired
        await sleep(Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 500, signal);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length) await uploadOne(queue.shift()!);
    }),
  );

  await postJSON(
    "/api/uploads/complete",
    {
      videoId,
      segmentIndex,
      uploadId: init.uploadId,
      parts: [...etags.entries()].map(([partNumber, etag]) => ({ partNumber, etag })),
    },
    signal,
  );
  onProgress?.(total, total);
}
