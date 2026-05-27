"""
Held-out backtest for the soccer v1 model.

Methodology:
  - Sort matches chronologically per league
  - Split: oldest 80% → training, newest 20% → holdout
  - Fit Dixon-Coles + Elo on training set only (reference_date = split boundary,
    so recency weighting treats the boundary as "now")
  - Predict every holdout match using the trained model
  - Compare predictions to actual outcomes — measure calibration, log-loss,
    Brier, simulated ROI vs historical closing odds, hit rate by edge bucket

Metrics produced:
  - Calibration curve: when we say P%, do outcomes hit P% of the time?
    Bucketed (0-10%, 10-20%, ..., 90-100%)
  - Log-loss vs uniform baseline (33/33/33 for 1X2)
  - Brier score
  - Simulated ROI at historical closing odds for picks above edge threshold
  - Hit rate by edge bucket (5-7pp, 7-10pp, 10pp+)
  - Per-market breakdown (h2h, totals)

The closing-odds backtest is conservative. In real life we bet pre-move,
not at close. Beating closing-line is the hardest benchmark.

Usage:
    python3 -m ml.soccer.backtest run             # Run full backtest
    python3 -m ml.soccer.backtest report          # Print last results
"""
from __future__ import annotations

import json
import math
import sqlite3
import sys
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

from .model import (
    DCFit, LEAGUES_TO_FIT, get_db,
    fit_dixon_coles, predict_match, MODEL_DIR,
)


# ── Settings ─────────────────────────────────────────────────────────────────

HOLDOUT_FRAC      = 0.20      # last 20% of matches per league go in holdout
EDGE_THRESHOLDS   = [0.03, 0.05, 0.07, 0.10]  # buckets for hit-rate analysis
CALIBRATION_BUCKETS = [
    (0.00, 0.10), (0.10, 0.20), (0.20, 0.30), (0.30, 0.40), (0.40, 0.50),
    (0.50, 0.60), (0.60, 0.70), (0.70, 0.80), (0.80, 0.90), (0.90, 1.00),
]


# ── Helpers ──────────────────────────────────────────────────────────────────

def _holdout_split(
    league: str, conn: sqlite3.Connection,
    holdout_frac: float = HOLDOUT_FRAC,
) -> Tuple[str, List[Dict[str, Any]]]:
    """Return (split_date, holdout_matches). split_date is the cutoff —
    fit on everything strictly BEFORE this date, predict everything on or after.
    """
    rows = conn.execute(
        """
        SELECT match_date, team_name AS home, opponent AS away,
               goals_for AS gh, goals_against AS ga,
               close_home_odds, close_draw_odds, close_away_odds,
               close_ou_line, close_over_odds, close_under_odds,
               referee
        FROM soccer_team_form
        WHERE league = ? AND venue = 'home'
              AND goals_for IS NOT NULL AND goals_against IS NOT NULL
        ORDER BY match_date ASC
        """,
        (league,),
    ).fetchall()
    if not rows:
        return ("9999-01-01", [])
    n_total   = len(rows)
    n_holdout = int(n_total * holdout_frac)
    split_idx = n_total - n_holdout
    split_date = rows[split_idx]["match_date"]
    holdout = [dict(r) for r in rows[split_idx:]]
    return split_date, holdout


def _devig_three_way(odds_h: float, odds_d: float, odds_a: float) -> Optional[Tuple[float, float, float]]:
    """De-vig decimal odds to true probabilities (sum to 1)."""
    if not all([odds_h, odds_d, odds_a]):
        return None
    raw = [1.0 / odds_h, 1.0 / odds_d, 1.0 / odds_a]
    s = sum(raw)
    if s <= 0:
        return None
    return (raw[0] / s, raw[1] / s, raw[2] / s)


def _devig_two_way(odds_o: float, odds_u: float) -> Optional[Tuple[float, float]]:
    if not all([odds_o, odds_u]):
        return None
    raw = [1.0 / odds_o, 1.0 / odds_u]
    s = sum(raw)
    if s <= 0:
        return None
    return (raw[0] / s, raw[1] / s)


def _safe_log(p: float) -> float:
    return math.log(max(p, 1e-12))


# ── Backtest core ────────────────────────────────────────────────────────────

@dataclass
class HoldoutOutcome:
    """One row per (holdout_match × market × side) prediction we evaluated."""
    league:      str
    date:        str
    home:        str
    away:        str
    market:      str         # "h2h_home" | "h2h_draw" | "h2h_away" | "over_2.5" | "under_2.5"
    model_prob:  float
    book_prob:   float       # de-vigged book closing prob
    book_odds:   float       # decimal odds at close
    outcome:     int         # 1 if won, 0 if lost
    edge_pp:     float       # model_prob - book_prob


def _evaluate_match(
    league: str, fit: DCFit, conn: sqlite3.Connection, m: Dict[str, Any],
) -> List[HoldoutOutcome]:
    """Predict + evaluate a single holdout match across all markets."""
    pred = predict_match(
        fit, m["home"], m["away"],
        league=league, referee=m.get("referee"),
        apply_adjustments=True, conn=conn,
        before_date=m["match_date"],  # NO LEAKAGE: adjustments only see prior matches
    )
    if pred is None:
        return []

    out: List[HoldoutOutcome] = []
    gh, ga = int(m["gh"]), int(m["ga"])

    # ── 1X2 ──
    book = _devig_three_way(
        m["close_home_odds"], m["close_draw_odds"], m["close_away_odds"],
    )
    if book is not None:
        actual_h = 1 if gh > ga else 0
        actual_d = 1 if gh == ga else 0
        actual_a = 1 if gh < ga else 0
        for label, model_p, book_p, book_o, actual in [
            ("h2h_home", pred["p_home"], book[0], m["close_home_odds"], actual_h),
            ("h2h_draw", pred["p_draw"], book[1], m["close_draw_odds"], actual_d),
            ("h2h_away", pred["p_away"], book[2], m["close_away_odds"], actual_a),
        ]:
            out.append(HoldoutOutcome(
                league=league, date=m["match_date"], home=m["home"], away=m["away"],
                market=label, model_prob=model_p, book_prob=book_p,
                book_odds=float(book_o), outcome=actual,
                edge_pp=model_p - book_p,
            ))

    # ── Totals 2.5 ──
    # football-data exposes dedicated O/U 2.5 odds columns. Older local DB rows
    # may have close_ou_line polluted with AvgC>2.5 (an odds value), so the
    # reliable signal here is the presence of close_over/close_under odds.
    book_tot = _devig_two_way(m["close_over_odds"], m["close_under_odds"])
    if book_tot is not None:
        total = gh + ga
        actual_over  = 1 if total > 2.5 else 0
        actual_under = 1 if total < 2.5 else 0
        for label, model_p, book_p, book_o, actual in [
            ("over_2.5",  pred["over_2.5"],  book_tot[0], m["close_over_odds"],  actual_over),
            ("under_2.5", pred["under_2.5"], book_tot[1], m["close_under_odds"], actual_under),
        ]:
            out.append(HoldoutOutcome(
                league=league, date=m["match_date"], home=m["home"], away=m["away"],
                market=label, model_prob=model_p, book_prob=book_p,
                book_odds=float(book_o), outcome=actual,
                edge_pp=model_p - book_p,
            ))

    return out


# ── Metrics ──────────────────────────────────────────────────────────────────

def _calibration(outcomes: List[HoldoutOutcome]) -> List[Dict[str, Any]]:
    """For each probability bucket, return (n, predicted_avg, actual_rate)."""
    out = []
    for lo, hi in CALIBRATION_BUCKETS:
        rows = [r for r in outcomes if lo <= r.model_prob < hi]
        if not rows:
            out.append({"bucket": f"{int(lo*100)}-{int(hi*100)}%",
                        "n": 0, "predicted": None, "actual": None,
                        "miss_pp": None})
            continue
        predicted = sum(r.model_prob for r in rows) / len(rows)
        actual    = sum(r.outcome   for r in rows) / len(rows)
        out.append({
            "bucket":    f"{int(lo*100)}-{int(hi*100)}%",
            "n":         len(rows),
            "predicted": round(predicted, 4),
            "actual":    round(actual, 4),
            "miss_pp":   round((actual - predicted) * 100, 2),
        })
    return out


def _log_loss(outcomes: List[HoldoutOutcome]) -> float:
    """Average negative log-likelihood per outcome."""
    if not outcomes:
        return 0.0
    total = 0.0
    for r in outcomes:
        p = r.model_prob if r.outcome == 1 else (1.0 - r.model_prob)
        total += -_safe_log(p)
    return total / len(outcomes)


def _brier_score(outcomes: List[HoldoutOutcome]) -> float:
    """Mean squared error between model_prob and actual outcome."""
    if not outcomes:
        return 0.0
    return sum((r.model_prob - r.outcome) ** 2 for r in outcomes) / len(outcomes)


def _baseline_log_loss(outcomes: List[HoldoutOutcome]) -> float:
    """Constant-baseline log-loss: predict the empirical base rate for each
    market label. Gives us "what does dumb get?" comparison."""
    if not outcomes:
        return 0.0
    by_market: Dict[str, List[int]] = {}
    for r in outcomes:
        by_market.setdefault(r.market, []).append(r.outcome)
    market_base = {m: sum(v) / len(v) if v else 0.0 for m, v in by_market.items()}
    total = 0.0
    for r in outcomes:
        p_base = market_base[r.market]
        p = p_base if r.outcome == 1 else (1.0 - p_base)
        total += -_safe_log(p)
    return total / len(outcomes)


def _simulated_roi(
    outcomes: List[HoldoutOutcome], edge_threshold: float,
) -> Dict[str, Any]:
    """If we bet a flat 1 unit on every pick with model_prob - book_prob ≥
    edge_threshold, at the closing odds, what's the ROI?"""
    bets = [r for r in outcomes if r.edge_pp >= edge_threshold]
    if not bets:
        return {"n_bets": 0, "roi": None, "wins": 0, "losses": 0,
                "total_staked": 0, "total_return": 0}
    wins = sum(1 for r in bets if r.outcome == 1)
    losses = len(bets) - wins
    # Each bet: stake 1 unit. Win = (odds - 1) profit. Loss = -1 loss.
    total_return = sum((r.book_odds - 1.0) for r in bets if r.outcome == 1) \
                 - sum(1.0 for r in bets if r.outcome == 0)
    total_staked = float(len(bets))
    return {
        "n_bets":       len(bets),
        "wins":         wins,
        "losses":       losses,
        "win_rate":     round(wins / len(bets), 4),
        "total_staked": round(total_staked, 2),
        "total_return": round(total_return, 2),
        "roi":          round(total_return / total_staked, 4),
    }




def _market_breakdown(outcomes: List[HoldoutOutcome]) -> Dict[str, Dict[str, Any]]:
    """Per-market metrics so the report cannot accidentally imply totals were
    evaluated when only 1X2 rows made it through. Groups exact labels.
    """
    markets = sorted({r.market for r in outcomes})
    out: Dict[str, Dict[str, Any]] = {}
    for market in markets:
        rows = [r for r in outcomes if r.market == market]
        out[market] = {
            "n": len(rows),
            "avg_model_prob": round(sum(r.model_prob for r in rows) / len(rows), 4) if rows else None,
            "actual_rate": round(sum(r.outcome for r in rows) / len(rows), 4) if rows else None,
            "log_loss": round(_log_loss(rows), 4),
            "brier": round(_brier_score(rows), 4),
            "roi_5pp": _simulated_roi(rows, 0.05),
        }
    return out

def _hit_rate_by_edge_bucket(outcomes: List[HoldoutOutcome]) -> List[Dict[str, Any]]:
    """How well do higher-edge picks perform vs lower-edge? Tests the
    monotonicity assumption (higher edge → higher hit rate)."""
    buckets = [
        ("0-3pp",   0.00, 0.03),
        ("3-5pp",   0.03, 0.05),
        ("5-7pp",   0.05, 0.07),
        ("7-10pp",  0.07, 0.10),
        ("10pp+",   0.10, 1.00),
    ]
    out = []
    for name, lo, hi in buckets:
        rows = [r for r in outcomes if lo <= r.edge_pp < hi]
        if not rows:
            out.append({"bucket": name, "n": 0, "hit_rate": None,
                        "avg_model_prob": None, "avg_book_prob": None})
            continue
        out.append({
            "bucket":          name,
            "n":               len(rows),
            "hit_rate":        round(sum(r.outcome for r in rows) / len(rows), 4),
            "avg_model_prob":  round(sum(r.model_prob for r in rows) / len(rows), 4),
            "avg_book_prob":   round(sum(r.book_prob for r in rows) / len(rows), 4),
        })
    return out


# ── Orchestration ────────────────────────────────────────────────────────────

def run_backtest() -> Dict[str, Any]:
    """Run the full held-out backtest across all leagues. Returns summary."""
    conn = get_db()
    summary: Dict[str, Any] = {
        "config":         {"holdout_frac": HOLDOUT_FRAC,
                           "edge_thresholds": EDGE_THRESHOLDS},
        "ran_at":         datetime.now(timezone.utc).isoformat(),
        "per_league":     {},
        "overall":        {},
    }
    all_outcomes: List[HoldoutOutcome] = []

    for league in LEAGUES_TO_FIT:
        print(f"\n── Backtest: {league} ──", flush=True)
        split_date, holdout = _holdout_split(league, conn)
        if len(holdout) < 50:
            print(f"  Insufficient holdout ({len(holdout)} matches), skipping", flush=True)
            continue

        print(f"  Train: matches BEFORE {split_date}", flush=True)
        print(f"  Holdout: {len(holdout)} matches FROM {split_date}", flush=True)

        # Fit on training subset ONLY — train_before enforces a hard cutoff
        # in the DB query, preventing holdout matches from leaking into fit.
        fit = fit_dixon_coles(
            league, conn,
            reference_date=split_date,
            train_before=split_date,  # NO LEAKAGE: holdout matches excluded
        )
        if fit is None:
            print("  Fit failed, skipping", flush=True)
            continue

        league_outcomes: List[HoldoutOutcome] = []
        for m in holdout:
            league_outcomes.extend(_evaluate_match(league, fit, conn, m))
        all_outcomes.extend(league_outcomes)

        print(f"  Predictions evaluated: {len(league_outcomes)} (markets × sides)", flush=True)

        summary["per_league"][league] = {
            "split_date":     split_date,
            "holdout_matches": len(holdout),
            "predictions":    len(league_outcomes),
            "calibration":    _calibration(league_outcomes),
            "log_loss":       round(_log_loss(league_outcomes), 4),
            "baseline_ll":    round(_baseline_log_loss(league_outcomes), 4),
            "brier":          round(_brier_score(league_outcomes), 4),
            "roi_by_thr":     {
                f"≥{int(t*100)}pp": _simulated_roi(league_outcomes, t)
                for t in EDGE_THRESHOLDS
            },
            "hit_rate_by_edge": _hit_rate_by_edge_bucket(league_outcomes),
            "market_breakdown": _market_breakdown(league_outcomes),
        }

    # ── Overall (cross-league) ──
    if all_outcomes:
        summary["overall"] = {
            "predictions":    len(all_outcomes),
            "calibration":    _calibration(all_outcomes),
            "log_loss":       round(_log_loss(all_outcomes), 4),
            "baseline_ll":    round(_baseline_log_loss(all_outcomes), 4),
            "brier":          round(_brier_score(all_outcomes), 4),
            "roi_by_thr":     {
                f"≥{int(t*100)}pp": _simulated_roi(all_outcomes, t)
                for t in EDGE_THRESHOLDS
            },
            "hit_rate_by_edge": _hit_rate_by_edge_bucket(all_outcomes),
            "market_breakdown": _market_breakdown(all_outcomes),
        }

    conn.close()

    # Persist artifact
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    out_path = MODEL_DIR / "backtest_v1.json"
    out_path.write_text(json.dumps(summary, indent=2))
    print(f"\n  Wrote {out_path}", flush=True)
    return summary


def load_last_backtest() -> Optional[Dict[str, Any]]:
    p = MODEL_DIR / "backtest_v1.json"
    if not p.exists():
        return None
    return json.loads(p.read_text())


# ── CLI ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"
    if cmd == "run":
        s = run_backtest()
        # Show high-level numbers
        print("\n\n========= BACKTEST SUMMARY =========")
        ov = s.get("overall", {})
        print(f"Predictions evaluated: {ov.get('predictions', 0)}")
        print(f"Log-loss:    model={ov.get('log_loss')}  baseline={ov.get('baseline_ll')}")
        print(f"Brier score: {ov.get('brier')}")
        for thr, r in (ov.get("roi_by_thr") or {}).items():
            if r and r.get("n_bets"):
                print(f"  Edge {thr}: {r['n_bets']:4d} bets, "
                      f"{r['win_rate']*100:.1f}% win rate, "
                      f"ROI {r['roi']*100:+.2f}%")
    elif cmd == "report":
        s = load_last_backtest()
        if s:
            print(json.dumps(s, indent=2))
        else:
            print("No backtest run yet.", file=sys.stderr); sys.exit(1)
    else:
        print("usage: python3 -m ml.soccer.backtest [run|report]", file=sys.stderr)
        sys.exit(1)
