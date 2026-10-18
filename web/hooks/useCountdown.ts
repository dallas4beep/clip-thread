"use client";
import { useEffect, useRef, useState } from "react";

/**
 * Wall-clock based countdown (drift-free, survives throttled timers).
 * Resets to `seconds` whenever `running` flips to true. Calls onDone once.
 */
export function useCountdown(seconds: number, running: boolean, onDone?: () => void) {
  const [remaining, setRemaining] = useState(seconds);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    setRemaining(seconds);
    if (!running) return;
    const endsAt = Date.now() + seconds * 1000;
    let fired = false;
    const tick = () => {
      const left = Math.max(0, endsAt - Date.now()) / 1000;
      setRemaining(left);
      if (left <= 0 && !fired) {
        fired = true;
        clearInterval(interval);
        clearTimeout(timeout);
        onDoneRef.current?.();
      }
    };
    const interval = setInterval(tick, 100);
    // Backup in case the interval is throttled in a background tab.
    const timeout = setTimeout(tick, seconds * 1000 + 20);
    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [seconds, running]);

  return remaining;
}
