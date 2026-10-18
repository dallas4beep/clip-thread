"use client";
import { useCallback, useEffect, useRef, useState } from "react";

interface Props {
  onChange: (dataUrl: string | null) => void;
  height?: number;
}

/** Minimal pointer-events signature canvas (mouse, touch, pen). Exports a trimmed-size PNG data URL. */
export function SignaturePad({ onChange, height = 140 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [empty, setEmpty] = useState(true);

  const setup = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const w = c.offsetWidth;
    c.width = w * ratio;
    c.height = height * ratio;
    const ctx = c.getContext("2d")!;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#0f172a";
  }, [height]);

  useEffect(setup, [setup]);

  const point = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const down = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    last.current = point(e);
  };
  const move = (e: React.PointerEvent) => {
    if (!drawing.current || !last.current) return;
    const ctx = canvasRef.current!.getContext("2d")!;
    const p = point(e);
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
    if (empty) setEmpty(false);
  };
  const up = () => {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    if (!empty) onChange(canvasRef.current!.toDataURL("image/png"));
  };
  const clear = () => {
    setup();
    setEmpty(true);
    onChange(null);
  };

  return (
    <div>
      <canvas
        ref={canvasRef}
        style={{ height, touchAction: "none" }}
        className="w-full cursor-crosshair rounded-lg border border-dashed border-slate-300 bg-white"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerLeave={up}
        aria-label="Signature drawing area"
        role="img"
      />
      <div className="mt-1 flex justify-between text-xs text-slate-500">
        <span>{empty ? "Draw your signature (optional)" : "Signature captured"}</span>
        <button type="button" onClick={clear} className="underline">
          Clear
        </button>
      </div>
    </div>
  );
}
