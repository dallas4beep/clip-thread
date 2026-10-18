"use client";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

function LoginForm() {
  const params = useSearchParams();
  const next = params.get("next") ?? "/admin/moderation";
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="flex w-full max-w-sm flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setState("sending");
        setError(null);
        const { error } = await createClient().auth.signInWithOtp({
          email,
          options: { emailRedirectTo: `${location.origin}/auth/callback?next=${encodeURIComponent(next)}`, shouldCreateUser: false },
        });
        if (error) {
          setError(error.message);
          setState("idle");
        } else setState("sent");
      }}
    >
      <h1 className="text-xl font-semibold">Moderator sign-in</h1>
      {state === "sent" ? (
        <p className="text-slate-600">Check your inbox for a sign-in link.</p>
      ) : (
        <>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            className="rounded-lg border border-slate-300 px-3 py-2"
          />
          <button disabled={state === "sending"} className="rounded-lg bg-indigo-600 px-4 py-2 font-medium text-white disabled:opacity-50">
            {state === "sending" ? "Sending…" : "Send magic link"}
          </button>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </>
      )}
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
