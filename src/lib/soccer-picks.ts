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

// Edge floor — picks below this don't show; only model-flagged opportunities
// with meaningful confidence. Tunable.
const MIN_PICK_EDGE_PP = 0.05;

// Edge CEILING — any edge above this is treated as model over-extension
// (v1 model still has a tail of over-confidence on long-shots even after
// log-odds shrinkage). Backtest showed monotonicity broke down for very
// high model probabilities; we'd rather hide those than ship picks that
// burn subscriber trust. Lift this ceiling once xG / lineups / injuries
// are in the feature mix and calibration tightens.
const MAX_PICK_EDGE_PP = 0.15;

export function fetchSoccerPicks(recentLimit = 10): SoccerPicksPayload {
  const dp = dbPath();
  const script = `
import json, os, sqlite3
RECENT_LIMIT = ${recentLimit}
MIN_EDGE     = ${MIN_PICK_EDGE_PP}
MAX_EDGE     = ${MAX_PICK_EDGE_PP}

def empty():
    return {"open": [], "recent": [], "record": None}

try:
    if not os.path.exists(${JSON.stringify(dp)}):
        print(json.dumps(empty())); raise SystemExit(0)
    conn = sqlite3.connect(${JSON.stringify(dp)})
    conn.row_factory = sqlite3.Row

    def table_exists(name):
        return conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (name,)
        ).fetchone() is not None

    open_rows = []
    recent_rows = []

    # ── Game-level model picks (soccer_model_candidates) ──
    # Deduplication strategy: for each (game_id, market, bet_side, total_line)
    # combination, keep the row with the BEST book odds — that's the actionable
    # price subscribers should chase. Candidates table stores one row per book;
    # we collapse to one row per bet at the UI layer.
    if table_exists("soccer_model_candidates"):
        cand_open = conn.execute(
            """WITH ranked AS (
                 SELECT *,
                        ROW_NUMBER() OVER (
                            PARTITION BY game_id, market, bet_side,
                                         COALESCE(total_line, -999.0)
                            ORDER BY book_odds DESC, edge_pp DESC
                        ) AS rn
                 FROM soccer_model_candidates
                 WHERE graded_at IS NULL
                   AND edge_pp IS NOT NULL AND edge_pp >= ? AND edge_pp <= ?
                   AND status IN ('candidate','approved','exposed')
               )
               SELECT id, game_id, tournament, game_date, home_team, away_team,
                      detected_at, commence_time,
                      market, bet_side, total_line,
                      model_prob, book_prob, book_odds, book, edge_pp,
                      confidence_tier, status, correct, graded_at
               FROM ranked WHERE rn = 1
               ORDER BY edge_pp DESC LIMIT 30""",
            (MIN_EDGE, MAX_EDGE),
        ).fetchall()
        for r in cand_open:
            open_rows.append({
                "signal_id":       int(r["id"]),
                "tournament":      r["tournament"],
                "game_id":         r["game_id"],
                "game_date":       r["game_date"],
                "detected_at":     r["detected_at"],
                "home_team":       r["home_team"],
                "away_team":       r["away_team"],
                "market":          r["market"],
                "bet_side":        r["bet_side"],
                "total_line":      r["total_line"],
                "player_name":     None,
                "book":            r["book"],
                "book_odds":       r["book_odds"],
                "book_prob":       r["book_prob"],
                "pinnacle_prob":   r["model_prob"],   # our model is now the reference
                "edge_pp":         r["edge_pp"],
                "prior_prob":      None,
                "confidence_tier": r["confidence_tier"],
                "status":          "open",
                "correct":         None,
                "clv_pp":          None,
                "book_offers":     None,
                "best_book":       r["book"],
                "best_book_odds":  r["book_odds"],
            })
        # Recent graded model picks
        cand_graded = conn.execute(
            """SELECT id, game_id, tournament, game_date, home_team, away_team,
                      detected_at, commence_time,
                      market, bet_side, total_line,
                      model_prob, book_prob, book_odds, book, edge_pp,
                      confidence_tier, status, correct, graded_at
               FROM soccer_model_candidates
               WHERE graded_at IS NOT NULL AND correct IS NOT NULL
               ORDER BY graded_at DESC LIMIT ?""",
            (RECENT_LIMIT,),
        ).fetchall()
        for r in cand_graded:
            recent_rows.append({
                "signal_id":       int(r["id"]),
                "tournament":      r["tournament"],
                "game_id":         r["game_id"],
                "game_date":       r["game_date"],
                "detected_at":     r["detected_at"],
                "home_team":       r["home_team"],
                "away_team":       r["away_team"],
                "market":          r["market"],
                "bet_side":        r["bet_side"],
                "total_line":      r["total_line"],
                "player_name":     None,
                "book":            r["book"],
                "book_odds":       r["book_odds"],
                "book_prob":       r["book_prob"],
                "pinnacle_prob":   r["model_prob"],
                "edge_pp":         r["edge_pp"],
                "prior_prob":      None,
                "confidence_tier": r["confidence_tier"],
                "status":          "graded",
                "correct":         r["correct"],
                "clv_pp":          None,
                "book_offers":     None,
                "best_book":       r["book"],
                "best_book_odds":  r["book_odds"],
            })

    # ── Player-prop model picks (soccer_prop_cards) ──
    if table_exists("soccer_prop_cards"):
        prop_open = conn.execute(
            """SELECT id, game_id, tournament, home_team, away_team, commence_time,
                      team, opponent, player_name, market,
                      model_prob, book, book_odds, book_point, edge_pp,
                      decision, confidence_tier, status, result_hit
               FROM soccer_prop_cards
               WHERE result_hit IS NULL
                 AND decision IN ('pick','lean')
                 AND book_odds IS NOT NULL
               ORDER BY COALESCE(edge_pp, 0) DESC LIMIT 50"""
        ).fetchall()
        for r in prop_open:
            game_date = (r["commence_time"] or "")[:10] or None
            open_rows.append({
                "signal_id":       int(r["id"]) + 1_000_000,  # offset to avoid id clash with candidates
                "tournament":      r["tournament"],
                "game_id":         r["game_id"],
                "game_date":       game_date,
                "detected_at":     None,
                "home_team":       r["home_team"],
                "away_team":       r["away_team"],
                "market":          r["market"] or "player_prop",
                "bet_side":        "yes",   # prop cards are over/yes by default
                "total_line":      r["book_point"],
                "player_name":     r["player_name"],
                "book":            r["book"],
                "book_odds":       r["book_odds"],
                "book_prob":       None,
                "pinnacle_prob":   r["model_prob"],
                "edge_pp":         r["edge_pp"],
                "prior_prob":      r["model_prob"],
                "confidence_tier": r["confidence_tier"],
                "status":          "open",
                "correct":         None,
                "clv_pp":          None,
                "book_offers":     None,
                "best_book":       r["book"],
                "best_book_odds":  r["book_odds"],
            })

        # Recent graded prop picks
        prop_graded = conn.execute(
            """SELECT id, game_id, tournament, home_team, away_team, commence_time,
                      player_name, market, model_prob, book, book_odds, book_point,
                      edge_pp, confidence_tier, status, result_hit, graded_at
               FROM soccer_prop_cards
               WHERE result_hit IS NOT NULL AND graded_at IS NOT NULL
               ORDER BY graded_at DESC LIMIT ?""",
            (RECENT_LIMIT,),
        ).fetchall()
        for r in prop_graded:
            game_date = (r["commence_time"] or "")[:10] or None
            recent_rows.append({
                "signal_id":       int(r["id"]) + 1_000_000,
                "tournament":      r["tournament"],
                "game_id":         r["game_id"],
                "game_date":       game_date,
                "detected_at":     None,
                "home_team":       r["home_team"],
                "away_team":       r["away_team"],
                "market":          r["market"] or "player_prop",
                "bet_side":        "yes",
                "total_line":      r["book_point"],
                "player_name":     r["player_name"],
                "book":            r["book"],
                "book_odds":       r["book_odds"],
                "book_prob":       None,
                "pinnacle_prob":   r["model_prob"],
                "edge_pp":         r["edge_pp"],
                "prior_prob":      r["model_prob"],
                "confidence_tier": r["confidence_tier"],
                "status":          "graded",
                "correct":         r["result_hit"],
                "clv_pp":          None,
                "book_offers":     None,
                "best_book":       r["book"],
                "best_book_odds":  r["book_odds"],
            })

    # Cap each list at a sensible UI size
    open_rows = open_rows[:30]
    recent_rows = recent_rows[:RECENT_LIMIT]

    # ── Record across all graded model picks ──
    record = None
    if table_exists("soccer_model_candidates"):
        rows = conn.execute(
            """SELECT book_odds, correct FROM soccer_model_candidates
               WHERE correct IS NOT NULL"""
        ).fetchall()
        prop_rows = []
        if table_exists("soccer_prop_cards"):
            prop_rows = conn.execute(
                """SELECT book_odds, result_hit AS correct FROM soccer_prop_cards
                   WHERE result_hit IS NOT NULL AND book_odds IS NOT NULL"""
            ).fetchall()
        all_rows = list(rows) + list(prop_rows)
        if all_rows:
            wins = sum(1 for r in all_rows if r["correct"] == 1)
            losses = sum(1 for r in all_rows if r["correct"] == 0)
            graded = wins + losses
            staked, profit = 0.0, 0.0
            for r in all_rows:
                odds = r["book_odds"]
                if odds is None: continue
                dec = (odds/100.0 + 1.0) if odds > 0 else (100.0/abs(odds) + 1.0)
                staked += 1.0
                profit += (dec - 1.0) if r["correct"] == 1 else -1.0
            roi = (profit / staked) if staked > 0 else None
            record = {
                "graded":   graded,
                "wins":     wins,
                "losses":   losses,
                "win_rate": (wins / graded) if graded > 0 else None,
                "roi":      roi,
                "avg_clv":  None,
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
