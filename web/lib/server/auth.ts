import "server-only";
import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { HttpError } from "@/lib/http";

export async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new HttpError(401, "Sign-in required");
  return user;
}

export interface OwnedSegment {
  id: string;
  video_id: string;
  segment_index: number;
  object_key: string;
  mime_type: string;
  size_bytes: number;
  upload_id: string | null;
  upload_completed_at: string | null;
}

/**
 * Loads a segment and asserts the caller owns its video and the video is still
 * accepting uploads. Object keys always come from here, never from the client.
 */
export async function loadOwnedSegment(userId: string, videoId: string, segmentIndex: number): Promise<OwnedSegment> {
  const { data, error } = await supabaseAdmin()
    .from("video_segments")
    .select("id,video_id,segment_index,object_key,mime_type,size_bytes,upload_id,upload_completed_at,videos!inner(submitter_id,status)")
    .eq("video_id", videoId)
    .eq("segment_index", segmentIndex)
    .maybeSingle();
  if (error) throw error;
  const video = data?.videos as unknown as { submitter_id: string; status: string } | undefined;
  if (!data || !video || video.submitter_id !== userId) throw new HttpError(404, "Segment not found");
  if (video.status !== "draft") throw new HttpError(409, `Submission is already ${video.status}`);
  const { videos: _omit, ...segment } = data;
  return segment as OwnedSegment;
}
