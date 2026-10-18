import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const REQUIRED_ENV = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"] as const;

/**
 * Refreshes the Supabase session cookie and guards /admin. Must never throw:
 * an exception here fails every request with MIDDLEWARE_INVOCATION_FAILED.
 */
export async function updateSession(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    // NEXT_PUBLIC_* values are inlined at build time: after adding them in
    // Vercel, redeploy so the new build picks them up.
    const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
    console.error(`Missing environment variables: ${missing.join(", ")}`);
    return new NextResponse(
      `Server misconfigured: missing ${missing.join(", ")}. Set them in the Vercel project and redeploy.`,
      { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }

  let response = NextResponse.next({ request });
  let user: { is_anonymous?: boolean } | null = null;

  try {
    const supabase = createServerClient(url, anonKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(toSet) {
          toSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          toSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    });
    ({
      data: { user },
    } = await supabase.auth.getUser());
  } catch (err) {
    // Supabase unreachable or misconfigured: serve the page without a session
    // refresh rather than failing the request. /admin falls through to login.
    console.error("Supabase session refresh failed", err);
  }

  if (request.nextUrl.pathname.startsWith("/admin") && (!user || user.is_anonymous)) {
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.search = `?next=${encodeURIComponent(request.nextUrl.pathname + request.nextUrl.search)}`;
    return NextResponse.redirect(login);
  }

  return response;
}
