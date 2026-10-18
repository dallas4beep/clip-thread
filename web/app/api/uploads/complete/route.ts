import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";
import { z } from "zod";
import { serverEnv } from "@/lib/env";
import { HttpError, jsonError, parseBody } from "@/lib/http";
import { completeMultipartUpload, headObject, r2 } from "@/lib/r2";
import { loadOwnedSegment, requireUser } from "@/lib/server/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { PART_SIZE } from "@/lib/upload/constants";

export const runtime = "nodejs";

const schema = z.object({
  videoId: z.string().uuid(),
  segmentIndex: z.number().int().min(0).max(49),
  uploadId: z.string().min(1),
  parts: z.array(z.object({ partNumber: z.number().int().min(1).max(10_000), etag: z.string().min(1) })).min(1),
});

export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const body = await parseBody(req, schema);
    const seg = await loadOwnedSegment(user.id, body.videoId, body.segmentIndex);
    if (seg.upload_completed_at) return NextResponse.json({ ok: true });
    if (seg.upload_id !== body.uploadId) throw new HttpError(409, "Upload id mismatch");

    const expectedParts = Math.max(1, Math.ceil(seg.size_bytes / PART_SIZE));
    const numbers = new Set(body.parts.map((p) => p.partNumber));
    if (numbers.size !== expectedParts || ![...numbers].every((n) => n >= 1 && n <= expectedParts))
      throw new HttpError(422, `Expected parts 1..${expectedParts}`);

    await completeMultipartUpload(seg.object_key, seg.upload_id, body.parts);

    // Presigned part URLs can't cap body size, so enforce the declared size here.
    const head = await headObject(seg.object_key);
    if (!head || head.size !== seg.size_bytes) {
      await r2().send(new DeleteObjectCommand({ Bucket: serverEnv().R2_BUCKET, Key: seg.object_key }));
      await supabaseAdmin().from("video_segments").update({ upload_id: null }).eq("id", seg.id);
      throw new HttpError(422, "Uploaded size does not match the declared size; please retry");
    }

    const { error } = await supabaseAdmin()
      .from("video_segments")
      .update({ upload_completed_at: new Date().toISOString() })
      .eq("id", seg.id);
    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (err) {
    return jsonError(err);
  }
}
