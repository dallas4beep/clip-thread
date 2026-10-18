"use client";
import { useEffect, useRef, useState } from "react";
import type { CampaignDTO, ConsentDocumentDTO } from "@/lib/types";
import { SubmissionFlow } from "./SubmissionFlow";

/** Button + modal wrapper. The consent gate lives inside this modal, before any upload begins. */
export function SubmissionLauncher({ campaign, consentDocument }: { campaign: CampaignDTO; consentDocument: ConsentDocumentDTO }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  const requestClose = () => {
    if (busy && !confirm("Close? Your recorded answers are saved in this browser and you can come back to finish.")) return;
    setOpen(false);
  };

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="rounded-xl bg-brand px-6 py-3 text-lg font-semibold text-white shadow-sm">
        Record your video
      </button>
      <dialog
        ref={dialogRef}
        onCancel={(e) => {
          e.preventDefault();
          requestClose();
        }}
        className="m-auto w-[min(720px,calc(100vw-1.5rem))] rounded-2xl p-0 shadow-2xl backdrop:bg-slate-900/60"
        aria-label={campaign.title}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <span className="font-medium">{campaign.title}</span>
          <button type="button" onClick={requestClose} aria-label="Close" className="rounded p-1 text-slate-500 hover:bg-slate-100">
            ✕
          </button>
        </div>
        <div className="max-h-[calc(100dvh-8rem)] overflow-y-auto p-5">
          {open && <SubmissionFlow campaign={campaign} consentDocument={consentDocument} onBusyChange={setBusy} />}
        </div>
      </dialog>
    </>
  );
}
