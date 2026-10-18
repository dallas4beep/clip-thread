import "server-only";
import { createHmac } from "node:crypto";
import { serverEnv } from "@/lib/env";

export type ProcessorEvent = { type: "video.uploaded"; videoId: string };

/**
 * Signs and POSTs an event to the FastAPI processor.
 * Signature: hex(HMAC-SHA256(secret, `${timestamp}.${rawBody}`)), checked with a 5 min replay window.
 * Best-effort: the processor also sweeps for `uploaded` videos on startup and
 * the optional R2 event forwarder delivers the same event, so a failure here
 * delays processing but never loses it.
 */
export async function notifyProcessor(event: ProcessorEvent): Promise<{ delivered: boolean }> {
  const env = serverEnv();
  if (!env.PROCESSOR_URL) return { delivered: false };

  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", env.PROCESSOR_WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest("hex");

  try {
    const res = await fetch(new URL("/webhooks/video-uploaded", env.PROCESSOR_URL), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Clipthread-Timestamp": timestamp,
        "X-Clipthread-Signature": `sha256=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.warn(`processor webhook returned ${res.status}`);
    return { delivered: res.ok };
  } catch (err) {
    console.warn("processor webhook failed", err);
    return { delivered: false };
  }
}
