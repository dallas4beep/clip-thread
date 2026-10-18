import "server-only";
import { z } from "zod";

const hexSecret = z.string().min(32, "must be at least 32 chars (use `openssl rand -hex 32`)");

const schema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET: z.string().min(1),
  R2_ENDPOINT: z.string().url().optional().or(z.literal("").transform(() => undefined)),
  CONSENT_SIGNING_SECRET: hexSecret,
  PROCESSOR_WEBHOOK_SECRET: hexSecret,
  PROCESSOR_URL: z.string().url().optional().or(z.literal("").transform(() => undefined)),
});

export type ServerEnv = z.infer<typeof schema>;

let cached: ServerEnv | undefined;

/** Parsed lazily so `next build` works without secrets present. */
export function serverEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid server environment:\n${issues}`);
  }
  if (!parsed.data.R2_ENDPOINT && !parsed.data.R2_ACCOUNT_ID) {
    throw new Error("Set R2_ACCOUNT_ID (or R2_ENDPOINT for another S3-compatible store)");
  }
  cached = parsed.data;
  return cached;
}
