import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Deterministic JSON serialization (sorted keys, no whitespace) so the same
 * consent payload always hashes to the same value — in Node, in a verifier
 * script, or in a court-ordered audit years from now. Payloads deliberately
 * contain only strings, booleans and null to avoid number-format ambiguity.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new Error("canonicalize: non-finite number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v ?? null)).join(",")}]`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
    }
    default:
      throw new Error(`canonicalize: unsupported type ${typeof value}`);
  }
}

export const sha256Hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

const HMAC_DOMAIN = "clipthread.consent.v1";

export const consentHmac = (secret: string, payloadSha256: string) =>
  createHmac("sha256", secret).update(`${HMAC_DOMAIN}:${payloadSha256}`).digest("hex");

export interface ConsentPayload {
  schema: "clipthread.consent.v1";
  video_id: string;
  user_id: string;
  campaign_id: string;
  consent_document_id: string;
  consent_version: string;
  document_sha256: string;
  signer_name: string;
  signature_sha256: string | null;
  checks: Record<string, boolean>;
  ip_address: string | null;
  user_agent: string | null;
  client_timestamp: string | null;
  server_timestamp: string;
}

export function signConsent(payload: ConsentPayload, secret: string) {
  const canonical = canonicalize(payload);
  const payloadSha256 = sha256Hex(canonical);
  return { canonical, payloadSha256, hmac: consentHmac(secret, payloadSha256) };
}

/** Verifies a stored record. `secrets` lets you check against rotated keys. */
export function verifyConsent(
  payload: unknown,
  payloadSha256: string,
  hmac: string,
  secrets: string[],
): { hashOk: boolean; hmacOk: boolean } {
  const hashOk = sha256Hex(canonicalize(payload)) === payloadSha256;
  const given = Buffer.from(hmac, "hex");
  const hmacOk = secrets.some((s) => {
    const expected = Buffer.from(consentHmac(s, payloadSha256), "hex");
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
  return { hashOk, hmacOk };
}
