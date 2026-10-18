"use client";
import { useEffect, useRef, useState } from "react";
import type { ConsentDocumentDTO } from "@/lib/types";
import { SignaturePad } from "./SignaturePad";

export interface ConsentSubmission {
  documentId: string;
  documentSha256: string;
  signerName: string;
  signatureImage: string | null;
  checks: Record<string, boolean>;
  clientTimestamp: string;
}

interface Props {
  document: ConsentDocumentDTO;
  defaultName?: string;
  busy?: boolean;
  error?: string | null;
  onBack: () => void;
  onSubmit: (c: ConsentSubmission) => void;
}

/**
 * Mandatory release step. The submit button stays disabled until the terms
 * were scrolled to the end, every required box is ticked and a name is typed.
 * The server re-validates all of this before issuing any upload URL.
 */
export function ConsentGate({ document: doc, defaultName = "", busy, error, onBack, onSubmit }: Props) {
  const [readToEnd, setReadToEnd] = useState(false);
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [name, setName] = useState(defaultName);
  const [signature, setSignature] = useState<string | null>(null);
  const termsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = termsRef.current;
    if (el && el.scrollHeight <= el.clientHeight + 4) setReadToEnd(true);
  }, []);

  const allChecked = doc.required_checks.every((c) => checks[c.id]);
  const canSubmit = readToEnd && allChecked && name.trim().length >= 2 && !busy;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        onSubmit({
          documentId: doc.id,
          documentSha256: doc.body_sha256,
          signerName: name.trim(),
          signatureImage: signature,
          checks,
          clientTimestamp: new Date().toISOString(),
        });
      }}
    >
      <div>
        <h2 className="text-xl font-semibold">{doc.title}</h2>
        <p className="text-xs text-slate-500">Version {doc.version} · SHA-256 {doc.body_sha256.slice(0, 12)}…</p>
      </div>

      <div
        ref={termsRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollTop + el.clientHeight >= el.scrollHeight - 8) setReadToEnd(true);
        }}
        className="max-h-56 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm leading-relaxed text-slate-700"
        tabIndex={0}
        aria-label="Release terms"
      >
        {doc.body_markdown.split(/\n{2,}/).map((para, i) => (
          <p key={i} className="mb-3 last:mb-0 whitespace-pre-line">
            {para}
          </p>
        ))}
      </div>
      {!readToEnd && <p className="text-xs text-amber-700">Scroll to the end of the terms to continue.</p>}

      <fieldset disabled={!readToEnd} className="flex flex-col gap-2 disabled:opacity-50">
        {doc.required_checks.map((c) => (
          <label key={c.id} className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-[var(--brand)]"
              checked={Boolean(checks[c.id])}
              onChange={(e) => setChecks((s) => ({ ...s, [c.id]: e.target.checked }))}
              required
            />
            <span>{c.label}</span>
          </label>
        ))}
      </fieldset>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Full legal name (electronic signature)</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
          maxLength={200}
          required
          className="rounded-lg border border-slate-300 px-3 py-2"
        />
      </label>

      <SignaturePad onChange={setSignature} />

      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      <div className="flex justify-between">
        <button type="button" onClick={onBack} disabled={busy} className="rounded-lg px-3 py-2 text-slate-600 hover:bg-slate-100">
          Back
        </button>
        <button type="submit" disabled={!canSubmit} className="rounded-lg bg-brand px-4 py-2 font-medium text-white disabled:opacity-50">
          {busy ? "Saving consent…" : "I agree — submit my video"}
        </button>
      </div>
      <p className="text-xs text-slate-500">
        Your agreement is stored with a timestamp, your user ID, IP address and a cryptographic signature.
      </p>
    </form>
  );
}
