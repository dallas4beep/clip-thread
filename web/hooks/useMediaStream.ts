"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export type MediaStatus = "idle" | "requesting" | "ready" | "denied" | "unsupported" | "error";

export interface MediaStreamOptions {
  width?: number;
  height?: number;
  frameRate?: number;
}

/** Owns a single camera+mic stream for the whole flow (re-requesting per prompt re-prompts on some browsers). */
export function useMediaStream(opts: MediaStreamOptions = {}) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [status, setStatus] = useState<MediaStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStream(null);
    setStatus("idle");
  }, []);

  const request = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setStatus("unsupported");
      setError("This browser cannot record video. Please use a recent Chrome, Edge, Firefox or Safari.");
      return null;
    }
    if (streamRef.current) return streamRef.current;
    setStatus("requesting");
    setError(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: opts.width ?? 1280 },
          height: { ideal: opts.height ?? 720 },
          frameRate: { ideal: opts.frameRate ?? 30, max: 30 },
          facingMode: "user",
        },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = s;
      setStream(s);
      setStatus("ready");
      return s;
    } catch (err) {
      const name = (err as DOMException).name;
      if (name === "NotAllowedError" || name === "SecurityError") {
        setStatus("denied");
        setError("Camera/microphone access was blocked. Allow it in your browser's address bar and try again.");
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        setStatus("error");
        setError("No camera or microphone was found.");
      } else {
        setStatus("error");
        setError((err as Error).message || "Could not start the camera.");
      }
      return null;
    }
  }, [opts.width, opts.height, opts.frameRate]);

  useEffect(() => stop, [stop]);

  return { stream, status, error, request, stop };
}
