/**
 * /api/ops/soccer/refresh-recent-form — populate the soccer_team_recent_results
 * table (Sportmonks last-N results) for the soccer teams currently on the board.
 *
 * National sides have no rows in our club-only soccer_team_form table, so the
 * game match-center pulls last-5 form from Sportmonks. Results move slowly, so
 * run this periodically (worker / cron) or on demand — NOT per render. The game
 * page reads the table read-only via fetchSoccerRecentForm().
 *
 *   POST /api/ops/soccer/refresh-recent-form              → scan cached board for soccer teams
 *   POST /api/ops/soccer/refresh-recent-form?teams=Mexico,Brazil
 *
 * This mutates the local/prod recent-form cache, so it must remain POST-only
 * behind an admin session. GET is reserved for read-token-safe reads.
 */
import { NextRequest, NextResponse } from "next/server";
import { spawnSync } from "child_process";
import * as serverCache from "@/lib/server-cache";
import { sportTab } from "@/lib/sport-tab";

export const dynamic = "force-dynamic";

const CACHE_KEY = "board-games";   // must match src/app/api/board/route.ts

async function runRefresh(req: NextRequest) {
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
from ml.soccer.recent_results import refresh_for_teams
names = json.loads(${JSON.stringify(JSON.stringify(teams))})
try:
    print(json.dumps(refresh_for_teams(names)))
except Exception as e:
    print(json.dumps({"error": str(e)[:300]})); sys.exit(1)
`;
  const r = spawnSync("python3", ["-c", script], {
    encoding: "utf-8",
    timeout: 120_000,
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

export async function POST(req: NextRequest) {
  return runRefresh(req);
}

export async function GET() {
  return NextResponse.json(
    { ok: false, error: "refresh-recent-form mutates data and must be called with POST by an admin session" },
    { status: 405, headers: { Allow: "POST" } },
  );
}
