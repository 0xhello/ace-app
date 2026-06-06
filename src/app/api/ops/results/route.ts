import { NextResponse } from "next/server";
import { spawnSync } from "child_process";
import path from "path";

export const dynamic = "force-dynamic";

type ResultsResponse = {
  source: "tracked_picks";
  available: boolean;
  message?: string;
  summary: Array<Record<string, unknown>>;
  picks: Array<Record<string, unknown>>;
  refreshedAt: string;
};

function readResults(appRoot: string): ResultsResponse {
  const dbPath = path.join(appRoot, "ml", "nba_spread", "data", "tracked_picks.db");
  const script = `
import json, os, sqlite3
from datetime import datetime, timezone

db_path = ${JSON.stringify(dbPath)}
if not os.path.exists(db_path):
    print(json.dumps({
        "source": "tracked_picks",
        "available": False,
        "message": "tracked_picks.db has not been created/imported yet.",
        "summary": [],
        "picks": [],
        "refreshedAt": datetime.now(timezone.utc).isoformat(),
    }))
    raise SystemExit

conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
summary = [dict(r) for r in conn.execute("""
    SELECT sport,
           COUNT(*) AS graded,
           SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END) AS losses,
           SUM(CASE WHEN result='push' THEN 1 ELSE 0 END) AS pushes,
           SUM(COALESCE(pnl_units, 0)) AS pnl_units,
           AVG(clv_pp) AS avg_clv_pp
    FROM tracked_picks
    WHERE lifecycle='graded'
    GROUP BY sport
    ORDER BY sport
""").fetchall()]
picks = [dict(r) for r in conn.execute("""
    SELECT id, sport, origin, lifecycle, publish_state,
           game_id, game_date, commence_time, league, tournament,
           home_team, away_team, matchup_label,
           market, side, line, selection_label,
           book, odds_american, implied_prob, sharp_prob, model_prob,
           edge_pp, signal_strength, confidence_tier, stake_units,
           closing_book, closing_odds_american, closing_implied_prob, clv_pp, clv_points,
           home_score, away_score, result, result_detail, pnl_units,
           detected_at, tracked_at, graded_at,
           source_table, source_id, source_db
    FROM tracked_picks
    WHERE lifecycle='graded'
    ORDER BY COALESCE(graded_at, game_date, tracked_at) DESC, id DESC
    LIMIT 500
""").fetchall()]
conn.close()
print(json.dumps({
    "source": "tracked_picks",
    "available": True,
    "summary": summary,
    "picks": picks,
    "refreshedAt": datetime.now(timezone.utc).isoformat(),
}))
`;
  const result = spawnSync("python3", ["-c", script], {
    encoding: "utf-8",
    timeout: 8_000,
    cwd: appRoot,
  });

  try {
    return JSON.parse(result.stdout) as ResultsResponse;
  } catch {
    return {
      source: "tracked_picks",
      available: false,
      message: result.stderr || "Failed to read tracked picks results.",
      summary: [],
      picks: [],
      refreshedAt: new Date().toISOString(),
    };
  }
}

export async function GET() {
  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
  return NextResponse.json(readResults(appRoot));
}
