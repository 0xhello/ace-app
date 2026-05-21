/**
 * /api/ops/signals-all — unified signal feed across all 3 sports.
 *
 * Returns a single flat array of signals in the canonical OpsSignal shape
 * so the comparison panel (and other future lab tools) can slice across
 * sports without juggling three endpoint shapes.
 *
 * Lookback window default 180 days (enough for meaningful comparison
 * but small enough to keep the JSON payload reasonable).
 *
 * Auth: gated by /api/ops/* middleware.
 */
import { NextRequest, NextResponse } from "next/server";
import { spawnSync } from "child_process";
import path from "path";

export const dynamic = "force-dynamic";

interface OpsSignalDTO {
  id: number;
  sport: "nba" | "mlb" | "soccer";
  game_id: string | null;
  game_date: string;
  commence_time: string | null;
  home_team: string;
  away_team: string;
  market: string;
  bet_side: string;
  line: number | null;
  book: string;
  book_odds: number | null;
  edge_pp: number | null;
  status: string;
  correct: number | null;
  detected_at: string | null;
  confidence_tier: "A" | "B" | "C" | null;
  kelly_fraction: number | null;
  closing_pinnacle_prob: number | null;
  clv_pp: number | null;
}

interface Response {
  signals: OpsSignalDTO[];
  meta: {
    days: number;
    counts: Record<string, number>;
    today: string;
    refreshed_at: string;
  };
  error?: string;
}

function readData(dbDir: string, days: number): Response {
  const script = `
import json, os, sqlite3, sys
from datetime import datetime, timedelta

DB_DIR = ${JSON.stringify(dbDir)}
DAYS   = ${days}

window_start = (datetime.now() - timedelta(days=DAYS - 1)).strftime("%Y-%m-%d")
today = datetime.now().strftime("%Y-%m-%d")

def open_conn(name):
    p = os.path.join(DB_DIR, name)
    if not os.path.exists(p): return None
    try:
        c = sqlite3.connect(p); c.row_factory = sqlite3.Row; return c
    except Exception:
        return None

def table_exists(conn, name):
    return conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone() is not None

signals = []
counts = {"nba": 0, "mlb": 0, "soccer": 0}

# ── NBA (signal_log has different columns and older DBs may not have book fields) ──
conn = open_conn("signal_log.db")
if conn and table_exists(conn, "signal_log"):
    cols = {row[1] for row in conn.execute("PRAGMA table_info(signal_log)").fetchall()}
    book_expr = "book" if "book" in cols else "NULL"
    book_odds_expr = "book_odds" if "book_odds" in cols else ("bet_odds" if "bet_odds" in cols else "NULL")
    edge_expr = "edge" if "edge" in cols else "NULL"
    detected_expr = "logged_at" if "logged_at" in cols else ("detected_at" if "detected_at" in cols else "created_at")
    for r in conn.execute(
        "SELECT id, game_id, game_date, home_team, away_team, "
        "       signal_type AS market, bet_side, "
        "       line_at_signal AS line, " + book_expr + " AS book, " + book_odds_expr + " AS book_odds, "
        "       " + edge_expr + " AS edge_pp, status, covered AS correct, "
        "       " + detected_expr + " AS detected_at, NULL AS confidence_tier, "
        "       NULL AS kelly_fraction, NULL AS closing_pinnacle_prob, "
        "       NULL AS clv_pp "
        "FROM signal_log WHERE game_date >= ?",
        (window_start,),
    ).fetchall():
        d = dict(r); d["sport"] = "nba"; d["commence_time"] = None
        signals.append(d); counts["nba"] += 1
    conn.close()

# ── MLB ──
conn = open_conn("mlb_signal_log.db")
if conn and table_exists(conn, "mlb_signals"):
    for r in conn.execute(
        "SELECT id, game_id, game_date, home_team, away_team, commence_time, "
        "       market, bet_side, line, book, book_odds, edge_pp, status, "
        "       correct, detected_at, confidence_tier, kelly_fraction, "
        "       closing_pinnacle_prob, clv_pp "
        "FROM mlb_signals WHERE game_date >= ?",
        (window_start,),
    ).fetchall():
        d = dict(r); d["sport"] = "mlb"
        signals.append(d); counts["mlb"] += 1
    conn.close()

# ── Soccer / WC ──
conn = open_conn("wc_signal_log.db")
if conn and table_exists(conn, "soccer_signals"):
    for r in conn.execute(
        "SELECT id, game_id, game_date, home_team, away_team, commence_time, "
        "       market, bet_side, total_line AS line, book, book_odds, edge_pp, "
        "       status, correct, detected_at, confidence_tier, kelly_fraction, "
        "       closing_pinnacle_prob, clv_pp "
        "FROM soccer_signals WHERE game_date >= ?",
        (window_start,),
    ).fetchall():
        d = dict(r); d["sport"] = "soccer"
        signals.append(d); counts["soccer"] += 1
    conn.close()

print(json.dumps({
    "signals": signals,
    "meta":    {"days": DAYS, "counts": counts, "today": today},
}))
`;
  const r = spawnSync("python3", ["-c", script], { encoding: "utf-8", timeout: 12_000 });
  try {
    const parsed = JSON.parse(r.stdout) as Response;
    parsed.meta.refreshed_at = new Date().toISOString();
    return parsed;
  } catch {
    return {
      signals: [],
      meta: {
        days,
        counts: { nba: 0, mlb: 0, soccer: 0 },
        today: new Date().toISOString().slice(0, 10),
        refreshed_at: new Date().toISOString(),
      },
      error: r.stderr?.slice(-300) || "parse_failed",
    };
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const raw = parseInt(searchParams.get("days") ?? "180", 10);
  const days = Math.min(365, Math.max(1, Number.isFinite(raw) ? raw : 180));
  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
  const dbDir = path.join(appRoot, "ml", "nba_spread", "data");
  return NextResponse.json(readData(dbDir, days));
}
