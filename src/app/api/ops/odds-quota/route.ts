import { NextResponse } from "next/server";
import { readOddsQuota } from "@/lib/server-cache";

export const dynamic = "force-dynamic";

// Plan: $59/mo → 100,000 credits/month. Used to compute "pace" headroom.
const PLAN_CREDITS = 100_000;

export async function GET() {
  const entry = await readOddsQuota();

  if (!entry) {
    return NextResponse.json({
      ok: false,
      reason: "no_data",
      message: "No quota data in Redis yet. Will populate after the next Odds API call.",
    });
  }

  const ageMs = Date.now() - entry.seen_at;
  const pctUsed   = entry.used      / PLAN_CREDITS;
  const pctLeft   = entry.remaining / PLAN_CREDITS;

  return NextResponse.json({
    ok: true,
    plan_credits: PLAN_CREDITS,
    remaining: entry.remaining,
    used: entry.used,
    pct_used: Math.round(pctUsed * 1000) / 10,    // one-decimal percent
    pct_remaining: Math.round(pctLeft * 1000) / 10,
    last_cost: entry.last_cost,
    source: entry.source,
    endpoint: entry.endpoint,
    seen_at: new Date(entry.seen_at).toISOString(),
    age_seconds: Math.round(ageMs / 1000),
    refreshed_at: new Date().toISOString(),
  });
}
