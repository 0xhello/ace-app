/**
 * /api/ops/soccer/refresh-injuries — populate the general soccer_injuries
 * table (Sportmonks `sidelined`) for the soccer teams currently on the board.
 *
 * Injuries move over days, so this is meant to run periodically (worker /
 * cron) or on demand — NOT on every board render. The board reads the table
 * read-only via fetchSoccerInjuries().
 *
 *   GET /api/ops/soccer/refresh-injuries              → scan cached board for soccer teams
 *   GET /api/ops/soccer/refresh-injuries?teams=Brazil,France,Liverpool
 *
 * Read-token gated through middleware.
 */
import { NextRequest, NextResponse } from "next/server";
import { spawnSync } from "child_process";
import * as serverCache from "@/lib/server-cache";
import { sportTab } from "@/lib/sport-tab";

export const dynamic = "force-dynamic";

const CACHE_KEY = "board:last";

export async function GET(req: NextRequest) {
  // 1. Resolve the team list: explicit param, else soccer teams off the cached board.
  let teams: string[] = (req.nextUrl.searchParams.get("teams") || "")
    .split(",").map((s) => s.trim()).filter(Boolean);

  if (teams.length === 0) {
    try {
      const cached = await serverCache.get(CACHE_KEY);
      const games: Array<{ sport?: string; sport_title?: string; home_team?: string; away_team?: string }> =
        cached?.data?.games ?? [];
      const set = new Set<string>();
      for (const g of games) {
        if (sportTab(g.sport, g.sport_title) === "SOCCER") {
          if (g.home_team) set.add(g.home_team);
          if (g.away_team) set.add(g.away_team);
        }
      }
      teams = [...set];
    } catch {
      // fall through with empty teams
    }
  }

  if (teams.length === 0) {
    return NextResponse.json({ ok: true, refreshed: 0, note: "no soccer teams on the board to refresh" });
  }

  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
  const script = `
import json, sys
from ml.soccer.injuries import refresh_for_teams
names = json.loads(${JSON.stringify(JSON.stringify(teams))})
try:
    print(json.dumps(refresh_for_teams(names)))
except Exception as e:
    print(json.dumps({"error": str(e)[:300]})); sys.exit(1)
`;
  const r = spawnSync("python3", ["-c", script], {
    encoding: "utf-8",
    timeout: 60_000,
    cwd: appRoot,
  });
  try {
    return NextResponse.json({ ok: true, teams: teams.length, ...JSON.parse(r.stdout) });
  } catch {
    return NextResponse.json(
      { ok: false, error: "refresh subprocess failed", stderr: r.stderr?.slice(-400) ?? "" },
      { status: 500 },
    );
  }
}
