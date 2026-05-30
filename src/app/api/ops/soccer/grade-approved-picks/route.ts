/**
 * /api/ops/soccer/grade-approved-picks — manual settle trigger (M43).
 *
 * The worker auto-grades soccer_approved_picks daily at 9:15 AM ET. For
 * the UCL final demo we need to settle picks at fulltime (~14:00 ET) so
 * the dashboard shows W/L while investors are watching, not 19h later.
 *
 * GET-only by design — gated by the standard /api/ops/* read-token
 * middleware. Reuses the worker's _approved_picks_result_lookup so the
 * same data path (soccer_model_candidates final scores + Sportmonks
 * goal events from M38 cache) drives both auto-grading and manual.
 *
 * Idempotent: picks already settled stay settled.
 *
 * Returns:
 *   { ok, graded: int, skipped_no_result: int, durationSec, exitCode }
 */
import { NextRequest, NextResponse } from "next/server";
import { spawnSync } from "child_process";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  const appRoot = process.cwd().includes("/.next/standalone")
    ? "/app"
    : process.cwd();

  // The python entry point mirrors the worker's callback wiring so we
  // settle picks the same way the autonomous tick would.
  const script = `
import json, sqlite3, sys
from typing import Any, Dict, Optional
from ml.world_cup.signal_logger import DB_PATH as _DB
from ml.soccer.approved_picks import grade_approved_picks
from ml.soccer.sportmonks_fixture import (
    get_cached_bundle_by_teams, get_goal_scorers,
)

def lookup(game_id: str) -> Optional[Dict[str, Any]]:
    try:
        conn = sqlite3.connect(str(_DB))
        conn.row_factory = sqlite3.Row
        try:
            row = conn.execute(
                "SELECT home_score, away_score "
                "FROM soccer_model_candidates "
                "WHERE game_id = ? AND home_score IS NOT NULL "
                "LIMIT 1",
                (game_id,),
            ).fetchone()
            if not row or row["home_score"] is None or row["away_score"] is None:
                return None
            result: Dict[str, Any] = {
                "home_score": int(row["home_score"]),
                "away_score": int(row["away_score"]),
                "status": "final",
            }
            ap_row = conn.execute(
                "SELECT fixture_label, commence_time "
                "FROM soccer_approved_picks WHERE game_id = ? LIMIT 1",
                (game_id,),
            ).fetchone()
            if ap_row and ap_row["fixture_label"]:
                label = ap_row["fixture_label"]
                home_away = label.split(" · ")[0]
                if " vs " in home_away:
                    h, a = home_away.split(" vs ", 1)
                    bundle = get_cached_bundle_by_teams(
                        h.strip(), a.strip(),
                        commence_time_iso=ap_row["commence_time"],
                    )
                    scorers = get_goal_scorers(bundle)
                    if scorers is not None:
                        result["goal_scorers"] = scorers
            return result
        finally:
            conn.close()
    except Exception:
        return None

try:
    summary = grade_approved_picks(result_lookup=lookup)
    print(json.dumps({"ok": True, **summary}, default=str))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)[:300]})); sys.exit(1)
`;

  const start = Date.now();
  const result = spawnSync("python3", ["-c", script], {
    encoding: "utf-8",
    timeout: 60_000,
    cwd: appRoot,
  });
  const durationSec = Math.round((Date.now() - start) / 1000);

  try {
    const parsed = JSON.parse(result.stdout);
    return NextResponse.json({
      ...parsed,
      durationSec,
      exitCode: result.status ?? -1,
    });
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: "grade subprocess returned non-JSON output",
        durationSec,
        exitCode: result.status ?? -1,
        stderr_tail: (result.stderr ?? "").slice(-600),
        stdout_tail: (result.stdout ?? "").slice(-400),
      },
      { status: 500 },
    );
  }
}
