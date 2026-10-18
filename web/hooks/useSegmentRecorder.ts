"use client";
import { useCallback, useRef, useState } from "react";

export interface RecordedSegment {
  blob: Blob;
  mimeType: string;
  durationMs: number;
}

const DEFAULT_MIME_TYPES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2", // Safari
  "video/mp4",
];

export function pickMimeType(preferred: string[] = DEFAULT_MIME_TYPES): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return preferred.find((t) => MediaRecorder.isTypeSupported(t));
}

/** Timeslice in ms: MediaRecorder emits a chunk this often, so a crash mid-take loses at most ~1s in memory. */
const TIMESLICE_MS = 1000;

/**
 * Thin wrapper over MediaRecorder that records one segment (one prompt answer)
 * at a time in timesliced chunks and resolves the assembled Blob on stop().
 */
export function useSegmentRecorder(preferredMimeTypes?: string[]) {
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const [isRecording, setIsRecording] = useState(false);

  const start = useCallback(
    (stream: MediaStream) => {
      if (recorderRef.current?.state === "recording") return;
      const mimeType = pickMimeType(preferredMimeTypes);
      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 2_500_000,
        audioBitsPerSecond: 128_000,
      });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.start(TIMESLICE_MS);
      startedAtRef.current = performance.now();
      recorderRef.current = recorder;
      setIsRecording(true);
    },
    [preferredMimeTypes],
  );

  const stop = useCallback(
    () =>
      new Promise<RecordedSegment>((resolve, reject) => {
        const recorder = recorderRef.current;
        if (!recorder || recorder.state === "inactive") {
          reject(new Error("Not recording"));
          return;
        }
        recorder.onstop = () => {
          const mimeType = recorder.mimeType || chunksRef.current[0]?.type || "video/webm";
          const blob = new Blob(chunksRef.current, { type: mimeType });
          chunksRef.current = [];
          recorderRef.current = null;
          setIsRecording(false);
          resolve({ blob, mimeType, durationMs: Math.round(performance.now() - startedAtRef.current) });
        };
        recorder.onerror = (e) => reject((e as unknown as { error?: Error }).error ?? new Error("Recorder error"));
        recorder.stop();
      }),
    [],
  );

  const cancel = useCallback(() => {
    const r = recorderRef.current;
    if (r && r.state !== "inactive") {
      r.onstop = null;
      r.stop();
    }
    recorderRef.current = null;
    chunksRef.current = [];
    setIsRecording(false);
  }, []);

  return { start, stop, cancel, isRecording };
}
