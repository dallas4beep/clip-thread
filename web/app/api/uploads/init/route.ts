import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, parseBody } from "@/lib/http";
import { createMultipartUpload, headObject, listUploadedParts } from "@/lib/r2";
import { loadOwnedSegment, requireUser } from "@/lib/server/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { PART_SIZE } from "@/lib/upload/constants";

export const runtime = "nodejs";

const schema = z.object({ videoId: z.string().uuid(), segmentIndex: z.number().int().min(0).max(49) });

/**
 * Starts — or resumes — a multipart upload for one segment. The upload id is
 * persisted on the segment row, so a reload (or a different tab) picks up
 * exactly where the previous attempt stopped.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const { videoId, segmentIndex } = await parseBody(req, schema);
    const seg = await loadOwnedSegment(user.id, videoId, segmentIndex);

    if (seg.upload_completed_at) {
      return NextResponse.json({ completed: true, partSize: PART_SIZE, uploadId: seg.upload_id, uploadedParts: [] });
    }

    if (seg.upload_id) {
      const parts = await listUploadedParts(seg.object_key, seg.upload_id);
      if (parts) {
        return NextResponse.json({
          completed: false,
          partSize: PART_SIZE,
          uploadId: seg.upload_id,
          uploadedParts: parts.map((p) => ({ partNumber: p.PartNumber, etag: p.ETag, size: p.Size })),
        });
      }
      // Upload id expired or was aborted. If the object already exists the
      // previous complete call succeeded but the response was lost.
      const head = await headObject(seg.object_key);
      if (head && head.size === seg.size_bytes) {
        await supabaseAdmin()
          .from("video_segments")
          .update({ upload_completed_at: new Date().toISOString() })
          .eq("id", seg.id);
        return NextResponse.json({ completed: true, partSize: PART_SIZE, uploadId: seg.upload_id, uploadedParts: [] });
      }
    }

    const uploadId = await createMultipartUpload(seg.object_key, seg.mime_type);
    const { error } = await supabaseAdmin().from("video_segments").update({ upload_id: uploadId }).eq("id", seg.id);
    if (error) throw error;

    return NextResponse.json({ completed: false, partSize: PART_SIZE, uploadId, uploadedParts: [] });
  } catch (err) {
    return jsonError(err);
  }
}
