import { NextResponse } from "next/server";
import { spawnSync } from "child_process";
import path from "path";

export const dynamic = "force-dynamic";

type TodayResponse = {
  source: "tracked_picks";
  available: boolean;
  message?: string;
  open: Array<Record<string, unknown>>;
  awaitingGrade: Array<Record<string, unknown>>;
  refreshedAt: string;
};

function readToday(appRoot: string): TodayResponse {
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
        "open": [],
        "awaitingGrade": [],
        "refreshedAt": datetime.now(timezone.utc).isoformat(),
    }))
    raise SystemExit

conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
base_cols = """
    id, sport, origin, lifecycle, publish_state,
    game_id, game_date, commence_time, league, tournament,
    home_team, away_team, matchup_label,
    market, side, line, selection_label,
    book, odds_american, implied_prob, sharp_prob, model_prob,
    edge_pp, signal_strength, confidence_tier, stake_units,
    detected_at, tracked_at, source_table, source_id, source_db
"""
open_rows = [dict(r) for r in conn.execute(f"""
    SELECT {base_cols}
    FROM tracked_picks
    WHERE lifecycle='open'
    ORDER BY COALESCE(commence_time, game_date, tracked_at) ASC, id ASC
    LIMIT 200
""").fetchall()]
# Open rows whose commence time is already in the past need grading attention.
awaiting_grade = []
now = datetime.now(timezone.utc)
for r in open_rows:
    raw = r.get('commence_time')
    if not raw:
        continue
    try:
        dt = datetime.fromisoformat(str(raw).replace('Z', '+00:00'))
        if dt < now:
            awaiting_grade.append(r)
    except Exception:
        pass
conn.close()
print(json.dumps({
    "source": "tracked_picks",
    "available": True,
    "open": open_rows,
    "awaitingGrade": awaiting_grade,
    "refreshedAt": datetime.now(timezone.utc).isoformat(),
}))
`;
  const result = spawnSync("python3", ["-c", script], {
    encoding: "utf-8",
    timeout: 8_000,
    cwd: appRoot,
  });

  try {
    return JSON.parse(result.stdout) as TodayResponse;
  } catch {
    return {
      source: "tracked_picks",
      available: false,
      message: result.stderr || "Failed to read tracked picks today view.",
      open: [],
      awaitingGrade: [],
      refreshedAt: new Date().toISOString(),
    };
  }
}

export async function GET() {
  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
  return NextResponse.json(readToday(appRoot));
}
