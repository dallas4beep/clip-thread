/**
 * Audits every consent record:
 *   1. re-canonicalizes the stored payload and checks payload_sha256
 *   2. checks the HMAC against CONSENT_SIGNING_SECRET (+ _PREVIOUS for rotations)
 *   3. calls verify_consent_chain() to check the hash chain in Postgres
 *
 * Usage: node --env-file=.env.local --experimental-strip-types scripts/verify-consent.ts
 */
import { createClient } from "@supabase/supabase-js";
import { verifyConsent } from "../lib/consent.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const secrets = [process.env.CONSENT_SIGNING_SECRET, process.env.CONSENT_SIGNING_SECRET_PREVIOUS].filter(
  (s): s is string => Boolean(s),
);
if (!url || !key || secrets.length === 0) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or CONSENT_SIGNING_SECRET");
  process.exit(2);
}

const db = createClient(url, key, { auth: { persistSession: false } });
let failures = 0;
const pageSize = 500;

for (let from = 0; ; from += pageSize) {
  const { data, error } = await db
    .from("consent_records")
    .select("seq,id,video_id,payload,payload_sha256,hmac_sha256")
    .order("seq")
    .range(from, from + pageSize - 1);
  if (error) throw error;
  for (const r of data) {
    const { hashOk, hmacOk } = verifyConsent(r.payload, r.payload_sha256, r.hmac_sha256, secrets);
    if (!hashOk || !hmacOk) {
      failures++;
      console.error(`#${r.seq} video=${r.video_id} hash=${hashOk ? "ok" : "BAD"} hmac=${hmacOk ? "ok" : "BAD"}`);
    }
  }
  if (data.length < pageSize) break;
}

const { data: chain, error: chainErr } = await db.rpc("verify_consent_chain");
if (chainErr) throw chainErr;
for (const row of chain ?? []) {
  failures++;
  console.error(`#${row.seq} chain: ${row.problem}`);
}

console.log(failures === 0 ? "All consent records verified." : `${failures} problem(s) found.`);
process.exit(failures === 0 ? 0 : 1);
