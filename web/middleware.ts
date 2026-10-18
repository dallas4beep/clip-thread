import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  // Public API + embed assets don't need a session refresh.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|embed.js|embed-demo.html|api/public).*)"],
};
