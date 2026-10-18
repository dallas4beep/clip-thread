"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMediaStream } from "@/hooks/useMediaStream";
import type { RecordedSegment } from "@/hooks/useSegmentRecorder";
import { createClient } from "@/lib/supabase/client";
import { uploadSegment } from "@/lib/upload/multipart-client";
import {
  clearPending,
  clearSegments,
  loadPending,
  loadSegments,
  savePending,
  saveSegment,
  type PendingSubmission,
} from "@/lib/upload/segment-store";
import type { CampaignDTO, ConsentDocumentDTO } from "@/lib/types";
import { ConsentGate, type ConsentSubmission } from "./ConsentGate";
import { PromptRecorder } from "./PromptRecorder";

type Phase =
  | { name: "intro" }
  | { name: "details" }
  | { name: "permission" }
  | { name: "recording"; index: number }
  | { name: "review" }
  | { name: "consent" }
  | { name: "uploading" }
  | { name: "done"; receipt?: string };

interface Props {
  campaign: CampaignDTO;
  consentDocument: ConsentDocumentDTO;
  onBusyChange?: (busy: boolean) => void;
}

export function SubmissionFlow({ campaign, consentDocument, onBusyChange }: Props) {
  const { flow } = campaign;
  const prompts = flow.prompts;
  const [phase, setPhase] = useState<Phase>({ name: "intro" });
  const [fields, setFields] = useState<Record<string, string>>({});
  const [takes, setTakes] = useState<Record<string, RecordedSegment>>({});
  const [skipped, setSkipped] = useState<Record<string, boolean>>({});
  const [retakesUsed, setRetakesUsed] = useState<Record<string, number>>({});
  const [consentBusy, setConsentBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ loaded: 0, total: 0 });
  const [pending, setPending] = useState<PendingSubmission | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const media = useMediaStream(flow.recording.video);

  useEffect(() => {
    onBusyChange?.(phase.name === "recording" || phase.name === "uploading" || phase.name === "consent");
  }, [phase.name, onBusyChange]);

  // Restore after a reload: either an unfinished upload, or takes recorded before consent.
  useEffect(() => {
    (async () => {
      const stored = await loadSegments(campaign.id);
      const p = loadPending(campaign.id);
      if (p && stored.length) {
        setPending(p);
        setTakes(Object.fromEntries(stored.map((s) => [s.promptId, s])));
        setPhase({ name: "uploading" });
      } else if (stored.length) {
        setTakes(Object.fromEntries(stored.map((s) => [s.promptId, s])));
      }
    })();
  }, [campaign.id]);

  // Release the camera once recording is over.
  useEffect(() => {
    if (["review", "consent", "uploading", "done"].includes(phase.name)) media.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.name]);

  const answered = useMemo(() => prompts.filter((p) => takes[p.id] && !skipped[p.id]), [prompts, takes, skipped]);

  const goToPrompt = (index: number) => {
    if (index >= prompts.length) setPhase({ name: "review" });
    else setPhase({ name: "recording", index });
  };

  const startRecording = async () => {
    const s = await media.request();
    if (s) goToPrompt(0);
  };

  const runUpload = useCallback(
    async (p: PendingSubmission, blobs: Record<string, RecordedSegment>) => {
      setError(null);
      setPhase({ name: "uploading" });
      const controller = new AbortController();
      abortRef.current = controller;
      const total = p.segments.reduce((s, x) => s + x.sizeBytes, 0);
      const loadedBy = new Map<number, number>();
      setProgress({ loaded: 0, total });
      try {
        for (const seg of p.segments) {
          const blob = blobs[seg.promptId]?.blob;
          if (!blob || blob.size !== seg.sizeBytes) throw new Error("A recording is missing from this browser; please record again.");
          await uploadSegment({
            videoId: p.videoId,
            segmentIndex: seg.index,
            blob,
            signal: controller.signal,
            onProgress: (loaded) => {
              loadedBy.set(seg.index, loaded);
              setProgress({ loaded: [...loadedBy.values()].reduce((a, b) => a + b, 0), total });
            },
          });
        }
        const res = await fetch(`/api/submissions/${p.videoId}/finalize`, { method: "POST" });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Could not finalize the submission");
        clearPending(campaign.id);
        await clearSegments(campaign.id);
        setPending(null);
        setPhase({ name: "done" });
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setError((err as Error).message);
      }
    },
    [campaign.id],
  );

  const submitConsent = async (consent: ConsentSubmission) => {
    setConsentBusy(true);
    setError(null);
    try {
      // Every consent record must be tied to a user id; visitors get an anonymous one.
      const supabase = createClient();
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        const { error: authErr } = await supabase.auth.signInAnonymously();
        if (authErr) throw new Error(`Could not start a session: ${authErr.message}`);
      }

      const segments = answered.map((p) => ({
        promptId: p.id,
        mimeType: takes[p.id].mimeType,
        sizeBytes: takes[p.id].blob.size,
        durationMs: takes[p.id].durationMs,
      }));
      const res = await fetch("/api/submissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId: campaign.id, fields, segments, consent }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Submission failed");

      const p: PendingSubmission = {
        videoId: body.videoId,
        campaignId: campaign.id,
        segments: body.segments,
        createdAt: Date.now(),
      };
      savePending(p);
      setPending(p);
      setConsentBusy(false);
      await runUpload(p, takes);
    } catch (err) {
      setConsentBusy(false);
      setError((err as Error).message);
    }
  };

  const discardDraft = async () => {
    abortRef.current?.abort();
    clearPending(campaign.id);
    await clearSegments(campaign.id);
    setPending(null);
    setTakes({});
    setPhase({ name: "intro" });
  };

  // ---------------------------------------------------------------- render
  if (phase.name === "intro") {
    const hasDraft = Object.keys(takes).length > 0;
    return (
      <section className="flex flex-col gap-4">
        <h2 className="text-2xl font-semibold">{flow.intro.title ?? campaign.title}</h2>
        {flow.intro.body && <p className="text-slate-600">{flow.intro.body}</p>}
        <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700">
          {prompts.map((p) => (
            <li key={p.id}>
              {p.title} <span className="text-slate-400">· up to {p.maxSeconds}s{p.optional ? " · optional" : ""}</span>
            </li>
          ))}
        </ol>
        {flow.intro.estimatedMinutes ? <p className="text-sm text-slate-500">About {flow.intro.estimatedMinutes} minutes.</p> : null}
        <div className="flex justify-end gap-2">
          {hasDraft && (
            <button type="button" onClick={() => setPhase({ name: "review" })} className="rounded-lg border border-slate-300 px-4 py-2">
              Continue saved recording
            </button>
          )}
          <button
            type="button"
            onClick={() => setPhase(flow.fields.length ? { name: "details" } : { name: "permission" })}
            className="rounded-lg bg-brand px-4 py-2 font-medium text-white"
          >
            Get started
          </button>
        </div>
      </section>
    );
  }

  if (phase.name === "details") {
    return (
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setPhase({ name: "permission" });
        }}
      >
        <h2 className="text-xl font-semibold">A few details</h2>
        {flow.fields.map((f) => (
          <label key={f.id} className="flex flex-col gap-1 text-sm">
            <span className="font-medium">
              {f.label} {!f.required && <span className="font-normal text-slate-400">(optional)</span>}
            </span>
            <input
              type={f.type}
              required={f.required}
              maxLength={f.maxLength}
              value={fields[f.id] ?? ""}
              onChange={(e) => setFields((s) => ({ ...s, [f.id]: e.target.value }))}
              className="rounded-lg border border-slate-300 px-3 py-2"
            />
            {!f.public && <span className="text-xs text-slate-500">Never shown publicly.</span>}
          </label>
        ))}
        <div className="flex justify-between">
          <button type="button" onClick={() => setPhase({ name: "intro" })} className="rounded-lg px-3 py-2 text-slate-600 hover:bg-slate-100">
            Back
          </button>
          <button type="submit" className="rounded-lg bg-brand px-4 py-2 font-medium text-white">
            Continue
          </button>
        </div>
      </form>
    );
  }

  if (phase.name === "permission") {
    return (
      <section className="flex flex-col items-center gap-4 py-6 text-center">
        <div className="grid h-16 w-16 place-items-center rounded-full bg-slate-100 text-3xl" aria-hidden>
          🎥
        </div>
        <h2 className="text-xl font-semibold">Allow camera & microphone</h2>
        <p className="max-w-md text-slate-600">
          Nothing is uploaded until you review your answers and accept the release terms.
        </p>
        {media.error && <p className="max-w-md rounded-lg bg-red-50 p-3 text-sm text-red-700">{media.error}</p>}
        <button
          type="button"
          onClick={startRecording}
          disabled={media.status === "requesting"}
          className="rounded-lg bg-brand px-4 py-2 font-medium text-white disabled:opacity-50"
        >
          {media.status === "requesting" ? "Waiting for permission…" : "Enable camera"}
        </button>
      </section>
    );
  }

  if (phase.name === "recording") {
    const prompt = prompts[phase.index];
    if (!media.stream) {
      return (
        <div className="py-8 text-center">
          <button type="button" onClick={() => media.request()} className="rounded-lg bg-brand px-4 py-2 text-white">
            Re-enable camera
          </button>
        </div>
      );
    }
    return (
      <PromptRecorder
        key={`${prompt.id}-${retakesUsed[prompt.id] ?? 0}`}
        prompt={prompt}
        index={phase.index}
        total={prompts.length}
        stream={media.stream}
        existing={takes[prompt.id]}
        retakesLeft={flow.recording.maxRetakes - (retakesUsed[prompt.id] ?? 0)}
        preferredMimeTypes={flow.recording.mimeTypes}
        onAccept={(seg) => {
          setTakes((t) => ({ ...t, [prompt.id]: seg }));
          setSkipped((s) => ({ ...s, [prompt.id]: false }));
          void saveSegment({ campaignId: campaign.id, promptId: prompt.id, ...seg });
          goToPrompt(phase.index + 1);
        }}
        onRetake={() => {
          setTakes(({ [prompt.id]: _drop, ...rest }) => rest);
          setRetakesUsed((r) => ({ ...r, [prompt.id]: (r[prompt.id] ?? 0) + 1 }));
        }}
        onSkip={prompt.optional ? () => {
          setSkipped((s) => ({ ...s, [prompt.id]: true }));
          goToPrompt(phase.index + 1);
        } : undefined}
        onBack={phase.index > 0 ? () => goToPrompt(phase.index - 1) : undefined}
      />
    );
  }

  if (phase.name === "review") {
    const missing = prompts.filter((p) => !p.optional && !takes[p.id]);
    return (
      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold">Review your answers</h2>
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200">
          {prompts.map((p, i) => (
            <li key={p.id} className="flex items-center justify-between gap-3 p-3">
              <div>
                <p className="font-medium">{p.title}</p>
                <p className="text-sm text-slate-500">
                  {takes[p.id] && !skipped[p.id]
                    ? `${Math.round(takes[p.id].durationMs / 1000)}s recorded`
                    : p.optional ? "Skipped" : "Not recorded yet"}
                </p>
              </div>
              <button
                type="button"
                onClick={async () => {
                  if (await media.request()) goToPrompt(i);
                }}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
              >
                {takes[p.id] ? "Re-record" : "Record"}
              </button>
            </li>
          ))}
        </ul>
        <div className="flex justify-between">
          <button type="button" onClick={discardDraft} className="rounded-lg px-3 py-2 text-slate-600 hover:bg-slate-100">
            Discard & start over
          </button>
          <button
            type="button"
            disabled={missing.length > 0 || answered.length === 0}
            onClick={() => setPhase({ name: "consent" })}
            className="rounded-lg bg-brand px-4 py-2 font-medium text-white disabled:opacity-50"
          >
            Continue to release form
          </button>
        </div>
      </section>
    );
  }

  if (phase.name === "consent") {
    return (
      <ConsentGate
        document={consentDocument}
        defaultName={fields.name}
        busy={consentBusy}
        error={error}
        onBack={() => setPhase({ name: "review" })}
        onSubmit={submitConsent}
      />
    );
  }

  if (phase.name === "uploading") {
    const pct = progress.total ? Math.round((progress.loaded / progress.total) * 100) : 0;
    return (
      <section className="flex flex-col gap-4 py-4">
        <h2 className="text-xl font-semibold">{error ? "Upload paused" : "Uploading your video…"}</h2>
        <div className="h-3 overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-brand transition-[width]" style={{ width: `${pct}%` }} />
        </div>
        <p className="text-sm text-slate-600">
          {pct}% · {(progress.loaded / 1e6).toFixed(1)} / {(progress.total / 1e6).toFixed(1)} MB
          {!error && " — you can keep this tab in the background. If it closes, reopen this page to resume."}
        </p>
        {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        {(error || (pending && progress.total === 0)) && (
          <div className="flex justify-between">
            <button type="button" onClick={discardDraft} className="rounded-lg px-3 py-2 text-slate-600 hover:bg-slate-100">
              Discard
            </button>
            <button
              type="button"
              onClick={() => pending && runUpload(pending, takes)}
              className="rounded-lg bg-brand px-4 py-2 font-medium text-white"
            >
              Resume upload
            </button>
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="flex flex-col items-center gap-3 py-8 text-center">
      <div className="grid h-16 w-16 place-items-center rounded-full bg-emerald-100 text-3xl text-emerald-700" aria-hidden>
        ✓
      </div>
      <h2 className="text-xl font-semibold">Thank you!</h2>
      <p className="max-w-md text-slate-600">
        Your video was received. Our team reviews every submission before it is published.
      </p>
    </section>
  );
}
