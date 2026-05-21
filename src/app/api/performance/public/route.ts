/**
 * /api/performance/public — the credibility surface for first-touch
 * subscribers. Returns a multi-sport graded-pick track record with
 * win rate / ROI / CLV broken out per sport, plus a recent-picks ledger.
 *
 * Different from /api/model-performance:
 *   - NBA was a single-sport CSV reader. This one aggregates NBA +
 *     MLB + Soccer (WC + EPL + La Liga + Bundesliga + Serie A + Ligue 1 + UCL)
 *     from their respective signal_log databases.
 *   - This route is INTENTIONALLY PUBLIC (no auth gate). It's the page
 *     we link in launch tweets / Discord posts / paid acquisition.
 *   - Edge / pinnacle_prob fields are stripped on pending picks so the
 *     unauthenticated user doesn't get free actionable picks (same
 *     gating logic as the NBA route).
 *
 * Why this exists:
 *   Subscribers need to trust the system before they pay. The proof is
 *   a clean ledger of graded picks with W/L/CLV — verifiable, dated,
 *   honestly stratified by sport and tier. No marketing copy, just
 *   real data.
 */
import { NextRequest, NextResponse } from "next/server";
import { spawnSync } from "child_process";
import path from "path";

export const dynamic = "force-dynamic";

interface Pick {
  sport: "nba" | "mlb" | "soccer";
  tournament: string | null;
  game_date: string;
  detected_at: string | null;
  matchup: string;
  market: string;
  bet_side: string;
  line: number | null;
  book: string | null;
  book_odds: number | null;
  status: string;        // 'graded' | 'open' | 'void'
  correct: number | null; // 1 win, 0 loss, null pending/void
  // Edge fields gated for pending picks when unauth
  edge_pp: number | null;
  pinnacle_prob: number | null;
  prior_prob: number | null;
  clv_pp: number | null;
  confidence_tier: "A" | "B" | "C" | null;
}

interface SportStat {
  sport: "nba" | "mlb" | "soccer";
  label: string;
  graded: number;
  wins: number;
  losses: number;
  win_rate: number | null;
  roi: number | null;
  avg_clv: number | null;
  positive_clv_pct: number | null;
}

interface PublicPerformanceResponse {
  // Headline aggregate stats across all sports
  total: {
    graded: number;
    wins: number;
    losses: number;
    win_rate: number | null;
    roi: number | null;
    avg_clv: number | null;
  };
  by_sport: SportStat[];
  // Last N graded picks across all sports for the public ledger
  recent: Pick[];
  // Also expose pending picks (with edge fields stripped) so the page
  // can show "X picks pending today" as a signal that the system is live
  pending_count: number;
  refreshed_at: string;
}

function readPerformance(dbDir: string, limit: number): PublicPerformanceResponse {
  // Single Python subprocess pulls + aggregates from all three sport DBs.
  // Keeps the TS side a pure render.
  const script = `
import json, os, sqlite3, sys

DB_DIR = ${JSON.stringify(dbDir)}
LIMIT  = ${limit}

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

def matchup(r):
    return f"{r['away_team']} @ {r['home_team']}"

picks = []

# ── NBA (signal_log has its own column shape — see PRAGMA table_info) ──
# Maps: signal_type → market, line_at_signal → line, bet_odds → book_odds,
# execution_source → book, covered → correct, clv_points → clv_pp.
# NBA doesn't track per-signal pinnacle_prob/edge_pp in this table (those
# live in model_performance.csv for the trained model); leave NULL here.
conn = open_conn("signal_log.db")
if conn and table_exists(conn, "signal_log"):
    for r in conn.execute(
        "SELECT game_id, game_date, home_team, away_team, "
        "       signal_type AS market, bet_side, line_at_signal AS line, "
        "       execution_source AS book, bet_odds AS book_odds, status, "
        "       covered AS correct, NULL AS edge_pp, "
        "       NULL AS pinnacle_prob, NULL AS prior_prob, "
        "       NULL AS clv_pp, NULL AS confidence_tier, "
        "       detected_at "
        "FROM signal_log "
        "WHERE status IN ('graded', 'open', 'proxy_captured') "
        "ORDER BY detected_at DESC LIMIT 500"
    ).fetchall():
        # NBA tracks clv_points (in spread units), not clv_pp (probability
        # units). Mixing them in a "CLV avg" column would lie. We expose
        # NBA's W/L for the unified record and leave CLV columns null —
        # soccer/MLB still surface clv_pp correctly.
        d = dict(r); d["sport"] = "nba"; d["tournament"] = "NBA"
        d["matchup"] = matchup(d)
        picks.append(d)
    conn.close()

# ── MLB ──
conn = open_conn("mlb_signal_log.db")
if conn and table_exists(conn, "mlb_signals"):
    for r in conn.execute(
        "SELECT game_id, game_date, home_team, away_team, market, bet_side, "
        "       line, book, book_odds, status, correct, edge_pp, "
        "       pinnacle_prob, NULL AS prior_prob, clv_pp, "
        "       confidence_tier, detected_at "
        "FROM mlb_signals ORDER BY detected_at DESC LIMIT 500"
    ).fetchall():
        d = dict(r); d["sport"] = "mlb"; d["tournament"] = "MLB"
        d["matchup"] = matchup(d)
        picks.append(d)
    conn.close()

# ── Soccer (all leagues + WC) ──
conn = open_conn("wc_signal_log.db")
if conn and table_exists(conn, "soccer_signals"):
    # Pull all columns including the tournament tag so the response can
    # show "this signal was on EPL" vs "WC group stage" etc.
    for r in conn.execute(
        "SELECT game_id, game_date, home_team, away_team, tournament, market, bet_side, "
        "       total_line AS line, book, book_odds, status, correct, edge_pp, "
        "       pinnacle_prob, prior_prob, clv_pp, confidence_tier, detected_at "
        "FROM soccer_signals ORDER BY detected_at DESC LIMIT 500"
    ).fetchall():
        d = dict(r); d["sport"] = "soccer"
        d["matchup"] = matchup(d)
        picks.append(d)
    conn.close()

# Sort across sports by detection time, newest first
picks.sort(key=lambda p: (p.get("detected_at") or ""), reverse=True)

graded = [p for p in picks if p["status"] in ("graded", "proxy_captured")]
pending = [p for p in picks if p["status"] == "open"]

def fmt_sport_stat(sport, label, sport_picks):
    sg = [p for p in sport_picks if p["status"] in ("graded", "proxy_captured")]
    wins   = sum(1 for p in sg if p.get("correct") == 1)
    losses = sum(1 for p in sg if p.get("correct") == 0)
    wr  = (wins / (wins + losses)) if (wins + losses) else None
    payout = 100/110
    roi = ((wins * payout + losses * -1) / (wins + losses)) if (wins + losses) else None
    clvs = [p["clv_pp"] for p in sg if p.get("clv_pp") is not None]
    avg_clv = (sum(clvs) / len(clvs)) if clvs else None
    pos_clv = (sum(1 for c in clvs if c > 0) / len(clvs)) if clvs else None
    return {
        "sport":  sport, "label": label,
        "graded": wins + losses, "wins": wins, "losses": losses,
        "win_rate":         round(wr,  4) if wr  is not None else None,
        "roi":              round(roi, 4) if roi is not None else None,
        "avg_clv":          round(avg_clv, 4) if avg_clv is not None else None,
        "positive_clv_pct": round(pos_clv, 4) if pos_clv is not None else None,
    }

by_sport = [
    fmt_sport_stat("nba",    "NBA",    [p for p in picks if p["sport"] == "nba"]),
    fmt_sport_stat("mlb",    "MLB",    [p for p in picks if p["sport"] == "mlb"]),
    fmt_sport_stat("soccer", "Soccer", [p for p in picks if p["sport"] == "soccer"]),
]

# Aggregate totals (note: ROI averaged at the pick level, not the sport level)
all_wins   = sum(1 for p in graded if p.get("correct") == 1)
all_losses = sum(1 for p in graded if p.get("correct") == 0)
all_clvs   = [p["clv_pp"] for p in graded if p.get("clv_pp") is not None]
payout = 100/110

total = {
    "graded":   all_wins + all_losses,
    "wins":     all_wins,
    "losses":   all_losses,
    "win_rate": round(all_wins / (all_wins + all_losses), 4) if (all_wins + all_losses) else None,
    "roi":      round((all_wins * payout + all_losses * -1) / (all_wins + all_losses), 4) if (all_wins + all_losses) else None,
    "avg_clv":  round(sum(all_clvs) / len(all_clvs), 4) if all_clvs else None,
}

# Attach pick explanations for soccer-table picks. The "why this pick"
# reasoning that uses our actual data (historical g/90, club form, intl
# uplift) — the differentiator that no other betting analytics tool has.
# Only soccer/WC explanations are wired right now; NBA + MLB can join later.
try:
    from ml.world_cup.pick_explainer import explain_signal
    soccer_picks = [p for p in picks if p["sport"] == "soccer"]
    if soccer_picks:
        # Build joinable historical/club data once per player_id we need
        from collections import defaultdict
        # We only join historical_form for player props (saves a DB roundtrip
        # per pick when explanations are mostly game-level)
        conn = open_conn("wc_signal_log.db")
        if conn:
            hist_by_player = defaultdict(list)
            try:
                player_names = {p.get("player_name") for p in soccer_picks if p.get("player_name")}
                if player_names:
                    placeholders = ",".join(["?"] * len(player_names))
                    for r in conn.execute(
                        f"SELECT * FROM wc_historical_form WHERE player_name IN ({placeholders})",
                        tuple(player_names),
                    ).fetchall():
                        hist_by_player[r["player_name"]].append(dict(r))
            except Exception:
                pass
            conn.close()
            for p in soccer_picks:
                try:
                    pname = p.get("player_name") or ""
                    explanation = explain_signal(
                        p,
                        historical_form=hist_by_player.get(pname) or None,
                    )
                    p["explanation"] = explanation
                except Exception:
                    p["explanation"] = None
except Exception:
    pass

print(json.dumps({
    "total":         total,
    "by_sport":      by_sport,
    "recent":        picks[:LIMIT],
    "pending_count": len(pending),
}))
`;
  const r = spawnSync("python3", ["-c", script], { encoding: "utf-8", timeout: 10_000 });
  try {
    const parsed = JSON.parse(r.stdout) as Omit<PublicPerformanceResponse, "refreshed_at">;
    return { ...parsed, refreshed_at: new Date().toISOString() };
  } catch {
    return {
      total: { graded: 0, wins: 0, losses: 0, win_rate: null, roi: null, avg_clv: null },
      by_sport: [],
      recent: [],
      pending_count: 0,
      refreshed_at: new Date().toISOString(),
    };
  }
}

function stripPendingEdgeFields(picks: Pick[], isAuthed: boolean): Pick[] {
  // Apply the same gating policy we built earlier: unauth users see
  // graded picks fully (proof of edge for marketing) but pending picks
  // have edge_pp / pinnacle_prob / prior_prob / clv_pp stripped so
  // non-subscribers can't read tonight's actionable bets for free.
  if (isAuthed) return picks;
  return picks.map((p) => {
    const isGraded = p.status === "graded" || p.status === "proxy_captured";
    if (isGraded) return p;
    return {
      ...p,
      edge_pp: null,
      pinnacle_prob: null,
      prior_prob: null,
      clv_pp: null,
    };
  });
}

export async function GET(req: NextRequest) {
  // Public endpoint — but if the user happens to be logged in, show full
  // data (no point hiding from existing subscribers). We do a soft auth
  // check via the existing NextAuth session.
  let isAuthed = false;
  try {
    const { auth } = await import("@/auth");
    const session = await auth();
    isAuthed = !!session?.user;
  } catch {
    // auth unavailable → treat as unauth
  }

  const limit = Math.min(100, Math.max(10, parseInt(req.nextUrl.searchParams.get("limit") || "30", 10) || 30));
  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
  const dbDir = path.join(appRoot, "ml", "nba_spread", "data");

  const data = readPerformance(dbDir, limit);
  data.recent = stripPendingEdgeFields(data.recent, isAuthed);

  return NextResponse.json(data);
}
