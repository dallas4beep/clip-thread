import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=300, s-maxage=3600",
};

/** WebVTT for an approved video. embed.js fetches this and attaches it as a same-origin blob: track. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return new Response("Not found", { status: 404, headers });
  const format = new URL(req.url).searchParams.get("format") === "srt" ? "srt" : "vtt";

  const { data, error } = await supabaseAdmin()
    .from("transcripts")
    .select("vtt,srt,videos!inner(status)")
    .eq("video_id", id)
    .eq("videos.status", "approved")
    .maybeSingle();
  if (error) {
    console.error(error);
    return new Response("Error", { status: 500, headers });
  }
  if (!data) return new Response("Not found", { status: 404, headers });

  return new Response(format === "srt" ? data.srt : data.vtt, {
    headers: {
      ...headers,
      "Content-Type": format === "srt" ? "application/x-subrip; charset=utf-8" : "text/vtt; charset=utf-8",
    },
  });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: { ...headers, "Access-Control-Allow-Methods": "GET, OPTIONS" } });
}
