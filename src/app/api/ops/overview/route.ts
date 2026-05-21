import { NextResponse } from "next/server";
import { spawnSync } from "child_process";
import path from "path";

export const dynamic = "force-dynamic";

interface SportSummary {
  key: "nba" | "wc" | "mlb";
  label: string;
  worker: { lastPollAt: string | null; lastPollOk: boolean | null };
  jobs:   { fetchLastRunAt: string | null; gradeLastRunAt: string | null };
  totals: { total: number; open: number; graded: number; today: number };
  record: { wins: number; losses: number; winRate: number | null; roi: number | null };
  schemaMigratedAt: string | null;
  error?: string;
}

interface RecentSignal {
  sport: "nba" | "wc" | "mlb";
  game_id: string;
  game_date: string;
  matchup: string;
  market: string;
  bet_side: string;
  book: string;
  edge_pp: number | null;
  confidence_tier: "A" | "B" | "C" | null;
  status: string;
  correct: number | null;
  detected_at: string;
}

interface OverviewResponse {
  sports: SportSummary[];
  recent: RecentSignal[];
  refreshedAt: string;
}

function readAll(dbDir: string): OverviewResponse {
  // Reads all three signal DBs in one Python subprocess. The migrations
  // for WC and MLB run automatically so the schema stays current even on
  // first ops-overview hit after a deploy.
  const script = `
import json, os, sqlite3
from datetime import datetime, timezone

def parse_iso(raw):
    try: return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except: return None

def today_et_str():
    # Crude ET cutoff using local time; precise enough for "today" counter
    return datetime.now().strftime("%Y-%m-%d")

def safe(d, k, default=None):
    return d.get(k, default) if d else default

def open_conn(db_path):
    if not os.path.exists(db_path): return None
    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        return conn
    except Exception:
        return None

def read_meta(conn, table_exists):
    if not table_exists: return {}
    try:
        rows = conn.execute("SELECT key, value FROM meta").fetchall()
        return {r["key"]: r["value"] for r in rows}
    except Exception:
        return {}

def table_exists(conn, name):
    try:
        r = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone()
        return r is not None
    except Exception:
        return False

# Trigger migrations on WC and MLB so schema is always current
try:
    from ml.world_cup.signal_logger import init_db as wc_init_db
    wc_init_db()
except Exception:
    pass
try:
    from ml.mlb.signal_logger import init_db as mlb_init_db
    mlb_init_db()
except Exception:
    pass

dbs = {
    "wc":  ${JSON.stringify(path.join("__DBDIR__", "wc_signal_log.db"))},
    "mlb": ${JSON.stringify(path.join("__DBDIR__", "mlb_signal_log.db"))},
    "nba": ${JSON.stringify(path.join("__DBDIR__", "signal_log.db"))},
}
# substitute the placeholder with the runtime dbDir
import sys
for k in list(dbs):
    dbs[k] = dbs[k].replace("__DBDIR__", ${JSON.stringify(dbDir)})

today = today_et_str()
sports = []
recent_all = []

# ── WC ──
wc_conn = open_conn(dbs["wc"])
if wc_conn:
    has_meta = table_exists(wc_conn, "meta")
    has_signals = table_exists(wc_conn, "soccer_signals")
    meta = read_meta(wc_conn, has_meta)
    signals = []
    if has_signals:
        try:
            signals = [dict(r) for r in wc_conn.execute(
                "SELECT * FROM soccer_signals ORDER BY detected_at DESC"
            ).fetchall()]
        except Exception:
            pass
    wc_conn.close()
    graded = [s for s in signals if s["status"] == "graded"]
    wins   = sum(1 for s in graded if s["correct"] == 1)
    losses = len(graded) - wins
    payout = 100 / 110
    sports.append({
        "key": "wc",
        "label": "World Cup",
        "worker": {
            "lastPollAt": meta.get("last_poll_at"),
            "lastPollOk": (meta.get("last_poll_ok") == "1") if meta.get("last_poll_ok") is not None else None,
        },
        "jobs": {
            "fetchLastRunAt": meta.get("job:fetch_signals:last_run_at") or meta.get("last_poll_at"),
            "gradeLastRunAt": meta.get("job:grade_results:last_run_at"),
        },
        "totals": {
            "total": len(signals),
            "open":  sum(1 for s in signals if s["status"] == "open"),
            "graded": len(graded),
            "today": sum(1 for s in signals if (s.get("game_date") or "") == today),
        },
        "record": {
            "wins": wins,
            "losses": losses,
            "winRate": (wins / len(graded)) if graded else None,
            "roi":     ((wins * payout + losses * -1) / len(graded)) if graded else None,
        },
        "schemaMigratedAt": meta.get("schema:last_migration_at"),
    })
    for s in signals[:8]:
        recent_all.append({
            "sport": "wc",
            "game_id": s["game_id"], "game_date": s["game_date"],
            "matchup": f"{s['away_team']} @ {s['home_team']}",
            "market": s["market"], "bet_side": s["bet_side"], "book": s["book"],
            "edge_pp": s.get("edge_pp"),
            "confidence_tier": s.get("confidence_tier"),
            "status": s["status"], "correct": s.get("correct"),
            "detected_at": s["detected_at"],
        })
else:
    sports.append({
        "key": "wc", "label": "World Cup",
        "worker": {"lastPollAt": None, "lastPollOk": None},
        "jobs": {"fetchLastRunAt": None, "gradeLastRunAt": None},
        "totals": {"total": 0, "open": 0, "graded": 0, "today": 0},
        "record": {"wins": 0, "losses": 0, "winRate": None, "roi": None},
        "schemaMigratedAt": None, "error": "db missing",
    })

# ── MLB ──
mlb_conn = open_conn(dbs["mlb"])
if mlb_conn:
    has_meta = table_exists(mlb_conn, "meta")
    has_signals = table_exists(mlb_conn, "mlb_signals")
    meta = read_meta(mlb_conn, has_meta)
    signals = []
    if has_signals:
        try:
            signals = [dict(r) for r in mlb_conn.execute(
                "SELECT * FROM mlb_signals ORDER BY detected_at DESC"
            ).fetchall()]
        except Exception:
            pass
    mlb_conn.close()
    graded = [s for s in signals if s["status"] == "graded"]
    wins   = sum(1 for s in graded if s["correct"] == 1)
    losses = len(graded) - wins
    payout = 100 / 110
    sports.append({
        "key": "mlb",
        "label": "MLB",
        "worker": {
            "lastPollAt": meta.get("last_poll_at"),
            "lastPollOk": (meta.get("last_poll_ok") == "1") if meta.get("last_poll_ok") is not None else None,
        },
        "jobs": {
            "fetchLastRunAt": meta.get("job:fetch_signals:last_run_at") or meta.get("last_poll_at"),
            "gradeLastRunAt": meta.get("job:grade_results:last_run_at"),
        },
        "totals": {
            "total": len(signals),
            "open":  sum(1 for s in signals if s["status"] == "open"),
            "graded": len(graded),
            "today": sum(1 for s in signals if (s.get("game_date") or "") == today),
        },
        "record": {
            "wins": wins,
            "losses": losses,
            "winRate": (wins / len(graded)) if graded else None,
            "roi":     ((wins * payout + losses * -1) / len(graded)) if graded else None,
        },
        "schemaMigratedAt": meta.get("schema:last_migration_at"),
    })
    for s in signals[:8]:
        recent_all.append({
            "sport": "mlb",
            "game_id": s["game_id"], "game_date": s["game_date"],
            "matchup": f"{s['away_team']} @ {s['home_team']}",
            "market": s["market"], "bet_side": s["bet_side"], "book": s["book"],
            "edge_pp": s.get("edge_pp"),
            "confidence_tier": s.get("confidence_tier"),
            "status": s["status"], "correct": s.get("correct"),
            "detected_at": s["detected_at"],
        })
else:
    sports.append({
        "key": "mlb", "label": "MLB",
        "worker": {"lastPollAt": None, "lastPollOk": None},
        "jobs": {"fetchLastRunAt": None, "gradeLastRunAt": None},
        "totals": {"total": 0, "open": 0, "graded": 0, "today": 0},
        "record": {"wins": 0, "losses": 0, "winRate": None, "roi": None},
        "schemaMigratedAt": None, "error": "db missing",
    })

# ── NBA ── (different schema; just summarize from signal_log table)
nba_conn = open_conn(dbs["nba"])
if nba_conn:
    has_meta = table_exists(nba_conn, "meta")
    has_signals = table_exists(nba_conn, "signal_log")
    meta = read_meta(nba_conn, has_meta)
    signals = []
    if has_signals:
        try:
            cols = {row[1] for row in nba_conn.execute("PRAGMA table_info(signal_log)").fetchall()}
            detected_expr = "logged_at" if "logged_at" in cols else ("detected_at" if "detected_at" in cols else "created_at")
            signals = [dict(r) for r in nba_conn.execute(
                "SELECT game_id, game_date, home_team, away_team, signal_type as market, "
                "bet_side, status, covered as correct, " + detected_expr + " as detected_at "
                "FROM signal_log ORDER BY " + detected_expr + " DESC LIMIT 200"
            ).fetchall()]
        except Exception:
            pass
    nba_conn.close()
    graded = [s for s in signals if s["status"] in ("graded", "proxy_captured")]
    wins   = sum(1 for s in graded if s.get("correct") == 1)
    losses = sum(1 for s in graded if s.get("correct") == 0)
    settled = wins + losses
    payout = 100 / 110
    sports.append({
        "key": "nba",
        "label": "NBA",
        "worker": {
            "lastPollAt": meta.get("snapshot:last_run_at") or meta.get("last_poll_at"),
            "lastPollOk": None,  # NBA worker uses different status conventions
        },
        "jobs": {
            "fetchLastRunAt": meta.get("job:fetch_and_predict:last_run_at"),
            "gradeLastRunAt": meta.get("job:grade_results:last_run_at"),
        },
        "totals": {
            "total": len(signals),
            "open":  sum(1 for s in signals if s["status"] == "open"),
            "graded": settled,
            "today": sum(1 for s in signals if (s.get("game_date") or "") == today),
        },
        "record": {
            "wins": wins,
            "losses": losses,
            "winRate": (wins / settled) if settled else None,
            "roi":     ((wins * payout + losses * -1) / settled) if settled else None,
        },
        "schemaMigratedAt": None,  # NBA schema predates the migration-stamp convention
    })
    for s in signals[:8]:
        recent_all.append({
            "sport": "nba",
            "game_id": s["game_id"], "game_date": s["game_date"],
            "matchup": f"{s['away_team']} @ {s['home_team']}",
            "market": s["market"], "bet_side": s["bet_side"], "book": "",
            "edge_pp": None,
            "confidence_tier": None,
            "status": s["status"], "correct": s.get("correct"),
            "detected_at": s["detected_at"],
        })

# Sort recent across sports by detected_at desc, keep top 15
recent_all.sort(key=lambda r: r.get("detected_at") or "", reverse=True)
recent_all = recent_all[:15]

print(json.dumps({
    "sports": sports,
    "recent": recent_all,
    "refreshedAt": datetime.now(timezone.utc).isoformat(),
}, default=str))
`;

  const result = spawnSync("python3", ["-c", script], {
    encoding: "utf-8",
    timeout: 8_000,
  });
  try {
    return JSON.parse(result.stdout) as OverviewResponse;
  } catch {
    return { sports: [], recent: [], refreshedAt: new Date().toISOString() };
  }
}

export async function GET() {
  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
  const dbDir = path.join(appRoot, "ml", "nba_spread", "data");
  const payload = readAll(dbDir);
  return NextResponse.json(payload);
}
