#!/usr/bin/env python3
"""calibration.py — honest backtest of match_intelligence vs Pinnacle close.

Why this exists
===============
The user (rightly) asked: 'how do I know the model actually beats the
market?' Without a calibration check, every edge the trading-desk view
surfaces is taken on faith. The 22pp Over-2.5 edge we found on PSG vs
Arsenal was the canary — sharps would never leave that on the table at
Pinnacle. We added a competition-strength scaler that cut it to ~10pp,
but is even THAT real? Only a backtest tells us.

What it tests
=============
For a sample of historical Big-5 league matches with Pinnacle closing
odds attached, run ``intelligence_for_match()`` AS IF predicting that
match from before-only data, compute the model's market probabilities
for 1X2 / Totals 2.5 / BTTS, compare to Pinnacle close implied
probability, and look at:

  1. Mean residual (model_prob − implied_prob) per market.
     Close to 0 = model is well-calibrated vs Pinnacle on Big-5.
     Positive bias = model is too optimistic about that side.
  2. Edge-bucket hit rate: of model's "tier A" picks (≥5pp edge), did
     the predicted side actually win at the rate the model predicted?
  3. Hypothetical ROI: if we'd flat-bet every tier-A edge at the close,
     what would the unit P&L be? (Pinnacle close, after vig.)

Honest interpretation
=====================
This is a Big-5 LEAGUE PLAY backtest. It does NOT directly validate the
competition-strength scaler (COMPETITION_FACTORS) for UCL knockouts —
we don't have historical UCL closing odds in our DB. What it tells us:
if our core cross-league math is well-calibrated on league play, then
the UCL factor (0.81) is the one tunable knob that recalibrates for
tighter-defense knockouts. If the core math has bias on league play,
the UCL factor inherits and compounds that bias.

Run via CLI:
  python3 -m ml.soccer.calibration --n-per-league 50 --leagues "Premier League,La Liga,Ligue 1"
"""
from __future__ import annotations

import math
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from ml.soccer.match_intelligence import intelligence_for_match
from ml.soccer.prop_cards import _american_to_implied_prob


def _decimal_to_implied(decimal_odds: float) -> float:
    if decimal_odds <= 1.0:
        return 1.0
    return 1.0 / decimal_odds


def _sample_matches(
    conn: sqlite3.Connection,
    *,
    league: str,
    n: int,
    min_date: str = "2024-01-01",
    max_date: str = "2026-05-01",
) -> List[Dict[str, Any]]:
    """Pull n random matches from the league with full closing odds.

    Filters to home-side rows only so each match appears once. Requires
    close_home_odds, close_away_odds, close_draw_odds, close_over_odds,
    close_under_odds, close_ou_line all populated AND a final result.
    """
    rows = conn.execute(
        """
        SELECT team_name AS home, opponent AS away, match_date, league,
               goals_for AS home_score, goals_against AS away_score,
               close_home_odds, close_draw_odds, close_away_odds,
               close_over_odds, close_under_odds, close_ou_line
          FROM soccer_team_form
         WHERE league = ?
           AND venue = 'home'
           AND match_date >= ?
           AND match_date <= ?
           AND close_home_odds IS NOT NULL
           AND close_draw_odds IS NOT NULL
           AND close_away_odds IS NOT NULL
           AND close_over_odds IS NOT NULL
           AND close_under_odds IS NOT NULL
           AND goals_for IS NOT NULL
           AND goals_against IS NOT NULL
         ORDER BY RANDOM()
         LIMIT ?
        """,
        (league, min_date, max_date, n),
    ).fetchall()
    return [dict(r) for r in rows]


def _grade_outcome(market: str, side: str, hs: int, as_: int, ou_line: float = 2.5) -> Optional[str]:
    """'won' / 'lost' / 'push' for a market+side given final score."""
    s = side.lower()
    m = market.lower()
    total = hs + as_
    if m == "1x2":
        winner = "home" if hs > as_ else "away" if as_ > hs else "draw"
        return "won" if s == winner else "lost"
    if m == "totals":
        if total > ou_line:
            return "won" if s == "over" else "lost"
        if total < ou_line:
            return "won" if s == "under" else "lost"
        return "push"
    if m == "btts":
        both = hs >= 1 and as_ >= 1
        if s == "yes":  return "won" if both else "lost"
        if s == "no":   return "won" if not both else "lost"
    return None


def _decimal_to_units_won(decimal_odds: float) -> float:
    return float(decimal_odds) - 1.0


# ── Public entry point ──────────────────────────────────────────────────────

def run_calibration(
    *,
    leagues: List[str],
    n_per_league: int = 50,
    edge_threshold_pp: float = 0.05,
    db_path: Optional[Path] = None,
) -> Dict[str, Any]:
    """Run the full Big-5 calibration backtest. Returns a structured dict
    suitable for printing or storing.

    For each sampled match we compute model probabilities using only
    Understat data dated BEFORE the match (no leakage), grade against
    the actual final score, and aggregate.

    Edge threshold of 5pp matches our default tier-A cutoff for game-level
    markets; lower it to widen the sample.
    """
    from ml.world_cup.signal_logger import DB_PATH as DEFAULT_DB_PATH
    path = db_path or DEFAULT_DB_PATH
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row

    # NOTE: BTTS backtest is intentionally NOT included. football-data.co.uk
    # closing-odds extracts in soccer_team_form don't carry BTTS Yes/No
    # closing prices, so we have no Pinnacle benchmark to grade against.
    # Extending requires adding BbAvBTSY / BbAvBTSN to the form ingestor —
    # tracked as a follow-up. For now BTTS picks surface in the UI with an
    # explicit "untested" badge so the trader doesn't bet from unvalidated
    # output.
    out_buckets: Dict[str, Dict[str, Any]] = {
        "1X2_home":  {"residuals": [], "bets": []},
        "1X2_draw":  {"residuals": [], "bets": []},
        "1X2_away":  {"residuals": [], "bets": []},
        "totals_over":  {"residuals": [], "bets": []},
        "totals_under": {"residuals": [], "bets": []},
    }
    matches_predicted = 0
    matches_skipped = 0
    league_summary: Dict[str, int] = {}

    try:
        for lg in leagues:
            sampled = _sample_matches(conn, league=lg, n=n_per_league)
            league_summary[lg] = 0
            for m in sampled:
                # Predict using only data strictly before this match
                try:
                    intel = intelligence_for_match(
                        home_team=m["home"],
                        away_team=m["away"],
                        tournament=m["league"],
                        home_league=m["league"],
                        away_league=m["league"],
                        commence_time=None,
                        game_id=None,
                        neutral_venue=False,
                        competition_stage="league",  # league play
                        before_date=str(m["match_date"]),
                    )
                except Exception:
                    matches_skipped += 1
                    continue
                if not intel or intel.get("error") or not intel.get("model"):
                    matches_skipped += 1
                    continue
                model = intel["model"]
                matches_predicted += 1
                league_summary[lg] += 1

                # Pinnacle implied probabilities (decimal_odds → implied).
                # These already include the vig — we keep raw implied for
                # honesty; the residual to true-prob is what matters.
                imp_home = _decimal_to_implied(float(m["close_home_odds"]))
                imp_draw = _decimal_to_implied(float(m["close_draw_odds"]))
                imp_away = _decimal_to_implied(float(m["close_away_odds"]))
                imp_over = _decimal_to_implied(float(m["close_over_odds"]))
                imp_under = _decimal_to_implied(float(m["close_under_odds"]))
                ou_line = float(m.get("close_ou_line") or 2.5)

                hs = int(m["home_score"])
                as_ = int(m["away_score"])

                for bucket, model_prob, implied, market, side, dec_odds in [
                    ("1X2_home",  model["p_home_win"], imp_home, "1x2", "home", float(m["close_home_odds"])),
                    ("1X2_draw",  model["p_draw"],     imp_draw, "1x2", "draw", float(m["close_draw_odds"])),
                    ("1X2_away",  model["p_away_win"], imp_away, "1x2", "away", float(m["close_away_odds"])),
                    ("totals_over",  model["p_over_25"],  imp_over,  "totals", "over",  float(m["close_over_odds"])),
                    ("totals_under", model["p_under_25"], imp_under, "totals", "under", float(m["close_under_odds"])),
                ]:
                    residual = model_prob - implied
                    out_buckets[bucket]["residuals"].append(residual)
                    # Only "bet" when model gives positive edge above the threshold
                    if residual >= edge_threshold_pp:
                        outcome = _grade_outcome(market, side, hs, as_, ou_line=ou_line)
                        if outcome is None:
                            continue
                        # P&L per 1 unit stake
                        if outcome == "won":
                            pnl = _decimal_to_units_won(dec_odds)
                        elif outcome == "lost":
                            pnl = -1.0
                        else:
                            pnl = 0.0
                        out_buckets[bucket]["bets"].append({
                            "model_prob": model_prob,
                            "implied_prob": implied,
                            "edge_pp": residual,
                            "outcome": outcome,
                            "pnl_units": pnl,
                            "decimal_odds": dec_odds,
                        })
    finally:
        conn.close()

    # Aggregate
    summary: Dict[str, Any] = {
        "matches_predicted": matches_predicted,
        "matches_skipped":   matches_skipped,
        "leagues":           league_summary,
        "edge_threshold_pp": edge_threshold_pp,
        "buckets":           {},
    }
    for bucket, data in out_buckets.items():
        residuals = data["residuals"]
        bets = data["bets"]
        n_bets = len(bets)
        wins = sum(1 for b in bets if b["outcome"] == "won")
        losses = sum(1 for b in bets if b["outcome"] == "lost")
        pushes = sum(1 for b in bets if b["outcome"] == "push")
        pnl = sum(b["pnl_units"] for b in bets)
        avg_edge = sum(b["edge_pp"] for b in bets) / n_bets if n_bets else None
        win_rate = wins / (wins + losses) if (wins + losses) else None
        # Model's predicted win rate on these bets (averaged model_prob)
        avg_predicted = sum(b["model_prob"] for b in bets) / n_bets if n_bets else None
        roi = pnl / n_bets if n_bets else None
        mean_res = sum(residuals) / len(residuals) if residuals else None
        summary["buckets"][bucket] = {
            "n_predictions": len(residuals),
            "mean_residual_pp": round(mean_res * 100, 2) if mean_res is not None else None,
            "n_bets":   n_bets,
            "wins":     wins,
            "losses":   losses,
            "pushes":   pushes,
            "win_rate": round(win_rate, 4) if win_rate is not None else None,
            "model_predicted_win_rate": round(avg_predicted, 4) if avg_predicted is not None else None,
            "avg_edge_taken_pp": round(avg_edge * 100, 2) if avg_edge is not None else None,
            "pnl_units": round(pnl, 2),
            "roi_per_bet": round(roi, 4) if roi is not None else None,
        }
    return summary


def _format_summary(s: Dict[str, Any]) -> str:
    lines = [
        f"Calibration backtest — {s['matches_predicted']} matches predicted, "
        f"{s['matches_skipped']} skipped (insufficient data).",
        f"Leagues: {', '.join(f'{k}={v}' for k, v in s['leagues'].items())}",
        f"Edge threshold for 'bet': {s['edge_threshold_pp']*100:.1f}pp",
        "",
        f"{'bucket':<20} {'n':>5} {'mean_res':>9} | {'n_bets':>7} {'win%':>6} "
        f"{'pred%':>6} {'edge_pp':>8} {'pnl_u':>7} {'roi':>7}",
        "─" * 90,
    ]
    for bucket, b in s["buckets"].items():
        win_rate = f"{b['win_rate']*100:.1f}%" if b['win_rate'] is not None else "  —  "
        pred = f"{b['model_predicted_win_rate']*100:.1f}%" if b['model_predicted_win_rate'] is not None else "  —  "
        mean_r = f"{b['mean_residual_pp']:+.2f}pp" if b['mean_residual_pp'] is not None else "  —  "
        edge = f"{b['avg_edge_taken_pp']:+.2f}pp" if b['avg_edge_taken_pp'] is not None else "  —  "
        roi = f"{b['roi_per_bet']*100:+.1f}%" if b['roi_per_bet'] is not None else "  —  "
        lines.append(
            f"{bucket:<20} {b['n_predictions']:>5} {mean_r:>9} | "
            f"{b['n_bets']:>7} {win_rate:>6} {pred:>6} {edge:>8} "
            f"{b['pnl_units']:>+7.2f} {roi:>7}"
        )
    return "\n".join(lines)


def main() -> None:
    import argparse
    import json
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument(
        "--leagues", default="Premier League,La Liga,Ligue 1,Bundesliga,Serie A",
        help="Comma-separated league names to sample from",
    )
    parser.add_argument("--n-per-league", type=int, default=50)
    parser.add_argument("--edge-threshold-pp", type=float, default=0.05,
                        help="Decimal — 0.05 = 5pp edge threshold for 'bet'")
    parser.add_argument("--format", choices=["table", "json"], default="table")
    args = parser.parse_args()
    leagues = [l.strip() for l in args.leagues.split(",") if l.strip()]
    summary = run_calibration(
        leagues=leagues,
        n_per_league=args.n_per_league,
        edge_threshold_pp=args.edge_threshold_pp,
    )
    if args.format == "json":
        print(json.dumps(summary, indent=2))
    else:
        print(_format_summary(summary))


if __name__ == "__main__":
    main()
