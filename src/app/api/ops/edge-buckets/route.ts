/**
 * /api/ops/edge-buckets — does higher edge actually predict higher win rate?
 *
 * Splits all graded signals (across all 3 sports) into edge-magnitude
 * buckets and reports per-bucket win rate / ROI / avg CLV / sample size.
 * If our 3-5pp band wins 52% and our 7pp+ band wins 60%, the edge math
 * is doing its job. If they all win the same, edge magnitude isn't
 * meaningful and tier-A/B/C is just a label.
 *
 * Default buckets (edge_pp is a decimal probability):
 *   [3pp, 4pp)   — minimum-edge alerts
 *   [4pp, 5pp)
 *   [5pp, 7pp)
 *   [7pp, ∞)     — big edge / big mispricing
 *
 * Buckets are configurable via ?bounds= comma-separated decimal cuts
 * (e.g. ?bounds=0.03,0.05,0.10 yields three buckets). Defaults match
 * the table above.
 *
 * Auth: gated by /api/ops/* middleware.
 */
import { NextRequest, NextResponse } from "next/server";
import { spawnSync } from "child_process";
import path from "path";

export const dynamic = "force-dynamic";

export interface EdgeBucket {
  label: string;             // human-readable range, e.g. "3-4pp"
  min_pp: number;            // inclusive lower bound (decimal)
  max_pp: number | null;     // exclusive upper bound, null = unbounded
  signals: number;
  graded: number;
  wins: number;
  losses: number;
  win_rate: number | null;
  roi: number | null;
  avg_clv: number | null;
  // Confidence interval helps you tell "5pp band beats 4pp band" from
  // "5pp band has 8 picks and got lucky." Wilson 95% CI on win rate.
  ci_low: number | null;
  ci_high: number | null;
}

export interface BucketReport {
  sport: "nba" | "mlb" | "soccer";
  total_graded: number;
  buckets: EdgeBucket[];
}

interface Response {
  reports: BucketReport[];
  combined: BucketReport;     // all sports merged
  meta: {
    bucket_bounds: number[];
    sport_filter: string;
    days: number;
    today: string;
    refreshed_at: string;
  };
  error?: string;
}

const DEFAULT_BOUNDS = [0.03, 0.04, 0.05, 0.07];

function readData(dbDir: string, bounds: number[], sportFilter: string, days: number): Response {
  const script = `
import json, os, sqlite3, math, sys
from datetime import datetime, timedelta

DB_DIR = ${JSON.stringify(dbDir)}
BOUNDS = ${JSON.stringify(bounds)}
SPORT_FILTER = ${JSON.stringify(sportFilter)}
DAYS = ${days}

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

def load_sport_uniform(db_name, table_name):
    """MLB / Soccer have the canonical schema (edge_pp, correct, clv_pp)."""
    conn = open_conn(db_name)
    if not conn or not table_exists(conn, table_name):
        return []
    rows = [dict(r) for r in conn.execute(
        f"SELECT edge_pp, correct, status, clv_pp "
        f"FROM {table_name} WHERE game_date >= ?",
        (window_start,),
    ).fetchall()]
    conn.close()
    return rows

def load_nba():
    """NBA uses different column names; 'covered' is the win column."""
    conn = open_conn("signal_log.db")
    if not conn or not table_exists(conn, "signal_log"):
        return []
    rows = [dict(r) for r in conn.execute(
        "SELECT edge AS edge_pp, covered AS correct, status, NULL AS clv_pp "
        "FROM signal_log WHERE game_date >= ?",
        (window_start,),
    ).fetchall()]
    conn.close()
    return rows

# Wilson score 95% CI bounds for binomial proportion. More honest than
# raw win_rate for small samples — a 100% rate at n=3 isn't 100% confidence.
def wilson_ci(wins, n, z=1.96):
    if n == 0: return (None, None)
    p = wins / n
    denom = 1 + (z*z)/n
    centre = p + (z*z)/(2*n)
    radius = z * math.sqrt((p * (1 - p) / n) + (z*z) / (4*n*n))
    return ((centre - radius) / denom, (centre + radius) / denom)

def bucket_label(lo, hi):
    lo_p = round(lo * 100, 1)
    if hi is None:
        return f"{lo_p:g}pp+"
    hi_p = round(hi * 100, 1)
    return f"{lo_p:g}-{hi_p:g}pp"

def build_buckets(rows):
    out = []
    # Sort bounds, make pairs (lo, hi) where last hi is None (unbounded)
    sb = sorted(set(BOUNDS))
    pairs = []
    for i, lo in enumerate(sb):
        hi = sb[i+1] if i + 1 < len(sb) else None
        pairs.append((lo, hi))

    for lo, hi in pairs:
        in_bucket = []
        for r in rows:
            e = r.get("edge_pp")
            if e is None: continue
            try: e = float(e)
            except: continue
            if e < lo: continue
            if hi is not None and e >= hi: continue
            in_bucket.append(r)
        graded = [r for r in in_bucket if r.get("status") in ("graded", "proxy_captured")]
        wins   = sum(1 for r in graded if r.get("correct") == 1)
        losses = sum(1 for r in graded if r.get("correct") == 0)
        clv_xs = [r["clv_pp"] for r in graded if r.get("clv_pp") is not None]
        ci_low, ci_high = wilson_ci(wins, wins + losses)
        payout = 100/110
        wr  = wins / (wins + losses) if (wins + losses) else None
        roi = (wins * payout + losses * -1) / (wins + losses) if (wins + losses) else None
        avgclv = sum(clv_xs) / len(clv_xs) if clv_xs else None
        out.append({
            "label":    bucket_label(lo, hi),
            "min_pp":   lo,
            "max_pp":   hi,
            "signals":  len(in_bucket),
            "graded":   wins + losses,
            "wins":     wins,
            "losses":   losses,
            "win_rate": round(wr, 4)  if wr is not None  else None,
            "roi":      round(roi, 4) if roi is not None else None,
            "avg_clv":  round(avgclv, 4) if avgclv is not None else None,
            "ci_low":   round(ci_low, 4)  if ci_low  is not None else None,
            "ci_high":  round(ci_high, 4) if ci_high is not None else None,
        })
    return out

sport_rows = {}
if SPORT_FILTER in ("all", "nba"):    sport_rows["nba"]    = load_nba()
if SPORT_FILTER in ("all", "mlb"):    sport_rows["mlb"]    = load_sport_uniform("mlb_signal_log.db",  "mlb_signals")
if SPORT_FILTER in ("all", "soccer"): sport_rows["soccer"] = load_sport_uniform("wc_signal_log.db",    "soccer_signals")

reports = []
for sport, rows in sport_rows.items():
    graded_total = sum(1 for r in rows if r.get("status") in ("graded", "proxy_captured"))
    reports.append({
        "sport":         sport,
        "total_graded":  graded_total,
        "buckets":       build_buckets(rows),
    })

# Combined: all sports together
all_rows = []
for rs in sport_rows.values(): all_rows.extend(rs)
combined = {
    "sport":         "combined",
    "total_graded":  sum(1 for r in all_rows if r.get("status") in ("graded", "proxy_captured")),
    "buckets":       build_buckets(all_rows),
}

print(json.dumps({
    "reports": reports,
    "combined": combined,
    "meta": {
        "bucket_bounds": BOUNDS,
        "sport_filter":  SPORT_FILTER,
        "days":          DAYS,
        "today":         today,
    },
}))
`;
  const r = spawnSync("python3", ["-c", script], { encoding: "utf-8", timeout: 10_000 });
  try {
    const parsed = JSON.parse(r.stdout) as Response;
    parsed.meta.refreshed_at = new Date().toISOString();
    return parsed;
  } catch {
    return {
      reports: [],
      combined: { sport: "soccer", total_graded: 0, buckets: [] }, // placeholder shape
      meta: {
        bucket_bounds: bounds,
        sport_filter: sportFilter,
        days,
        today: new Date().toISOString().slice(0, 10),
        refreshed_at: new Date().toISOString(),
      },
      error: r.stderr?.slice(-300) || "parse_failed",
    };
  }
}

function parseBounds(raw: string | null): number[] {
  if (!raw) return DEFAULT_BOUNDS;
  const vals = raw.split(",")
    .map((s) => parseFloat(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0 && n < 1);
  return vals.length >= 1 ? vals.sort((a, b) => a - b) : DEFAULT_BOUNDS;
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const bounds = parseBounds(searchParams.get("bounds"));
  const sportRaw = (searchParams.get("sport") ?? "all").toLowerCase();
  const sportFilter =
    sportRaw === "nba" || sportRaw === "mlb" || sportRaw === "soccer" ? sportRaw : "all";
  const rawDays = parseInt(searchParams.get("days") ?? "180", 10);
  const days = Math.min(365, Math.max(7, Number.isFinite(rawDays) ? rawDays : 180));

  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
  const dbDir = path.join(appRoot, "ml", "nba_spread", "data");
  return NextResponse.json(readData(dbDir, bounds, sportFilter, days));
}
