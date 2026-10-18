import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, jsonError } from "@/lib/http";
import { manifestKey } from "@/lib/keys";
import { notifyProcessor } from "@/lib/processor";
import { putJson } from "@/lib/r2";
import { requireUser } from "@/lib/server/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * Marks a submission as fully uploaded and hands it to the processor.
 * Writing manifest.json also fires an R2 object-create event, which the
 * optional Cloudflare forwarder relays to the processor as a second channel.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!z.string().uuid().safeParse(id).success) throw new HttpError(404, "Not found");
    const db = supabaseAdmin();

    const { data: video, error } = await db
      .from("videos")
      .select("id,submitter_id,status,campaign_id,video_segments(segment_index,prompt_id,object_key,mime_type,size_bytes,duration_ms,upload_completed_at)")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    if (!video || video.submitter_id !== user.id) throw new HttpError(404, "Not found");
    if (video.status !== "draft") return NextResponse.json({ status: video.status });

    const segments = (video.video_segments ?? []) as {
      segment_index: number; prompt_id: string; object_key: string; mime_type: string;
      size_bytes: number; duration_ms: number | null; upload_completed_at: string | null;
    }[];
    const pending = segments.filter((s) => !s.upload_completed_at).map((s) => s.segment_index);
    if (pending.length) throw new HttpError(409, "Some segments are not uploaded yet", { pending });

    await putJson(manifestKey(id), {
      videoId: id,
      campaignId: video.campaign_id,
      createdAt: new Date().toISOString(),
      segments: segments
        .sort((a, b) => a.segment_index - b.segment_index)
        .map(({ upload_completed_at: _u, ...s }) => s),
    });

    const { data: updated, error: upErr } = await db
      .from("videos")
      .update({ status: "uploaded", submitted_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "draft")
      .select("status")
      .maybeSingle();
    if (upErr) throw upErr;

    await notifyProcessor({ type: "video.uploaded", videoId: id });
    return NextResponse.json({ status: updated?.status ?? "uploaded" });
  } catch (err) {
    return jsonError(err);
  }
}
