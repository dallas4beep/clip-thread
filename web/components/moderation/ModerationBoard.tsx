"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { VideoStatus } from "@/lib/types";

export interface ModerationItem {
  id: string;
  status: VideoStatus;
  metadata: Record<string, string>;
  durationSeconds: number | null;
  submittedAt: string | null;
  processingError: string | null;
  campaign: { title: string; slug: string } | null;
  transcript: { text: string; language: string | null; vtt: string; segments: { start: number; end: number; text: string }[] } | null;
  consent: {
    signer_name: string;
    server_timestamp: string;
    consent_version: string;
    payload_sha256: string;
    record_hash: string;
    ip_address: string | null;
  } | null;
  lastEvent: { to_status: VideoStatus; note: string | null; created_at: string } | null;
  videoUrl: string | null;
  posterUrl: string | null;
}

const ACTIONS: { status: VideoStatus; label: string; key: string; className: string }[] = [
  { status: "approved", label: "Approve", key: "a", className: "bg-emerald-600 hover:bg-emerald-700" },
  { status: "rejected", label: "Reject", key: "r", className: "bg-slate-700 hover:bg-slate-800" },
  { status: "flagged", label: "Flag", key: "f", className: "bg-amber-500 hover:bg-amber-600" },
];

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function ModerationBoard({ status, initialItems }: { status: VideoStatus; initialItems: ModerationItem[] }) {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [items, setItems] = useState(initialItems);
  const [selectedId, setSelectedId] = useState(initialItems[0]?.id ?? null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => setItems(initialItems), [initialItems]);

  const index = items.findIndex((i) => i.id === selectedId);
  const item = index >= 0 ? items[index] : null;
  const moderatable = ["pending_review", "approved", "rejected", "flagged"].includes(status);

  // Live updates: new submissions finishing processing, or other moderators acting.
  useEffect(() => {
    const channel = supabase
      .channel("moderation-videos")
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "videos" }, () => router.refresh())
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [supabase, router]);

  // Captions from the stored VTT, attached as a same-origin blob: URL.
  const captionsUrl = useMemo(
    () => (item?.transcript?.vtt ? URL.createObjectURL(new Blob([item.transcript.vtt], { type: "text/vtt" })) : null),
    [item?.transcript?.vtt],
  );
  useEffect(() => () => void (captionsUrl && URL.revokeObjectURL(captionsUrl)), [captionsUrl]);

  const decide = useCallback(
    async (to: VideoStatus) => {
      if (!item || busy || item.status === to) return;
      setBusy(true);
      setError(null);
      const { error } = await supabase.rpc("moderate_video", { p_video_id: item.id, p_status: to, p_note: note || null });
      setBusy(false);
      if (error) return setError(error.message);
      setNote("");
      const next = items[index + 1] ?? items[index - 1] ?? null;
      setItems((list) => list.filter((i) => i.id !== item.id));
      setSelectedId(next?.id ?? null);
      router.refresh();
    },
    [item, busy, supabase, note, items, index, router],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "j") setSelectedId(items[Math.min(index + 1, items.length - 1)]?.id ?? null);
      else if (e.key === "k") setSelectedId(items[Math.max(index - 1, 0)]?.id ?? null);
      else if (moderatable) {
        const action = ACTIONS.find((a) => a.key === e.key);
        if (action) {
          e.preventDefault();
          void decide(action.status);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, index, decide, moderatable]);

  if (!items.length) {
    return <p className="py-16 text-center text-slate-500">Nothing here. 🎉</p>;
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
      <ul className="flex max-h-[calc(100dvh-12rem)] flex-col gap-2 overflow-y-auto pr-1" aria-label="Submissions">
        {items.map((i) => (
          <li key={i.id}>
            <button
              type="button"
              onClick={() => setSelectedId(i.id)}
              className={`flex w-full gap-3 rounded-lg border p-2 text-left ${
                i.id === selectedId ? "border-indigo-500 bg-indigo-50" : "border-slate-200 bg-white hover:border-slate-300"
              }`}
            >
              <div className="h-14 w-24 shrink-0 overflow-hidden rounded bg-slate-200">
                {i.posterUrl && <img src={i.posterUrl} alt="" className="h-full w-full object-cover" />}
              </div>
              <div className="min-w-0 text-sm">
                <p className="truncate font-medium">{i.metadata.name ?? i.consent?.signer_name ?? "Anonymous"}</p>
                <p className="truncate text-slate-500">{i.campaign?.title}</p>
                <p className="text-xs text-slate-400">
                  {i.durationSeconds ? fmtTime(i.durationSeconds) : "—"} ·{" "}
                  {i.submittedAt ? new Date(i.submittedAt).toLocaleString() : ""}
                </p>
              </div>
            </button>
          </li>
        ))}
      </ul>

      {item && (
        <section className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-4">
          <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <div className="flex flex-col gap-3">
              <div className="aspect-video overflow-hidden rounded-lg bg-black">
                {item.videoUrl ? (
                  <video
                    ref={videoRef}
                    key={item.id}
                    src={item.videoUrl}
                    poster={item.posterUrl ?? undefined}
                    controls
                    playsInline
                    onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                    className="h-full w-full"
                  >
                    {captionsUrl && <track kind="captions" src={captionsUrl} srcLang={item.transcript?.language ?? "en"} label="Captions" default />}
                  </video>
                ) : (
                  <div className="grid h-full place-items-center text-sm text-slate-400">
                    {item.processingError ?? "Video is still processing"}
                  </div>
                )}
              </div>

              {moderatable && (
                <div className="flex flex-col gap-2">
                  <input
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Optional note (stored in the audit log)"
                    maxLength={2000}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                  <div className="flex flex-wrap gap-2">
                    {ACTIONS.map((a) => (
                      <button
                        key={a.status}
                        type="button"
                        disabled={busy || item.status === a.status}
                        onClick={() => decide(a.status)}
                        className={`rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-40 ${a.className}`}
                      >
                        {a.label} <kbd className="ml-1 rounded bg-white/20 px-1 text-xs">{a.key.toUpperCase()}</kbd>
                      </button>
                    ))}
                    {item.status !== "pending_review" && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => decide("pending_review")}
                        className="rounded-lg border border-slate-300 px-4 py-2 text-sm"
                      >
                        Back to queue
                      </button>
                    )}
                  </div>
                  {error && <p className="text-sm text-red-600">{error}</p>}
                  <p className="text-xs text-slate-400">Shortcuts: J/K to move · A approve · R reject · F flag</p>
                </div>
              )}
            </div>

            <div className="flex min-h-0 flex-col gap-3 text-sm">
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                {Object.entries(item.metadata).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-slate-500 capitalize">{k}</dt>
                    <dd className="truncate">{v}</dd>
                  </div>
                ))}
              </dl>

              {item.consent ? (
                <details className="rounded-lg bg-emerald-50 p-3 text-emerald-900">
                  <summary className="cursor-pointer font-medium">
                    ✓ Release signed by {item.consent.signer_name} · v{item.consent.consent_version}
                  </summary>
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 font-mono text-xs break-all">
                    <dt>signed</dt>
                    <dd>{new Date(item.consent.server_timestamp).toISOString()}</dd>
                    <dt>payload</dt>
                    <dd>{item.consent.payload_sha256}</dd>
                    <dt>chain</dt>
                    <dd>{item.consent.record_hash}</dd>
                    <dt>ip</dt>
                    <dd>{item.consent.ip_address ?? "—"}</dd>
                  </dl>
                </details>
              ) : (
                <p className="rounded-lg bg-red-50 p-3 font-medium text-red-800">⚠ No consent record found — do not publish.</p>
              )}

              {item.lastEvent?.note && (
                <p className="rounded-lg bg-slate-50 p-3 text-slate-700">
                  <span className="font-medium">Last note:</span> {item.lastEvent.note}
                </p>
              )}

              <div className="flex min-h-0 flex-1 flex-col">
                <h3 className="mb-1 font-medium">
                  Transcript {item.transcript?.language && <span className="text-slate-400">({item.transcript.language})</span>}
                </h3>
                <div className="max-h-80 overflow-y-auto rounded-lg border border-slate-200 p-2 leading-relaxed">
                  {item.transcript?.segments?.length ? (
                    item.transcript.segments.map((s, i) => {
                      const active = currentTime >= s.start && currentTime < s.end;
                      return (
                        <button
                          key={i}
                          type="button"
                          onClick={() => {
                            if (videoRef.current) {
                              videoRef.current.currentTime = s.start;
                              void videoRef.current.play();
                            }
                          }}
                          className={`block w-full rounded px-1 text-left hover:bg-slate-100 ${active ? "bg-yellow-100" : ""}`}
                        >
                          <span className="mr-2 font-mono text-xs text-slate-400">{fmtTime(s.start)}</span>
                          {s.text}
                        </button>
                      );
                    })
                  ) : (
                    <p className="text-slate-400">{item.transcript?.text || "No transcript available."}</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
