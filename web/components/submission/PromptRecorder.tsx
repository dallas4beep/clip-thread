"use client";
import { useEffect, useRef, useState } from "react";
import { useCountdown } from "@/hooks/useCountdown";
import { useSegmentRecorder, type RecordedSegment } from "@/hooks/useSegmentRecorder";
import type { Prompt } from "@/lib/prompt-flow";

type Phase = "prep" | "recording" | "review";

interface Props {
  prompt: Prompt;
  index: number;
  total: number;
  stream: MediaStream;
  existing?: RecordedSegment;
  retakesLeft: number;
  preferredMimeTypes?: string[];
  onAccept: (segment: RecordedSegment) => void;
  onRetake: () => void;
  onSkip?: () => void;
  onBack?: () => void;
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function PromptRecorder(props: Props) {
  const { prompt, index, total, stream, existing, retakesLeft, onAccept, onRetake, onSkip, onBack } = props;
  const [phase, setPhase] = useState<Phase>(existing ? "review" : prompt.prepSeconds > 0 ? "prep" : "recording");
  const [take, setTake] = useState<RecordedSegment | null>(existing ?? null);
  const [takeUrl, setTakeUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const liveRef = useRef<HTMLVideoElement>(null);
  const recorder = useSegmentRecorder(props.preferredMimeTypes);

  // Live preview
  useEffect(() => {
    if (liveRef.current && liveRef.current.srcObject !== stream) liveRef.current.srcObject = stream;
  }, [stream, phase]);

  // Object URL lifecycle for the review player
  useEffect(() => {
    if (!take) return setTakeUrl(null);
    const url = URL.createObjectURL(take.blob);
    setTakeUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [take]);

  // Start recording on entering the recording phase
  useEffect(() => {
    if (phase !== "recording") return;
    try {
      recorder.start(stream);
    } catch (err) {
      setError((err as Error).message);
      setPhase("prep");
    }
    return () => recorder.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, stream]);

  const finish = async () => {
    try {
      const seg = await recorder.stop();
      setTake(seg);
      setPhase("review");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const prepLeft = useCountdown(prompt.prepSeconds, phase === "prep", () => setPhase("recording"));
  const recLeft = useCountdown(prompt.maxSeconds, phase === "recording", finish);
  const elapsed = prompt.maxSeconds - recLeft;
  const canStop = elapsed >= prompt.minSeconds;

  const retake = () => {
    setTake(null);
    onRetake();
    setPhase(prompt.prepSeconds > 0 ? "prep" : "recording");
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between text-sm text-slate-500">
        <span>
          Question {index + 1} of {total}
          {prompt.optional && <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs">optional</span>}
        </span>
        <span aria-live="polite">
          {phase === "prep" && `Starting in ${Math.ceil(prepLeft)}…`}
          {phase === "recording" && (
            <span className="inline-flex items-center gap-1.5 font-medium text-red-600">
              <span className="h-2 w-2 animate-pulse rounded-full bg-red-600" /> REC {fmt(elapsed)} / {fmt(prompt.maxSeconds)}
            </span>
          )}
        </span>
      </div>

      <div>
        <h2 className="text-xl font-semibold">{prompt.title}</h2>
        {prompt.body && <p className="mt-1 text-slate-600">{prompt.body}</p>}
      </div>

      <div className="relative aspect-video overflow-hidden rounded-xl bg-black">
        {phase === "review" && takeUrl ? (
          <video key={takeUrl} src={takeUrl} controls playsInline className="h-full w-full object-contain" />
        ) : (
          <video ref={liveRef} autoPlay muted playsInline className="h-full w-full -scale-x-100 object-cover" />
        )}
        {phase === "prep" && (
          <div className="absolute inset-0 grid place-items-center bg-black/40 text-7xl font-bold text-white">
            {Math.ceil(prepLeft)}
          </div>
        )}
        {phase === "recording" && (
          <div className="absolute inset-x-0 bottom-0 h-1.5 bg-white/20">
            <div className="h-full bg-red-500 transition-[width] duration-100" style={{ width: `${(elapsed / prompt.maxSeconds) * 100}%` }} />
          </div>
        )}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          {onBack && phase !== "recording" && (
            <button type="button" onClick={onBack} className="rounded-lg px-3 py-2 text-slate-600 hover:bg-slate-100">
              Back
            </button>
          )}
          {onSkip && phase !== "recording" && (
            <button type="button" onClick={onSkip} className="rounded-lg px-3 py-2 text-slate-600 hover:bg-slate-100">
              Skip question
            </button>
          )}
        </div>
        <div className="flex gap-2">
          {phase === "prep" && (
            <button type="button" onClick={() => setPhase("recording")} className="rounded-lg bg-brand px-4 py-2 font-medium text-white">
              Start now
            </button>
          )}
          {phase === "recording" && (
            <button
              type="button"
              onClick={finish}
              disabled={!canStop}
              title={canStop ? undefined : `Record at least ${prompt.minSeconds}s`}
              className="rounded-lg bg-red-600 px-4 py-2 font-medium text-white disabled:opacity-50"
            >
              {canStop ? "Stop" : `Stop (in ${Math.ceil(prompt.minSeconds - elapsed)}s)`}
            </button>
          )}
          {phase === "review" && (
            <>
              <button
                type="button"
                onClick={retake}
                disabled={retakesLeft <= 0}
                className="rounded-lg border border-slate-300 px-4 py-2 font-medium disabled:opacity-50"
              >
                Retake{retakesLeft <= 0 ? "" : ` (${retakesLeft} left)`}
              </button>
              <button
                type="button"
                onClick={() => take && onAccept(take)}
                className="rounded-lg bg-brand px-4 py-2 font-medium text-white"
              >
                {index + 1 === total ? "Use this take & review" : "Use this take & continue"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
