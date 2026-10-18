import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SubmissionLauncher } from "@/components/submission/SubmissionLauncher";
import { brandingSchema, promptFlowSchema } from "@/lib/prompt-flow";
import { createClient } from "@/lib/supabase/server";
import type { CampaignDTO, ConsentDocumentDTO } from "@/lib/types";

export const dynamic = "force-dynamic";

async function load(slug: string) {
  const supabase = await createClient();
  const { data: c } = await supabase
    .from("campaigns")
    .select("id,slug,title,description,prompt_flow,branding")
    .eq("slug", slug)
    .eq("is_active", true)
    .maybeSingle();
  if (!c) return null;

  // Campaign-specific consent wins over the global default.
  const { data: docs } = await supabase
    .from("consent_documents")
    .select("id,campaign_id,version,title,body_markdown,body_sha256,required_checks")
    .eq("is_current", true)
    .or(`campaign_id.eq.${c.id},campaign_id.is.null`)
    .order("created_at", { ascending: false });
  const doc = docs?.find((d) => d.campaign_id === c.id) ?? docs?.find((d) => d.campaign_id === null);

  return { c, doc };
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const data = await load((await params).slug);
  return { title: data?.c.title ?? "Not found" };
}

export default async function CampaignPage({ params }: { params: Promise<{ slug: string }> }) {
  const data = await load((await params).slug);
  if (!data) notFound();
  const { c, doc } = data;

  const flow = promptFlowSchema.safeParse(c.prompt_flow);
  if (!flow.success || !doc) {
    return (
      <main className="mx-auto max-w-xl px-4 py-16">
        <h1 className="text-xl font-semibold">This campaign isn&apos;t configured correctly</h1>
        <pre className="mt-4 overflow-auto rounded bg-slate-100 p-3 text-xs">
          {!doc ? "No current consent document." : JSON.stringify(flow.error?.issues, null, 2)}
        </pre>
      </main>
    );
  }

  const branding = brandingSchema.parse(c.branding ?? {});
  const campaign: CampaignDTO = { id: c.id, slug: c.slug, title: c.title, description: c.description, flow: flow.data, branding };

  return (
    <main
      className="flex min-h-dvh items-center justify-center px-4 py-16"
      style={{ "--brand": branding.primaryColor, fontFamily: branding.fontFamily } as React.CSSProperties}
    >
      <div className="flex max-w-xl flex-col items-center gap-6 text-center">
        {branding.logoUrl && <img src={branding.logoUrl} alt="" className="h-10" />}
        <h1 className="text-3xl font-bold tracking-tight">{c.title}</h1>
        {c.description && <p className="text-lg text-slate-600">{c.description}</p>}
        <SubmissionLauncher campaign={campaign} consentDocument={doc as ConsentDocumentDTO} />
      </div>
    </main>
  );
}
