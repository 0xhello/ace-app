import { NextRequest, NextResponse } from "next/server";
import { spawnSync } from "child_process";

export const dynamic = "force-dynamic";

const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
const dbPath = `${appRoot}/ml/nba_spread/data/signal_log.db`;

function authorized(req: NextRequest): boolean {
  const key = process.env.INTERNAL_API_KEY;
  if (!key) return false;
  const header = req.headers.get("x-internal-key");
  const param  = new URL(req.url).searchParams.get("key");
  return header === key || param === key;
}

const QUERY = (db: string, signalId: string | null, days: number) => `
import sqlite3, json
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

db   = ${JSON.stringify(db)}
sid  = ${signalId ? signalId : "None"}
days = ${days}

conn = sqlite3.connect(db)
conn.row_factory = sqlite3.Row
_TZ = ZoneInfo("America/New_York")
today = datetime.now(_TZ).strftime("%Y-%m-%d")
since = (datetime.now(_TZ) - timedelta(days=days)).strftime("%Y-%m-%d")

try:
    where = "AND s.id = ?" if sid else "AND s.game_date >= ?"
    param = (sid,) if sid else (since,)

    rows = conn.execute(f"""
        SELECT
            s.id, s.game_date, s.home_team, s.away_team,
            s.commence_time, s.bet_side, s.line_at_signal,
            s.opening_line, s.closing_line, s.signal_type, s.signal_detail,
            s.execution_source, s.status, s.regime,
            s.bet_rest_days, s.opp_rest_days,
            s.score_home, s.score_away, s.covered,
            s.closing_source, s.clv_points, s.notes,
            p.home_line            AS p_home_line,
            p.home_cover_prob, p.away_cover_prob,
            p.pick_side, p.pick_confidence, p.is_bet,
            p.model_version, p.edge_vs_pinnacle, p.pinnacle_prob,
            p.home_injury_impact, p.away_injury_impact,
            p.injury_data_available, p.matchup_context, p.features_json,
            e.id                   AS exec_id,
            e.mode, e.book, e.signal_line, e.fill_line,
            e.stake, e.outcome, e.pnl_units, e.graded_at
        FROM signal_log s
        LEFT JOIN predictions  p ON p.game_id = s.game_id
        LEFT JOIN execution_log e ON e.signal_id = s.id
        WHERE 1=1 {where}
        ORDER BY s.game_date DESC, s.id DESC
    """, param).fetchall()

    out = []
    for r in rows:
        d = dict(r)
        if d.get("features_json"):
            try:
                feats = json.loads(d["features_json"])
                # keep the most diagnostic fields
                keep = ["home_net_rtg","away_net_rtg","home_off_rtg","away_off_rtg",
                        "home_def_rtg","away_def_rtg","home_win_pct","away_win_pct",
                        "home_pace","away_pace","home_rest_days","away_rest_days",
                        "home_injury_impact","away_injury_impact","home_spread","away_spread",
                        "sos_home","sos_away","home_streak","away_streak",
                        "home_last5_win_pct","away_last5_win_pct"]
                d["features"] = {k: round(feats[k], 4) if isinstance(feats.get(k), float) else feats.get(k)
                                 for k in keep if k in feats}
            except Exception:
                d["features"] = {}
            del d["features_json"]
        out.append(d)

    print(json.dumps({"ok": True, "count": len(out), "as_of": today, "signals": out}))
except Exception as e:
    import traceback
    print(json.dumps({"ok": False, "error": str(e), "trace": traceback.format_exc()}))
finally:
    conn.close()
`;

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const params = new URL(req.url).searchParams;
  const signalId = params.get("id");   // ?id=17  → single signal
  const days     = parseInt(params.get("days") ?? "7", 10);

  const result = spawnSync("python3", ["-c", QUERY(dbPath, signalId, isNaN(days) ? 7 : days)], {
    encoding: "utf-8",
    timeout: 10_000,
  });

  if (result.error) return NextResponse.json({ error: result.error.message }, { status: 500 });

  try {
    return NextResponse.json(JSON.parse(result.stdout));
  } catch {
    return NextResponse.json({ error: "parse error", raw: result.stdout.slice(0, 400) }, { status: 500 });
  }
}
