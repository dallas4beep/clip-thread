import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize, signConsent, verifyConsent, type ConsentPayload } from "./consent.ts";

test("canonicalize sorts keys recursively and drops undefined", () => {
  assert.equal(canonicalize({ b: 1, a: { d: true, c: null }, z: undefined }), '{"a":{"c":null,"d":true},"b":1}');
  assert.equal(canonicalize([{ y: "é", x: "\n" }]), '[{"x":"\\n","y":"é"}]');
});

test("canonicalize is independent of insertion order", () => {
  assert.equal(canonicalize({ a: 1, b: 2 }), canonicalize({ b: 2, a: 1 }));
});

const payload: ConsentPayload = {
  schema: "clipthread.consent.v1",
  video_id: "00000000-0000-0000-0000-000000000001",
  user_id: "00000000-0000-0000-0000-000000000002",
  campaign_id: "00000000-0000-0000-0000-000000000003",
  consent_document_id: "00000000-0000-0000-0000-000000000004",
  consent_version: "2026-10-01",
  document_sha256: "a".repeat(64),
  signer_name: "Ada Lovelace",
  signature_sha256: null,
  checks: { license: true, adult: true },
  ip_address: "203.0.113.7",
  user_agent: "test",
  client_timestamp: "2026-10-14T12:00:00.000Z",
  server_timestamp: "2026-10-14T12:00:01.000Z",
};

test("sign/verify round trip, including after a JSON (jsonb) round trip", () => {
  const { payloadSha256, hmac } = signConsent(payload, "s".repeat(64));
  const stored = JSON.parse(JSON.stringify(payload));
  assert.deepEqual(verifyConsent(stored, payloadSha256, hmac, ["s".repeat(64)]), { hashOk: true, hmacOk: true });
});

test("tampering is detected", () => {
  const { payloadSha256, hmac } = signConsent(payload, "s".repeat(64));
  const tampered = { ...payload, signer_name: "Mallory" };
  assert.equal(verifyConsent(tampered, payloadSha256, hmac, ["s".repeat(64)]).hashOk, false);
  assert.equal(verifyConsent(payload, payloadSha256, hmac, ["x".repeat(64)]).hmacOk, false);
});
