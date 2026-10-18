import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, jsonError, parseBody } from "@/lib/http";
import { presignUploadPart } from "@/lib/r2";
import { loadOwnedSegment, requireUser } from "@/lib/server/auth";
import { MAX_PARTS_PER_SIGN_REQUEST, PART_SIZE } from "@/lib/upload/constants";

export const runtime = "nodejs";

const schema = z.object({
  videoId: z.string().uuid(),
  segmentIndex: z.number().int().min(0).max(49),
  uploadId: z.string().min(1),
  partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(MAX_PARTS_PER_SIGN_REQUEST),
});

/** Issues short-lived presigned PUT URLs so video bytes go browser -> R2 directly. */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const body = await parseBody(req, schema);
    const seg = await loadOwnedSegment(user.id, body.videoId, body.segmentIndex);
    if (seg.upload_id !== body.uploadId) throw new HttpError(409, "Upload id mismatch; call /api/uploads/init again");

    const maxPart = Math.max(1, Math.ceil(seg.size_bytes / PART_SIZE));
    if (body.partNumbers.some((n) => n > maxPart)) throw new HttpError(422, "Part number out of range");

    const urls = Object.fromEntries(
      await Promise.all(
        body.partNumbers.map(async (n) => [n, await presignUploadPart(seg.object_key, seg.upload_id!, n, 3600)] as const),
      ),
    );
    return NextResponse.json({ urls, expiresIn: 3600 });
  } catch (err) {
    return jsonError(err);
  }
}
