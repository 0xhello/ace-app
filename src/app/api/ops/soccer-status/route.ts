/**
 * /api/ops/soccer-status — single-curl truth view of the soccer pipeline.
 *
 * Read-only. Walks every table the soccer engine touches and reports row
 * counts, last-run timestamps for each job, and bootstrap-state meta. Used
 * for diagnosing "I see 0 picks on prod" without having to bounce through
 * three other endpoints.
 *
 * Behind the OPS_READ_TOKEN gate same as the other ops routes.
 */
import { NextResponse } from "next/server";
import { spawnSync } from "child_process";
import path from "path";

export const dynamic = "force-dynamic";

export async function GET() {
  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
  const dbPath = path.join(appRoot, "ml", "nba_spread", "data", "wc_signal_log.db");

  const script = `
import json, os, sqlite3
from pathlib import Path

db = Path(${JSON.stringify(dbPath)})
out = {
    "db_exists": db.exists(),
    "env": {
        "SPORTMONKS_API_TOKEN": bool(os.getenv("SPORTMONKS_API_TOKEN", "").strip())
                                or bool(os.getenv("SPORTMONKS_TOKEN", "").strip()),
        "ODDS_API_KEY": bool(os.getenv("ODDS_API_KEY", "").strip()),
        "API_FOOTBALL_KEY": bool(os.getenv("API_FOOTBALL_KEY", "").strip()),
    },
    "table_counts": {},
    "meta": {},
    "candidate_breakdown": {},
    "prop_card_breakdown": {},
    "recent_candidates": [],
    "blockers": [],
}

if not db.exists():
    out["blockers"].append("DB file missing on container")
    print(json.dumps(out)); raise SystemExit(0)

conn = sqlite3.connect(str(db))
conn.row_factory = sqlite3.Row

def count(name, where=""):
    try:
        r = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (name,)
        ).fetchone()
        if not r: return None  # table doesn't exist
        sql = f"SELECT COUNT(*) FROM {name}"
        if where: sql += f" WHERE {where}"
        return int(conn.execute(sql).fetchone()[0])
    except Exception as e:
        return f"err: {str(e)[:80]}"

# Critical tables
for t in [
    "soccer_team_form",
    "soccer_model_candidates",
    "soccer_prop_cards",
    "soccer_fixture_provider_map",
    "soccer_fixture_feature_snapshot",
    "soccer_player_feature_snapshot",
    "soccer_live_player_state",
    "soccer_source_player_stats",
    "soccer_source_team_match_stats",
    "wc_historical_form",
    "wc_players",
    "player_baselines",
]:
    out["table_counts"][t] = count(t)

# Meta keys related to soccer jobs
try:
    for r in conn.execute(
        "SELECT key, value FROM meta WHERE key LIKE '%soccer%' OR key LIKE '%form%' "
        "OR key LIKE '%candidates%' OR key LIKE '%prop%' OR key LIKE '%sportmonks%' "
        "OR key LIKE 'last_poll%' ORDER BY key"
    ).fetchall():
        v = r["value"]
        if isinstance(v, str) and len(v) > 200: v = v[:200] + "..."
        out["meta"][r["key"]] = v
except Exception:
    pass

# Candidate breakdown
try:
    rows = conn.execute(
        "SELECT status, COUNT(*) AS n FROM soccer_model_candidates GROUP BY status"
    ).fetchall()
    out["candidate_breakdown"] = {r["status"]: r["n"] for r in rows}
    # Track record (graded only)
    gr = conn.execute(
        """SELECT COUNT(*) AS n,
                  SUM(CASE WHEN correct=1 THEN 1 ELSE 0 END) AS wins,
                  SUM(CASE WHEN correct=0 THEN 1 ELSE 0 END) AS losses
           FROM soccer_model_candidates WHERE correct IS NOT NULL"""
    ).fetchone()
    if gr and gr["n"]:
        out["candidate_breakdown"]["graded_record"] = {
            "n": gr["n"], "wins": gr["wins"], "losses": gr["losses"],
            "win_rate": round((gr["wins"] or 0) / gr["n"], 4),
        }
except Exception as e:
    out["candidate_breakdown"]["error"] = str(e)[:80]

# Prop card breakdown
try:
    rows = conn.execute(
        "SELECT decision, COUNT(*) AS n FROM soccer_prop_cards GROUP BY decision"
    ).fetchall()
    out["prop_card_breakdown"] = {r["decision"]: r["n"] for r in rows}
except Exception as e:
    out["prop_card_breakdown"]["error"] = str(e)[:80]

# Sample 3 most-recent candidates
try:
    for r in conn.execute(
        """SELECT home_team, away_team, tournament, market, bet_side,
                  model_prob, book_prob, edge_pp, book, book_odds,
                  status, correct, detected_at
           FROM soccer_model_candidates
           ORDER BY detected_at DESC LIMIT 3"""
    ).fetchall():
        out["recent_candidates"].append(dict(r))
except Exception:
    pass

# Synthesize blockers
if (out["table_counts"].get("soccer_team_form") or 0) == 0:
    out["blockers"].append("soccer_team_form is empty — form ingestor hasn't completed; candidates backfill will produce 0")
if (out["table_counts"].get("soccer_model_candidates") or 0) == 0:
    if (out["table_counts"].get("soccer_team_form") or 0) > 0:
        out["blockers"].append("soccer_team_form has data but soccer_model_candidates is empty — boot backfill failed; check meta job:soccer_backfill:last_run_at")
    else:
        out["blockers"].append("soccer_model_candidates is empty (expected: form sync must run first)")
if not out["env"]["SPORTMONKS_API_TOKEN"]:
    out["blockers"].append("SPORTMONKS_API_TOKEN not set on Railway — prop card pipeline can't pull lineups")
if not out["env"]["ODDS_API_KEY"]:
    out["blockers"].append("ODDS_API_KEY not set — no live signal scanning possible")

conn.close()
print(json.dumps(out, default=str))
`;
  const r = spawnSync("python3", ["-c", script], { encoding: "utf-8", timeout: 10_000, cwd: appRoot });
  try {
    return NextResponse.json(JSON.parse(r.stdout));
  } catch {
    return NextResponse.json({
      error: "diagnostic probe failed",
      stderr: r.stderr?.slice(-500) ?? "",
      stdout_tail: r.stdout?.slice(-200) ?? "",
    }, { status: 500 });
  }
}
