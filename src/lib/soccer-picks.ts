/**
 * Soccer picks loader for the subscriber dashboard.
 *
 * Returns a richer, market-agnostic view of open soccer signals than
 * fetchWCSignals (which is intentionally constrained to h2h home/away for
 * the per-game chip pipeline). This one returns every market — h2h, totals,
 * asian_handicap, player_goal_scorer_anytime — with the metadata the new
 * subscriber soccer panel needs: tournament label, book + book_odds,
 * confidence_tier, signal_id (so the UI can hit /api/picks/explain), plus
 * graded record + recent settlements.
 *
 * One subprocess, two queries (open + recent graded), assembled in TS.
 * Same DB_PATH discovery pattern as wc-signals.ts.
 */
import { spawnSync } from "child_process";
import path from "path";

export interface BookOffer {
  book: string;
  odds: number;
}

export interface SoccerPick {
  signal_id:        number;
  tournament:       string | null;
  game_id:          string;
  game_date:        string;
  detected_at:      string | null;
  home_team:        string;
  away_team:        string;
  market:           string;       // h2h | totals | asian_handicap | player_goal_scorer_anytime
  bet_side:         string;       // home | away | over | under | yes | no
  total_line:       number | null;
  player_name:      string | null;
  // Triggering soft-book — the book whose mispricing fired the signal
  book:             string | null;
  book_odds:        number | null;
  book_prob:        number | null;
  pinnacle_prob:    number | null;
  edge_pp:          number | null;
  prior_prob:       number | null;
  confidence_tier:  "A" | "B" | "C" | null;
  status:           string;       // open | graded
  correct:          number | null; // 1 win, 0 loss, null pending
  clv_pp:           number | null;
  // Multi-book transparency — snapshot at signal-time, sorted best-to-worst
  book_offers:      BookOffer[] | null;
  best_book:        string | null;
  best_book_odds:   number | null;
}

export interface SoccerPicksPayload {
  open:        SoccerPick[];
  recent:      SoccerPick[];   // last N graded
  record: {
    graded:    number;
    wins:      number;
    losses:    number;
    win_rate:  number | null;
    roi:       number | null;
    avg_clv:   number | null;
  };
  refreshed_at: string;
}

function dbPath(): string {
  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
  return path.join(appRoot, "ml", "nba_spread", "data", "wc_signal_log.db");
}

const EMPTY_PAYLOAD: SoccerPicksPayload = {
  open: [],
  recent: [],
  record: { graded: 0, wins: 0, losses: 0, win_rate: null, roi: null, avg_clv: null },
  refreshed_at: new Date().toISOString(),
};

export function fetchSoccerPicks(recentLimit = 10): SoccerPicksPayload {
  const dp = dbPath();
  const script = `
import json, os, sqlite3
RECENT_LIMIT = ${recentLimit}
try:
    if not os.path.exists(${JSON.stringify(dp)}):
        print(json.dumps({"open": [], "recent": [], "record": None})); raise SystemExit(0)
    conn = sqlite3.connect(${JSON.stringify(dp)})
    conn.row_factory = sqlite3.Row
    has_tbl = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='soccer_signals'"
    ).fetchone()
    if not has_tbl:
        print(json.dumps({"open": [], "recent": [], "record": None})); raise SystemExit(0)
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(soccer_signals)")}

    # Tolerate older schemas without player_name / tournament / prior_prob / clv_pp
    def col(name, alias=None, fallback="NULL"):
        a = alias or name
        return f"{name} AS {a}" if name in cols else f"{fallback} AS {a}"

    select_cols = ", ".join([
        "id AS signal_id",
        col("tournament"),
        "game_id",
        "game_date",
        col("detected_at"),
        "home_team",
        "away_team",
        "market",
        "bet_side",
        col("total_line"),
        col("player_name"),
        col("book"),
        col("book_odds"),
        col("book_prob"),
        col("pinnacle_prob"),
        col("edge_pp"),
        col("prior_prob"),
        col("confidence_tier"),
        "status",
        col("correct"),
        col("clv_pp"),
        col("book_offers"),
        col("best_book"),
        col("best_book_odds"),
    ])

    open_rows = [dict(r) for r in conn.execute(
        f"SELECT {select_cols} FROM soccer_signals WHERE status = 'open' "
        f"ORDER BY COALESCE(edge_pp, 0) DESC LIMIT 50"
    ).fetchall()]
    recent_rows = [dict(r) for r in conn.execute(
        f"SELECT {select_cols} FROM soccer_signals WHERE status = 'graded' "
        f"ORDER BY COALESCE(detected_at, game_date) DESC LIMIT ?",
        (RECENT_LIMIT,)
    ).fetchall()]

    # Record across all graded soccer signals (not just the recent slice)
    rec = conn.execute(
        "SELECT COUNT(*) AS graded, "
        "       SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END) AS wins, "
        "       SUM(CASE WHEN correct = 0 THEN 1 ELSE 0 END) AS losses, "
        "       AVG(clv_pp) AS avg_clv "
        "FROM soccer_signals WHERE status = 'graded'"
    ).fetchone() if "correct" in cols else None

    # ROI: profit-units / staked-units; only graded rows with odds + correct
    roi = None
    if "book_odds" in cols and "correct" in cols:
        rows = conn.execute(
            "SELECT book_odds, correct FROM soccer_signals "
            "WHERE status='graded' AND correct IS NOT NULL AND book_odds IS NOT NULL"
        ).fetchall()
        staked = 0.0; profit = 0.0
        for r in rows:
            odds = r["book_odds"]
            dec  = (odds/100.0 + 1.0) if odds > 0 else (100.0/abs(odds) + 1.0)
            staked += 1.0
            profit += (dec - 1.0) if r["correct"] == 1 else -1.0
        if staked > 0:
            roi = profit / staked

    record = None
    if rec is not None:
        graded = rec["graded"] or 0
        wins   = rec["wins"]   or 0
        losses = rec["losses"] or 0
        record = {
            "graded":   graded,
            "wins":     wins,
            "losses":   losses,
            "win_rate": (wins / graded) if graded > 0 else None,
            "roi":      roi,
            "avg_clv":  rec["avg_clv"],
        }

    conn.close()
    print(json.dumps({"open": open_rows, "recent": recent_rows, "record": record}))
except Exception as e:
    print(json.dumps({"open": [], "recent": [], "record": None, "error": str(e)[:200]}))
`;
  const res = spawnSync("python3", ["-c", script], { encoding: "utf-8", timeout: 4_000 });
  let parsed: { open?: unknown[]; recent?: unknown[]; record?: unknown } = {};
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return { ...EMPTY_PAYLOAD, refreshed_at: new Date().toISOString() };
  }

  const parseOffers = (raw: unknown): BookOffer[] | null => {
    if (!raw || typeof raw !== "string") return null;
    try {
      const v = JSON.parse(raw);
      if (!Array.isArray(v)) return null;
      return v.filter(
        (o): o is BookOffer =>
          typeof o === "object" && o !== null && typeof (o as BookOffer).book === "string"
      );
    } catch {
      return null;
    }
  };

  const map = (r: Record<string, unknown>): SoccerPick => ({
    signal_id:       Number(r.signal_id ?? 0),
    tournament:      (r.tournament as string | null) ?? null,
    game_id:         String(r.game_id ?? ""),
    game_date:       String(r.game_date ?? ""),
    detected_at:     (r.detected_at as string | null) ?? null,
    home_team:       String(r.home_team ?? ""),
    away_team:       String(r.away_team ?? ""),
    market:          String(r.market ?? ""),
    bet_side:        String(r.bet_side ?? ""),
    total_line:      (r.total_line as number | null) ?? null,
    player_name:     (r.player_name as string | null) ?? null,
    book:            (r.book as string | null) ?? null,
    book_odds:       (r.book_odds as number | null) ?? null,
    book_prob:       (r.book_prob as number | null) ?? null,
    pinnacle_prob:   (r.pinnacle_prob as number | null) ?? null,
    edge_pp:         (r.edge_pp as number | null) ?? null,
    prior_prob:      (r.prior_prob as number | null) ?? null,
    confidence_tier: (r.confidence_tier as "A" | "B" | "C" | null) ?? null,
    status:          String(r.status ?? "open"),
    correct:         (r.correct as number | null) ?? null,
    clv_pp:          (r.clv_pp as number | null) ?? null,
    book_offers:     parseOffers(r.book_offers),
    best_book:       (r.best_book as string | null) ?? null,
    best_book_odds:  (r.best_book_odds as number | null) ?? null,
  });

  const open   = Array.isArray(parsed.open)   ? (parsed.open   as Record<string, unknown>[]).map(map) : [];
  const recent = Array.isArray(parsed.recent) ? (parsed.recent as Record<string, unknown>[]).map(map) : [];
  const rec    = (parsed.record ?? null) as SoccerPicksPayload["record"] | null;

  return {
    open,
    recent,
    record: rec ?? EMPTY_PAYLOAD.record,
    refreshed_at: new Date().toISOString(),
  };
}
