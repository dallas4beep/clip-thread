import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function Home() {
  const supabase = await createClient();
  const { data: campaigns } = await supabase
    .from("campaigns")
    .select("slug,title,description")
    .eq("is_active", true)
    .order("created_at", { ascending: false });

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-12">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Clipthread</h1>
        <Link href="/admin/moderation" className="text-sm text-slate-600 underline">
          Moderation
        </Link>
      </header>
      <ul className="grid gap-4">
        {(campaigns ?? []).map((c) => (
          <li key={c.slug} className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="font-semibold">{c.title}</h2>
            {c.description && <p className="mt-1 text-sm text-slate-600">{c.description}</p>}
            <div className="mt-3 flex gap-4 text-sm">
              <Link href={`/c/${c.slug}`} className="font-medium text-indigo-600">
                Record →
              </Link>
              <a href={`/embed-demo.html?wall=${c.slug}`} className="text-slate-600">
                Wall preview
              </a>
            </div>
          </li>
        ))}
        {!campaigns?.length && <li className="text-slate-500">No active campaigns. Run the seed or create one.</li>}
      </ul>
    </main>
  );
}
