/**
 * /api/ops/performance-timeseries — daily rollup of signal performance.
 *
 * The "are we getting better?" endpoint. For each sport, returns one row
 * per ET-day for the last N days:
 *   { date, signals_fired, graded, wins, losses, win_rate, roi, avg_clv,
 *     positive_clv_pct }
 *
 * Reads from signal_log (NBA), mlb_signals (MLB), soccer_signals (WC/Soccer).
 *
 * Day buckets use the *game_date* column where available (NBA uses
 * commence_time → ET date). This matches the convention the per-sport
 * routes already use so cross-sport comparisons line up.
 *
 * Query params:
 *   ?days=60         lookback window (default 60, max 180)
 *   ?sport=nba|mlb|soccer|all   default 'all'
 *   ?market=h2h|spreads|totals|...   optional filter
 *   ?tier=A|B|C      optional filter (MLB/Soccer have it; NBA doesn't)
 *
 * Auth: gated by /api/ops/* middleware.
 */
import { NextRequest, NextResponse } from "next/server";
import { spawnSync } from "child_process";
import path from "path";

export const dynamic = "force-dynamic";

export interface DayPoint {
  date: string;          // 'YYYY-MM-DD' in ET
  signals: number;
  graded: number;
  wins: number;
  losses: number;
  win_rate: number | null;
  roi: number | null;            // flat-bet at -110 vig
  avg_clv: number | null;        // decimal probability points
  positive_clv_pct: number | null;
}

export interface SportSeries {
  sport: "nba" | "mlb" | "soccer";
  points: DayPoint[];
  total_signals: number;
  total_graded: number;
  total_wins: number;
  total_losses: number;
  total_win_rate: number | null;
  total_roi: number | null;
  total_avg_clv: number | null;
}

interface Response {
  series: SportSeries[];
  meta: {
    days: number;
    sport_filter: string;
    market_filter: string | null;
    tier_filter: string | null;
    today: string;          // ET date string
    refreshed_at: string;
  };
  error?: string;
}

function readData(
  dbDir: string,
  days: number,
  sportFilter: string,
  marketFilter: string | null,
  tierFilter: string | null,
): Response {
  // One Python subprocess does all reads + aggregation. Keeps the TS side
  // a pure render. The script reads three SQLite DBs, buckets by game_date,
  // computes per-day stats, and returns the full payload.
  const script = `
import json, os, re, sqlite3, sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone

DB_DIR        = ${JSON.stringify(dbDir)}
DAYS          = ${days}
SPORT_FILTER  = ${JSON.stringify(sportFilter)}
MARKET_FILTER = ${JSON.stringify(marketFilter ?? "")}
TIER_FILTER   = ${JSON.stringify(tierFilter ?? "")}

# ET day boundaries — match the convention used by the per-sport routes
# (game_date is stored as the ET calendar date of the matchup).
def et_today():
    # Crude: use local server time and assume Railway runs UTC; the actual
    # routes do the same. Off by at most a few hours which is fine for
    # day-bucket aggregation.
    return datetime.now().strftime("%Y-%m-%d")

today = et_today()
window_start = (datetime.now() - timedelta(days=DAYS - 1)).strftime("%Y-%m-%d")

def open_conn(name):
    p = os.path.join(DB_DIR, name)
    if not os.path.exists(p):
        return None
    try:
        c = sqlite3.connect(p)
        c.row_factory = sqlite3.Row
        return c
    except Exception:
        return None

def table_exists(conn, name):
    r = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone()
    return r is not None

# ── NBA — signal_log has different column names (signal_type vs market,
# covered vs correct, logged_at vs detected_at, no confidence_tier). ──
def load_nba():
    conn = open_conn("signal_log.db")
    if not conn or not table_exists(conn, "signal_log"):
        return []
    rows = [dict(r) for r in conn.execute(
        "SELECT game_date, signal_type AS market, status, covered AS correct, "
        "       logged_at AS detected_at "
        "FROM signal_log "
        "WHERE game_date >= ? "
        "ORDER BY game_date ASC",
        (window_start,),
    ).fetchall()]
    conn.close()
    if MARKET_FILTER:
        rows = [r for r in rows if r["market"] == MARKET_FILTER]
    # NBA doesn't have confidence_tier on signal_log — silently drop the
    # tier filter rather than returning empty (no false signal of "filter
    # works on every sport").
    return rows

# ── MLB / Soccer — uniform schema; full feature set ──
def load_sport(db_name, table_name):
    conn = open_conn(db_name)
    if not conn or not table_exists(conn, table_name):
        return []
    rows = [dict(r) for r in conn.execute(
        f"SELECT game_date, market, status, correct, detected_at, "
        f"       confidence_tier, clv_pp "
        f"FROM {table_name} "
        f"WHERE game_date >= ? "
        f"ORDER BY game_date ASC",
        (window_start,),
    ).fetchall()]
    conn.close()
    if MARKET_FILTER:
        rows = [r for r in rows if r["market"] == MARKET_FILTER]
    if TIER_FILTER:
        rows = [r for r in rows if r.get("confidence_tier") == TIER_FILTER]
    return rows

sports = []
if SPORT_FILTER in ("all", "nba"):    sports.append(("nba",    load_nba()))
if SPORT_FILTER in ("all", "mlb"):    sports.append(("mlb",    load_sport("mlb_signal_log.db",  "mlb_signals")))
if SPORT_FILTER in ("all", "soccer"): sports.append(("soccer", load_sport("wc_signal_log.db",    "soccer_signals")))

# Build the full day axis so empty days render as zeros (chart looks
# coherent even when activity is sparse). Going from window_start → today.
day_list = []
d = datetime.strptime(window_start, "%Y-%m-%d")
end = datetime.strptime(today, "%Y-%m-%d")
while d <= end:
    day_list.append(d.strftime("%Y-%m-%d"))
    d += timedelta(days=1)

series = []
for sport, rows in sports:
    by_day = {day: {"signals": 0, "graded": 0, "wins": 0, "losses": 0,
                    "clv_sum": 0.0, "clv_n": 0, "clv_pos": 0}
              for day in day_list}
    for r in rows:
        day = r.get("game_date")
        if day not in by_day:
            continue
        b = by_day[day]
        b["signals"] += 1
        st = r.get("status")
        if st == "graded" or st == "proxy_captured":
            b["graded"] += 1
            if r.get("correct") == 1: b["wins"] += 1
            elif r.get("correct") == 0: b["losses"] += 1
        clv = r.get("clv_pp")
        if clv is not None:
            b["clv_sum"] += clv
            b["clv_n"]   += 1
            if clv > 0: b["clv_pos"] += 1

    payout = 100.0 / 110.0
    points = []
    total = {"signals": 0, "graded": 0, "wins": 0, "losses": 0, "clv_sum": 0.0, "clv_n": 0}
    for day in day_list:
        b = by_day[day]
        gr  = b["graded"]
        wr  = (b["wins"] / gr) if gr else None
        roi = ((b["wins"] * payout + b["losses"] * -1) / gr) if gr else None
        avgclv = (b["clv_sum"] / b["clv_n"]) if b["clv_n"] else None
        pclv   = (b["clv_pos"] / b["clv_n"]) if b["clv_n"] else None
        points.append({
            "date":             day,
            "signals":          b["signals"],
            "graded":           gr,
            "wins":             b["wins"],
            "losses":           b["losses"],
            "win_rate":         round(wr, 4)  if wr is not None else None,
            "roi":              round(roi, 4) if roi is not None else None,
            "avg_clv":          round(avgclv, 4) if avgclv is not None else None,
            "positive_clv_pct": round(pclv, 4)   if pclv   is not None else None,
        })
        for k in ("signals", "graded", "wins", "losses"):
            total[k] += b[k]
        total["clv_sum"] += b["clv_sum"]
        total["clv_n"]   += b["clv_n"]

    tot_wr  = (total["wins"] / total["graded"]) if total["graded"] else None
    tot_roi = ((total["wins"] * payout + total["losses"] * -1) / total["graded"]) if total["graded"] else None
    tot_clv = (total["clv_sum"] / total["clv_n"]) if total["clv_n"] else None

    series.append({
        "sport":           sport,
        "points":          points,
        "total_signals":   total["signals"],
        "total_graded":    total["graded"],
        "total_wins":      total["wins"],
        "total_losses":    total["losses"],
        "total_win_rate":  round(tot_wr,  4) if tot_wr  is not None else None,
        "total_roi":       round(tot_roi, 4) if tot_roi is not None else None,
        "total_avg_clv":   round(tot_clv, 4) if tot_clv is not None else None,
    })

print(json.dumps({
    "series": series,
    "meta": {
        "days":          DAYS,
        "sport_filter":  SPORT_FILTER,
        "market_filter": MARKET_FILTER or None,
        "tier_filter":   TIER_FILTER   or None,
        "today":         today,
    },
}))
`;
  const r = spawnSync("python3", ["-c", script], {
    encoding: "utf-8",
    timeout: 12_000,
  });
  try {
    const parsed = JSON.parse(r.stdout) as Response;
    parsed.meta.refreshed_at = new Date().toISOString();
    return parsed;
  } catch {
    return {
      series: [],
      meta: {
        days,
        sport_filter: sportFilter,
        market_filter: marketFilter,
        tier_filter: tierFilter,
        today: new Date().toISOString().slice(0, 10),
        refreshed_at: new Date().toISOString(),
      },
      error: r.stderr?.slice(-300) || "parse_failed",
    };
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  // Defensive bounds: silly days values default to 60; never exceed 180
  // (the readers do a full table scan, no point going further than that).
  const rawDays = parseInt(searchParams.get("days") ?? "60", 10);
  const days = Math.min(180, Math.max(1, Number.isFinite(rawDays) ? rawDays : 60));

  const sportRaw = (searchParams.get("sport") ?? "all").toLowerCase();
  const sportFilter =
    sportRaw === "nba" || sportRaw === "mlb" || sportRaw === "soccer" ? sportRaw : "all";

  const marketFilter = searchParams.get("market") || null;
  const tierFilter = searchParams.get("tier") || null;

  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
  const dbDir = path.join(appRoot, "ml", "nba_spread", "data");

  return NextResponse.json(
    readData(dbDir, days, sportFilter, marketFilter, tierFilter),
  );
}
