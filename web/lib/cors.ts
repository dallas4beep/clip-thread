/** CORS for public read-only endpoints consumed by embed.js on third-party sites. */
export function corsHeaders(origin: string | null, allowed: string[] = []): HeadersInit | null {
  const base = {
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (allowed.length === 0) return { ...base, "Access-Control-Allow-Origin": "*" };
  if (origin && allowed.includes(origin)) return { ...base, "Access-Control-Allow-Origin": origin };
  return null;
}
