/**
 * /api/picks/soccer — subscriber-facing soccer picks feed.
 *
 * Returns open + recently-graded soccer picks across all markets (h2h,
 * totals, asian_handicap, player_goal_scorer_anytime) plus the overall
 * graded record. Powers the SoccerPicksPanel on the subscriber dashboard.
 *
 * Public read (no auth) — same policy as /api/performance/public. The
 * pick metadata itself is fully visible; the AI explainer is fetched
 * separately via /api/picks/explain when the user expands a card.
 */
import { NextResponse } from "next/server";
import { fetchSoccerPicks } from "@/lib/soccer-picks";

export const dynamic = "force-dynamic";

export async function GET() {
  const payload = fetchSoccerPicks(15);
  return NextResponse.json(payload, {
    headers: {
      // Mild edge cache — picks change as new signals fire, but a few
      // seconds of staleness is fine for a subscriber feed.
      "Cache-Control": "public, max-age=30, s-maxage=60, stale-while-revalidate=120",
    },
  });
}
