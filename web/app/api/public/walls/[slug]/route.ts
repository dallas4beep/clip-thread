import { NextResponse } from "next/server";
import { corsHeaders } from "@/lib/cors";
import { jsonError } from "@/lib/http";
import { brandingSchema, promptFlowSchema } from "@/lib/prompt-flow";
import { presignGet } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const URL_TTL = 6 * 3600;

/**
 * Public "video wall" feed: approved videos only, explicit column list, no
 * submitter ids / emails / consent data. Media URLs are short-lived presigned
 * GETs into the private bucket; the response is CDN-cacheable for 5 minutes.
 */
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const origin = req.headers.get("origin");
  try {
    const { slug } = await params;
    const url = new URL(req.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 24, 1), 60);
    const db = supabaseAdmin();

    const { data: campaign, error } = await db
      .from("campaigns")
      .select("id,slug,title,branding,prompt_flow,allowed_embed_origins,is_active")
      .eq("slug", slug)
      .maybeSingle();
    if (error) throw error;
    if (!campaign?.is_active) return NextResponse.json({ error: "Not found" }, { status: 404, headers: corsHeaders(origin) ?? {} });

    const cors = corsHeaders(origin, campaign.allowed_embed_origins ?? []);
    if (!cors) return NextResponse.json({ error: "Origin not allowed" }, { status: 403 });

    const { data: rows, error: vErr } = await db
      .from("videos")
      .select("id,metadata,duration_seconds,final_key,poster_key,reviewed_at,is_featured,transcripts(text,language)")
      .eq("campaign_id", campaign.id)
      .eq("status", "approved")
      .not("final_key", "is", null)
      .order("is_featured", { ascending: false })
      .order("sort_order", { ascending: true })
      .order("reviewed_at", { ascending: false })
      .limit(limit);
    if (vErr) throw vErr;

    const flow = promptFlowSchema.safeParse(campaign.prompt_flow);
    const publicFields = new Set(
      flow.success ? flow.data.fields.filter((f) => f.public).map((f) => f.id) : ["name", "affiliation"],
    );
    const apiBase = new URL(req.url).origin;

    const videos = await Promise.all(
      (rows ?? []).map(async (v) => {
        const t = (Array.isArray(v.transcripts) ? v.transcripts[0] : v.transcripts) as
          | { text: string; language: string | null }
          | null;
        const meta = Object.fromEntries(
          Object.entries((v.metadata ?? {}) as Record<string, string>).filter(([k]) => publicFields.has(k)),
        );
        return {
          id: v.id,
          name: meta.name ?? null,
          affiliation: meta.affiliation ?? null,
          fields: meta,
          durationSeconds: v.duration_seconds ? Number(v.duration_seconds) : null,
          featured: v.is_featured,
          videoUrl: await presignGet(v.final_key!, URL_TTL),
          posterUrl: v.poster_key ? await presignGet(v.poster_key, URL_TTL) : null,
          captionsUrl: t ? `${apiBase}/api/public/videos/${v.id}/captions` : null,
          language: t?.language ?? null,
          excerpt: t ? excerpt(t.text) : null,
        };
      }),
    );

    const branding = brandingSchema.parse(campaign.branding ?? {});
    return NextResponse.json(
      { wall: { slug: campaign.slug, title: branding.wallTitle ?? campaign.title, branding }, videos },
      { headers: { ...cors, "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=600" } },
    );
  } catch (err) {
    return jsonError(err, corsHeaders(origin) ?? undefined);
  }
}

export function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) ?? {} });
}

function excerpt(text: string, max = 180) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : max)}…`;
}
