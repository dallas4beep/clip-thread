import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { serverEnv } from "@/lib/env";
import { jsonError, HttpError } from "@/lib/http";
import { sweepProcessor } from "@/lib/processor";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Recovery job: resets videos stuck in `processing` and processes uploads whose
 * webhook was missed. Point a Vercel Cron at this path; the worker itself stays
 * internal and is reached through the PROCESSOR_URL binding.
 */
export async function GET(req: Request) {
  try {
    const secret = serverEnv().CRON_SECRET;
    const given = req.headers.get("authorization") ?? "";
    const expected = `Bearer ${secret}`;
    if (!secret || given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected)))
      throw new HttpError(401, "Unauthorized");
    return NextResponse.json(await sweepProcessor((maxDuration - 10) * 1000));
  } catch (err) {
    return jsonError(err);
  }
}
