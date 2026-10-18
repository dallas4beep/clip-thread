import Link from "next/link";
import { redirect } from "next/navigation";
import { ModerationBoard, type ModerationItem } from "@/components/moderation/ModerationBoard";
import { presignGet } from "@/lib/r2";
import { createClient } from "@/lib/supabase/server";
import type { VideoStatus } from "@/lib/types";

export const dynamic = "force-dynamic";
export const metadata = { title: "Moderation" };

const TABS: { status: VideoStatus; label: string }[] = [
  { status: "pending_review", label: "Pending review" },
  { status: "flagged", label: "Flagged" },
  { status: "approved", label: "Approved" },
  { status: "rejected", label: "Rejected" },
  { status: "processing", label: "Processing" },
  { status: "failed", label: "Failed" },
];

const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

export default async function ModerationPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || user.is_anonymous) redirect("/login?next=/admin/moderation");

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (!profile || !["moderator", "admin"].includes(profile.role)) {
    return (
      <main className="mx-auto max-w-lg px-4 py-16">
        <h1 className="text-xl font-semibold">Not authorized</h1>
        <p className="mt-2 text-slate-600">Your account ({user.email}) does not have the moderator role.</p>
      </main>
    );
  }

  const sp = await searchParams;
  const status = (TABS.find((t) => t.status === sp.status)?.status ?? "pending_review") as VideoStatus;

  // All queries run as the moderator — RLS (is_moderator) authorizes them.
  const [{ data: rows, error }, ...counts] = await Promise.all([
    supabase
      .from("videos")
      .select(
        `id,status,metadata,duration_seconds,final_key,poster_key,submitted_at,processed_at,reviewed_at,processing_error,
         campaigns(title,slug),
         transcripts(text,language,vtt,segments),
         consent_records(signer_name,server_timestamp,consent_version,payload_sha256,record_hash,ip_address),
         moderation_events(to_status,note,created_at)`,
      )
      .eq("status", status)
      .order("submitted_at", { ascending: status === "pending_review" || status === "flagged", nullsFirst: false })
      .limit(100),
    ...TABS.map((t) => supabase.from("videos").select("id", { count: "exact", head: true }).eq("status", t.status)),
  ]);
  if (error) throw error;

  const items: ModerationItem[] = await Promise.all(
    (rows ?? []).map(async (r) => ({
      id: r.id,
      status: r.status,
      metadata: (r.metadata ?? {}) as Record<string, string>,
      durationSeconds: r.duration_seconds ? Number(r.duration_seconds) : null,
      submittedAt: r.submitted_at,
      processingError: r.processing_error,
      campaign: one(r.campaigns) as ModerationItem["campaign"],
      transcript: one(r.transcripts) as ModerationItem["transcript"],
      consent: one(r.consent_records) as ModerationItem["consent"],
      lastEvent: (r.moderation_events as ModerationItem["lastEvent"][] | null)?.sort((a, b) =>
        (b?.created_at ?? "").localeCompare(a?.created_at ?? ""),
      )[0] ?? null,
      videoUrl: r.final_key ? await presignGet(r.final_key, 3600) : null,
      posterUrl: r.poster_key ? await presignGet(r.poster_key, 3600) : null,
    })),
  );

  return (
    <main className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Moderation queue</h1>
        <span className="text-sm text-slate-500">{user.email}</span>
      </header>
      <nav className="flex flex-wrap gap-1 border-b border-slate-200">
        {TABS.map((t, i) => (
          <Link
            key={t.status}
            href={`/admin/moderation?status=${t.status}`}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              t.status === status ? "border-indigo-600 font-medium text-indigo-700" : "border-transparent text-slate-600 hover:text-slate-900"
            }`}
          >
            {t.label} <span className="ml-1 rounded-full bg-slate-100 px-1.5 text-xs">{counts[i].count ?? 0}</span>
          </Link>
        ))}
      </nav>
      <ModerationBoard key={status} status={status} initialItems={items} />
    </main>
  );
}
