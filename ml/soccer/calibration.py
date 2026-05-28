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
               close_over_odds, close_under_odds, close_ou_line,
               close_btts_yes_odds, close_btts_no_odds
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

    # BTTS bucket added in M31 — closing odds backfilled into soccer_team_form
    # via the form ingestor. Older rows in the DB may still have NULL btts
    # odds (no data in football-data CSVs for that vintage); those just get
    # dropped from the BTTS sample silently.
    out_buckets: Dict[str, Dict[str, Any]] = {
        "1X2_home":  {"residuals": [], "bets": []},
        "1X2_draw":  {"residuals": [], "bets": []},
        "1X2_away":  {"residuals": [], "bets": []},
        "totals_over":  {"residuals": [], "bets": []},
        "totals_under": {"residuals": [], "bets": []},
        "btts_yes":  {"residuals": [], "bets": []},
        "btts_no":   {"residuals": [], "bets": []},
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

                # BTTS implied — only when both odds are present (some
                # historical CSVs don't carry BTTS columns).
                btts_yes_odds  = m.get("close_btts_yes_odds")
                btts_no_odds   = m.get("close_btts_no_odds")
                imp_btts_yes   = _decimal_to_implied(float(btts_yes_odds)) if btts_yes_odds else None
                imp_btts_no    = _decimal_to_implied(float(btts_no_odds))  if btts_no_odds  else None

                bucket_specs = [
                    ("1X2_home",  model["p_home_win"], imp_home, "1x2", "home", float(m["close_home_odds"])),
                    ("1X2_draw",  model["p_draw"],     imp_draw, "1x2", "draw", float(m["close_draw_odds"])),
                    ("1X2_away",  model["p_away_win"], imp_away, "1x2", "away", float(m["close_away_odds"])),
                    ("totals_over",  model["p_over_25"],  imp_over,  "totals", "over",  float(m["close_over_odds"])),
                    ("totals_under", model["p_under_25"], imp_under, "totals", "under", float(m["close_under_odds"])),
                ]
                if imp_btts_yes is not None:
                    bucket_specs.append(
                        ("btts_yes", model["p_btts_yes"], imp_btts_yes, "btts", "yes", float(btts_yes_odds))
                    )
                if imp_btts_no is not None:
                    bucket_specs.append(
                        ("btts_no", model["p_btts_no"], imp_btts_no, "btts", "no", float(btts_no_odds))
                    )
                for bucket, model_prob, implied, market, side, dec_odds in bucket_specs:
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


def run_1x2_shrinkage_sweep(
    *,
    leagues: List[str],
    n_per_league: int = 100,
    edge_threshold_pp: float = 0.05,
    shrinkage_values: Optional[List[float]] = None,
    db_path: Optional[Path] = None,
) -> Dict[str, Any]:
    """M32 — sweep 1X2 shrinkage factors on a SHARED random sample.

    The single-shot run_calibration draws a fresh random sample on every
    invocation, so comparing across shrinkage values gets dominated by
    sample variance. This sweep samples ONCE, captures raw model
    probabilities (pre-shrinkage), then applies each shrinkage value in
    post-processing — apples-to-apples comparison.

    Returns a dict keyed by shrinkage factor; each entry has the same
    shape as the standard run_calibration bucket output but only for
    1X2_home/draw/away.
    """
    import math as _math
    from ml.soccer.model import _logit_shrink

    if shrinkage_values is None:
        shrinkage_values = [0.50, 0.55, 0.60, 0.65, 0.72, 0.80, 0.90, 1.00]

    from ml.world_cup.signal_logger import DB_PATH as DEFAULT_DB_PATH
    path = db_path or DEFAULT_DB_PATH
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row

    # Pass 1: gather a single fixed sample with raw probabilities.
    sample: List[Dict[str, Any]] = []
    try:
        for lg in leagues:
            for m in _sample_matches(conn, league=lg, n=n_per_league):
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
                        competition_stage="league",
                        before_date=str(m["match_date"]),
                    )
                except Exception:
                    continue
                if not intel or intel.get("error") or not intel.get("model"):
                    continue
                model = intel["model"]
                sample.append({
                    "match": m,
                    "p_home_raw": model["p_home_win_raw"],
                    "p_draw_raw": model["p_draw_raw"],
                    "p_away_raw": model["p_away_win_raw"],
                })
    finally:
        conn.close()

    if not sample:
        return {"error": "no sample collected"}

    # Pass 2: apply each shrinkage factor to the same sample.
    results: Dict[str, Any] = {
        "sample_size": len(sample),
        "edge_threshold_pp": edge_threshold_pp,
        "by_shrinkage": {},
    }
    for s_factor in shrinkage_values:
        bets = {"home": [], "draw": [], "away": []}
        residuals = {"home": [], "draw": [], "away": []}
        for entry in sample:
            m = entry["match"]
            # Apply log-odds shrinkage like _shrink_1x2 does internally.
            ph_s = _logit_shrink(entry["p_home_raw"], s_factor)
            pd_s = _logit_shrink(entry["p_draw_raw"], s_factor)
            pa_s = _logit_shrink(entry["p_away_raw"], s_factor)
            # Renormalize so probabilities sum to 1
            tot = ph_s + pd_s + pa_s
            if tot > 0:
                ph_s, pd_s, pa_s = ph_s/tot, pd_s/tot, pa_s/tot

            imp_home = _decimal_to_implied(float(m["close_home_odds"]))
            imp_draw = _decimal_to_implied(float(m["close_draw_odds"]))
            imp_away = _decimal_to_implied(float(m["close_away_odds"]))

            hs = int(m["home_score"])
            as_ = int(m["away_score"])

            for side_key, model_prob, implied, dec_odds in [
                ("home", ph_s, imp_home, float(m["close_home_odds"])),
                ("draw", pd_s, imp_draw, float(m["close_draw_odds"])),
                ("away", pa_s, imp_away, float(m["close_away_odds"])),
            ]:
                residuals[side_key].append(model_prob - implied)
                if (model_prob - implied) >= edge_threshold_pp:
                    outcome = _grade_outcome("1x2", side_key, hs, as_)
                    if outcome is None:
                        continue
                    if outcome == "won":
                        pnl = _decimal_to_units_won(dec_odds)
                    elif outcome == "lost":
                        pnl = -1.0
                    else:
                        pnl = 0.0
                    bets[side_key].append({"outcome": outcome, "pnl": pnl})

        per_side = {}
        for side_key in ("home", "draw", "away"):
            bs = bets[side_key]
            wins   = sum(1 for b in bs if b["outcome"] == "won")
            losses = sum(1 for b in bs if b["outcome"] == "lost")
            pnl    = sum(b["pnl"] for b in bs)
            n_bets = len(bs)
            roi = (pnl / n_bets) if n_bets else None
            mean_res = sum(residuals[side_key]) / len(residuals[side_key])
            per_side[side_key] = {
                "n_bets": n_bets,
                "wins":   wins,
                "losses": losses,
                "pnl_units": round(pnl, 2),
                "roi_per_bet": round(roi, 4) if roi is not None else None,
                "mean_residual_pp": round(mean_res * 100, 2),
            }
        results["by_shrinkage"][str(s_factor)] = per_side

    return results


def _format_sweep(s: Dict[str, Any]) -> str:
    lines = [f"1X2 shrinkage sweep — {s['sample_size']} matches, edge≥{s['edge_threshold_pp']*100:.1f}pp"]
    lines.append("")
    lines.append(f"{'shrink':>8} | {'home n':>6} {'home ROI':>10} | {'draw n':>6} {'draw ROI':>10} | {'away n':>6} {'away ROI':>10}")
    lines.append("─" * 100)
    for factor, per_side in s["by_shrinkage"].items():
        h = per_side["home"]
        d = per_side["draw"]
        a = per_side["away"]
        def fmt(roi):
            return f"{roi*100:+.1f}%" if roi is not None else "  —  "
        lines.append(
            f"{factor:>8} | "
            f"{h['n_bets']:>6} {fmt(h['roi_per_bet']):>10} | "
            f"{d['n_bets']:>6} {fmt(d['roi_per_bet']):>10} | "
            f"{a['n_bets']:>6} {fmt(a['roi_per_bet']):>10}"
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
    parser.add_argument(
        "--sweep-1x2", action="store_true",
        help="Run the M32 1X2 shrinkage sweep — sample once, apply each "
             "shrinkage value, compare ROI. Tells us the calibration sweet "
             "spot for 1X2 markets without fresh-sample variance.",
    )
    args = parser.parse_args()
    leagues = [l.strip() for l in args.leagues.split(",") if l.strip()]

    if args.sweep_1x2:
        sweep = run_1x2_shrinkage_sweep(
            leagues=leagues,
            n_per_league=args.n_per_league,
            edge_threshold_pp=args.edge_threshold_pp,
        )
        if args.format == "json":
            print(json.dumps(sweep, indent=2))
        else:
            print(_format_sweep(sweep))
        return

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
