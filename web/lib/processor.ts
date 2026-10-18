import "server-only";
import { createHmac } from "node:crypto";
import { serverEnv } from "@/lib/env";

export type ProcessorEvent = { type: "video.uploaded"; videoId: string };

/**
 * Builds a URL on the processor. On Vercel, PROCESSOR_URL is injected by the
 * `worker` service binding (vercel.json); elsewhere it is set by hand. The base
 * may carry a path, so join relative to it instead of resetting to "/".
 */
function processorUrl(base: string, path: string) {
  return new URL(path.replace(/^\//, ""), base.endsWith("/") ? base : `${base}/`);
}

/**
 * Signs and POSTs to the FastAPI processor.
 * Signature: hex(HMAC-SHA256(secret, `${timestamp}.${rawBody}`)), checked with a 5 min replay window.
 */
async function callProcessor(path: string, payload: unknown, timeoutMs: number): Promise<Response | null> {
  const env = serverEnv();
  if (!env.PROCESSOR_URL) return null;

  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", env.PROCESSOR_WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest("hex");

  return fetch(processorUrl(env.PROCESSOR_URL, path), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Clipthread-Timestamp": timestamp,
      "X-Clipthread-Signature": `sha256=${signature}`,
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * Notifies the processor of a finished upload. On Vercel the worker processes
 * the video before responding (inline mode), so callers should run this from
 * `after()` with a long timeout. Best-effort: /api/cron/process-pending and the
 * optional R2 event forwarder pick up anything this misses.
 */
export async function notifyProcessor(event: ProcessorEvent, timeoutMs = 5000): Promise<{ delivered: boolean }> {
  try {
    const res = await callProcessor("webhooks/video-uploaded", event, timeoutMs);
    if (!res) return { delivered: false };
    if (!res.ok) console.warn(`processor webhook returned ${res.status}`);
    return { delivered: res.ok };
  } catch (err) {
    console.warn("processor webhook failed", err);
    return { delivered: false };
  }
}

/** Asks the processor to reset stuck jobs and process missed uploads. */
export async function sweepProcessor(timeoutMs: number): Promise<unknown> {
  const res = await callProcessor("jobs/sweep", {}, timeoutMs);
  if (!res) throw new Error("PROCESSOR_URL is not configured");
  if (!res.ok) throw new Error(`processor sweep returned ${res.status}`);
  return res.json();
}
