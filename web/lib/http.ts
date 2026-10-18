import { NextResponse } from "next/server";
import type { ZodError } from "zod";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function jsonError(err: unknown, headers?: HeadersInit) {
  if (err instanceof HttpError) {
    return NextResponse.json({ error: err.message, details: err.details }, { status: err.status, headers });
  }
  console.error(err);
  return NextResponse.json({ error: "Internal server error" }, { status: 500, headers });
}

export function zodDetails(err: ZodError) {
  return err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

export async function parseBody<T>(req: Request, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: ZodError } }): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpError(422, "Invalid request", zodDetails(parsed.error));
  return parsed.data;
}

export function clientIp(req: Request): string | null {
  const h = req.headers;
  const ip = h.get("cf-connecting-ip") ?? h.get("x-real-ip") ?? h.get("x-forwarded-for")?.split(",")[0];
  return ip?.trim() || null;
}
