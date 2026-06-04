/**
 * /api/ops/soccer/refresh-research — ONE call that refreshes all pre-match
 * research caches for the soccer teams currently on the board:
 *   • injuries / suspensions   (soccer_injuries)
 *   • recent form / last-N     (soccer_team_recent_results)
 *
 * Manual / on-demand trigger. Day-to-day freshness is handled automatically by
 * the boot+interval scheduler in src/instrumentation.ts (same shared function),
 * so a cron is optional. Decoupled from rendering — pages only read the tables.
 *
 *   GET /api/ops/soccer/refresh-research              → scan cached board for soccer teams
 *   GET /api/ops/soccer/refresh-research?teams=Mexico,Brazil
 *
 * Read-token gated through middleware.
 */
import { NextRequest, NextResponse } from "next/server";
import { refreshSoccerResearch } from "@/lib/research-refresh";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const teams = (req.nextUrl.searchParams.get("teams") || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const result = await refreshSoccerResearch(teams);
  return NextResponse.json(result, { status: result.ok === false ? 500 : 200 });
}
