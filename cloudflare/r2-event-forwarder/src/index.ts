/**
 * R2 event notifications can only target a Cloudflare Queue. This Worker
 * consumes that queue and relays each event to the FastAPI processor as an
 * HMAC-signed webhook (same signature scheme as web/lib/processor.ts).
 */
export interface Env {
  PROCESSOR_URL: string;
  PROCESSOR_WEBHOOK_SECRET: string;
}

interface R2EventMessage {
  account: string;
  bucket: string;
  action: string;
  object: { key: string; size?: number; eTag?: string };
  eventTime: string;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async queue(batch: MessageBatch<R2EventMessage>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      const body = JSON.stringify(msg.body);
      const timestamp = Math.floor(Date.now() / 1000).toString();
      try {
        const base = env.PROCESSOR_URL.endsWith("/") ? env.PROCESSOR_URL : `${env.PROCESSOR_URL}/`;
        const res = await fetch(new URL("webhooks/storage-event", base), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Clipthread-Timestamp": timestamp,
            "X-Clipthread-Signature": `sha256=${await hmacHex(env.PROCESSOR_WEBHOOK_SECRET, `${timestamp}.${body}`)}`,
          },
          body,
        });
        if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
          if (!res.ok) console.error(`processor rejected event ${msg.id}: ${res.status}`);
          msg.ack();
        } else {
          msg.retry({ delaySeconds: Math.min(300, 15 * 2 ** msg.attempts) });
        }
      } catch (err) {
        console.error("relay failed", err);
        msg.retry({ delaySeconds: Math.min(300, 15 * 2 ** msg.attempts) });
      }
    }
  },
} satisfies ExportedHandler<Env, R2EventMessage>;
