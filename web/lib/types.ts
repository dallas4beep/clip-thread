import type { Branding, PromptFlow } from "@/lib/prompt-flow";

export interface CampaignDTO {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  flow: PromptFlow;
  branding: Branding;
}

export interface ConsentDocumentDTO {
  id: string;
  version: string;
  title: string;
  body_markdown: string;
  body_sha256: string;
  required_checks: { id: string; label: string }[];
}

export type VideoStatus =
  | "draft" | "uploaded" | "processing" | "pending_review"
  | "approved" | "rejected" | "flagged" | "failed";
