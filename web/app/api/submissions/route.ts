import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { serverEnv } from "@/lib/env";
import { signConsent, sha256Hex, type ConsentPayload } from "@/lib/consent";
import { HttpError, clientIp, jsonError, parseBody } from "@/lib/http";
import { ALLOWED_SEGMENT_MIME, segmentKey } from "@/lib/keys";
import { promptFlowSchema } from "@/lib/prompt-flow";
import { requireUser } from "@/lib/server/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const bodySchema = z.object({
  campaignId: z.string().uuid(),
  fields: z.record(z.string(), z.string().max(500)).default({}),
  segments: z
    .array(
      z.object({
        promptId: z.string().min(1).max(32),
        mimeType: z.string().regex(ALLOWED_SEGMENT_MIME, "unsupported video type"),
        sizeBytes: z.number().int().positive(),
        durationMs: z.number().int().nonnegative().max(3_600_000),
      }),
    )
    .min(1)
    .max(20),
  consent: z.object({
    documentId: z.string().uuid(),
    documentSha256: z.string().regex(/^[0-9a-f]{64}$/),
    signerName: z.string().trim().min(2).max(200),
    signatureImage: z
      .string()
      .max(400_000)
      .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/)
      .nullable()
      .default(null),
    checks: z.record(z.string(), z.boolean()),
    clientTimestamp: z.string().datetime().nullable().default(null),
  }),
});

/**
 * Creates a submission. This is the consent gate: no upload URL can be issued
 * for a video unless this call succeeded, and it only succeeds when every
 * required check of the *current* consent document is ticked.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const body = await parseBody(req, bodySchema);
    const db = supabaseAdmin();

    const { data: campaign, error: cErr } = await db
      .from("campaigns")
      .select("id,prompt_flow,is_active")
      .eq("id", body.campaignId)
      .maybeSingle();
    if (cErr) throw cErr;
    if (!campaign?.is_active) throw new HttpError(404, "Campaign not found");

    const flowParse = promptFlowSchema.safeParse(campaign.prompt_flow);
    if (!flowParse.success) throw new HttpError(500, "Campaign prompt flow is misconfigured");
    const flow = flowParse.data;

    // --- Validate details fields against the flow config -------------------
    const metadata: Record<string, string> = {};
    for (const f of flow.fields) {
      const v = body.fields[f.id]?.trim() ?? "";
      if (f.required && !v) throw new HttpError(422, `"${f.label}" is required`);
      if (v.length > f.maxLength) throw new HttpError(422, `"${f.label}" is too long`);
      if (v && f.type === "email" && !z.string().email().safeParse(v).success)
        throw new HttpError(422, `"${f.label}" must be an email`);
      if (v && f.type === "url" && !z.string().url().safeParse(v).success)
        throw new HttpError(422, `"${f.label}" must be a URL`);
      if (v) metadata[f.id] = v;
    }

    // --- Validate segments against the prompt list -------------------------
    const promptIds = flow.prompts.map((p) => p.id);
    const seen = new Set<string>();
    for (const s of body.segments) {
      if (!promptIds.includes(s.promptId)) throw new HttpError(422, `Unknown prompt "${s.promptId}"`);
      if (seen.has(s.promptId)) throw new HttpError(422, `Duplicate prompt "${s.promptId}"`);
      seen.add(s.promptId);
      if (s.sizeBytes > flow.recording.maxSegmentBytes) throw new HttpError(413, "Recording is too large");
    }
    for (const p of flow.prompts) {
      if (!p.optional && !seen.has(p.id)) throw new HttpError(422, `Missing answer for "${p.title}"`);
    }

    // --- Consent ------------------------------------------------------------
    const { data: doc, error: dErr } = await db
      .from("consent_documents")
      .select("id,campaign_id,version,body_sha256,required_checks,is_current")
      .eq("id", body.consent.documentId)
      .maybeSingle();
    if (dErr) throw dErr;
    if (!doc || !doc.is_current || (doc.campaign_id && doc.campaign_id !== campaign.id))
      throw new HttpError(409, "Consent document is outdated; please reload and review the current terms");
    if (doc.body_sha256 !== body.consent.documentSha256)
      throw new HttpError(409, "Consent text changed while you were reviewing it; please reload");

    const required = (doc.required_checks as { id: string }[]).map((c) => c.id);
    const missing = required.filter((id) => body.consent.checks[id] !== true);
    if (missing.length) throw new HttpError(422, "All consent items must be accepted", { missing });
    const checks = Object.fromEntries(required.map((id) => [id, true]));

    const videoId = randomUUID();
    const userAgent = req.headers.get("user-agent")?.slice(0, 500) ?? null;
    const ip = clientIp(req);
    const payload: ConsentPayload = {
      schema: "clipthread.consent.v1",
      video_id: videoId,
      user_id: user.id,
      campaign_id: campaign.id,
      consent_document_id: doc.id,
      consent_version: doc.version,
      document_sha256: doc.body_sha256,
      signer_name: body.consent.signerName,
      signature_sha256: body.consent.signatureImage ? sha256Hex(body.consent.signatureImage) : null,
      checks,
      ip_address: ip,
      user_agent: userAgent,
      client_timestamp: body.consent.clientTimestamp,
      server_timestamp: new Date().toISOString(),
    };
    const signed = signConsent(payload, serverEnv().CONSENT_SIGNING_SECRET);

    // Keep prompt order, not recording order.
    const ordered = [...body.segments].sort((a, b) => promptIds.indexOf(a.promptId) - promptIds.indexOf(b.promptId));
    const segments = ordered.map((s, i) => ({
      segment_index: i,
      prompt_id: s.promptId,
      object_key: segmentKey(videoId, i, s.mimeType),
      mime_type: s.mimeType.split(";")[0],
      size_bytes: s.sizeBytes,
      duration_ms: s.durationMs,
    }));

    const { error: rpcErr } = await db.rpc("create_submission", {
      p_video_id: videoId,
      p_campaign_id: campaign.id,
      p_user_id: user.id,
      p_metadata: metadata,
      p_segments: segments,
      p_consent: {
        consent_document_id: doc.id,
        consent_version: doc.version,
        document_sha256: doc.body_sha256,
        signer_name: payload.signer_name,
        signature_image: body.consent.signatureImage,
        signature_sha256: payload.signature_sha256,
        checks,
        ip_address: ip,
        user_agent: userAgent,
        client_timestamp: payload.client_timestamp,
        server_timestamp: payload.server_timestamp,
        payload,
        payload_sha256: signed.payloadSha256,
        hmac_sha256: signed.hmac,
      },
    });
    if (rpcErr) throw rpcErr;

    return NextResponse.json(
      {
        videoId,
        consentReceipt: { payloadSha256: signed.payloadSha256, serverTimestamp: payload.server_timestamp },
        segments: segments.map((s) => ({ index: s.segment_index, promptId: s.prompt_id, sizeBytes: s.size_bytes })),
      },
      { status: 201 },
    );
  } catch (err) {
    return jsonError(err);
  }
}
