#!/usr/bin/env python3
"""match_intelligence.py — full ACE trading-desk picture for a single fixture.

What this module is for
=======================
Bob's direction (May 2026): ACE is no longer an "arb against Pinnacle" tool.
We want to:
  1. Build our own pre-odds opinion across every market we have signal for
     (1X2, totals 2.5, BTTS — corners/SoT/etc. coming in follow-up waves).
  2. THEN compare to the books and surface where the market disagrees with
     our model enough to bet.
  3. Show the rationale — drivers, lineup status, data coverage — so the
     bettor can decide whether to trust the read.

The candidate scanner already does this for Big-5 league matches because
each league has a Dixon-Coles fit. UCL finals, cross-league friendlies,
and (eventually) World Cup matches don't have a single league-fit they
belong to. This module fills that gap by computing fair probabilities
directly from Understat xG data — works for any match where both teams
have ≥6 Understat rows in soccer_source_team_match_stats.

Algorithm (single match)
========================
  1. For each team, pull recent Understat rows (last N matches).
     - xg_for_pg, xg_against_pg, goals_for_pg, goals_against_pg
  2. Cross-league λ (no DC league fit assumed):
       λ_home = (home_xg_for_pg + away_xg_against_pg) / 2
       λ_away = (away_xg_for_pg + home_xg_against_pg) / 2
     At neutral venue (e.g. UCL final), no home advantage applied.
     For league play with a home venue, the team's typical home boost
     can be layered in by the caller.
  3. Apply M9 xG regression where the team has been over/under-performing
     their xG (same logic as DC fit's _xg_prior_adjustment).
  4. Apply M7 / M8 lineup adjustments when Sportmonks snapshot exists.
  5. Compute 1X2 / totals / BTTS probabilities via Poisson on the 2D
     joint distribution, with Dixon-Coles low-score correlation (rho).
  6. Apply shrinkage factors so the model isn't over-confident (same
     factors as predict_match: 0.72 / 0.80 / 0.85).
  7. Pull match odds from cached Odds API data, compute edges per market,
     attach confidence tiers.

Returns a single dict — see ``intelligence_for_match()`` docstring for the
full shape.
"""
from __future__ import annotations

import math
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from ml.soccer.model import (
    _xg_prior_adjustment,
    _lineup_availability_adjustment,
    _lineup_defensive_availability_adjustment,
    SHRINKAGE_FACTOR_1X2,
    SHRINKAGE_FACTOR_TOTALS,
    SHRINKAGE_FACTOR_BTTS,
    _shrink_1x2,
    _shrink_two_way,
)
from ml.soccer.prop_cards import (
    _american_to_implied_prob,
    _poisson_at_least,
)

# How many recent Understat matches we average per team. 12 matches ≈ a
# third of a Big-5 season — enough to dampen single-match noise without
# carrying stale form from last fall.
_RECENT_MATCH_WINDOW = 12

# Low-score correction (Dixon-Coles rho). Same default as the league fits.
# Slightly negative because 0-0 and 1-1 happen a bit more often than
# independent Poisson would predict.
_RHO_DEFAULT = -0.05

# Joint-distribution truncation. Goals beyond MAX_GOALS contribute < 0.5%
# to any probability we care about, so summing to 8 is plenty.
_MAX_GOALS = 8


# ── Data fetchers ────────────────────────────────────────────────────────────

def _team_xg_window(
    conn: sqlite3.Connection,
    team: str,
    *,
    n: int = _RECENT_MATCH_WINDOW,
    before_date: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Last n Understat matches for ``team``. Returns aggregate xG stats.

    Resolves the team name through the same fuzzy match _xg_prior_adjustment
    uses (handles "Man United" → "Manchester United" etc.). Returns None if
    we don't have enough sample (need ≥6 matches).
    """
    # Reuse the existing tokenized matching from xg_prior_adjustment via
    # a direct query (the matched name lives in soccer_source_team_match_stats).
    where = "team = ? OR team LIKE ?"
    params: List[Any] = [team, f"%{team}%"]
    if before_date:
        where += " AND match_date < ?"
        params.append(before_date)
    rows = conn.execute(
        f"""SELECT goals_for, goals_against, xg_for, xg_against, match_date,
                   team
              FROM soccer_source_team_match_stats
             WHERE ({where})
             ORDER BY match_date DESC
             LIMIT ?""",
        (*params, n),
    ).fetchall()
    if len(rows) < 6:
        return None

    # Resolve to the canonical team name actually stored in the table
    canonical = rows[0]["team"]
    sums = {"goals_for": 0.0, "goals_against": 0.0,
            "xg_for": 0.0, "xg_against": 0.0}
    n_used = 0
    for r in rows:
        for k in sums:
            v = r[k]
            if v is None:
                continue
            sums[k] += float(v)
        n_used += 1
    if n_used == 0:
        return None
    return {
        "team": canonical,
        "n_matches": n_used,
        "goals_for_pg":   sums["goals_for"]   / n_used,
        "goals_against_pg": sums["goals_against"] / n_used,
        "xg_for_pg":      sums["xg_for"]      / n_used,
        "xg_against_pg":  sums["xg_against"]  / n_used,
        # Over/under-performance ratios — same shape compute_xg_prior uses
        "xg_overperf_for":  sums["xg_for"] / sums["goals_for"] if sums["goals_for"] > 0 else None,
        "xg_overperf_against": sums["xg_against"] / sums["goals_against"] if sums["goals_against"] > 0 else None,
    }


# ── Poisson 2D table → market probabilities ─────────────────────────────────

def _joint_probability_grid(lam_h: float, lam_a: float, rho: float = _RHO_DEFAULT) -> List[List[float]]:
    """Joint P(home goals = i, away goals = j) for i,j in 0..MAX_GOALS.

    Applies Dixon-Coles low-score correlation (rho). For (0,0), (0,1), (1,0),
    (1,1) the cell is multiplied by tau(i,j,lam_h,lam_a,rho); other cells
    are independent Poisson products.
    """
    # Precompute Poisson PMF for each team
    def poisson_pmf(lam: float, k: int) -> float:
        if lam <= 0:
            return 1.0 if k == 0 else 0.0
        return math.exp(-lam) * (lam ** k) / math.factorial(k)
    home_pmf = [poisson_pmf(lam_h, i) for i in range(_MAX_GOALS + 1)]
    away_pmf = [poisson_pmf(lam_a, j) for j in range(_MAX_GOALS + 1)]

    # Dixon-Coles low-score correction
    def tau(i: int, j: int) -> float:
        if i == 0 and j == 0:
            return 1.0 - lam_h * lam_a * rho
        if i == 0 and j == 1:
            return 1.0 + lam_h * rho
        if i == 1 and j == 0:
            return 1.0 + lam_a * rho
        if i == 1 and j == 1:
            return 1.0 - rho
        return 1.0

    grid = [[0.0] * (_MAX_GOALS + 1) for _ in range(_MAX_GOALS + 1)]
    total = 0.0
    for i in range(_MAX_GOALS + 1):
        for j in range(_MAX_GOALS + 1):
            p = home_pmf[i] * away_pmf[j] * tau(i, j)
            if p < 0:  # tau can drag a probability slightly negative; floor it
                p = 0.0
            grid[i][j] = p
            total += p
    if total > 0:
        for i in range(_MAX_GOALS + 1):
            for j in range(_MAX_GOALS + 1):
                grid[i][j] /= total
    return grid


def _markets_from_grid(grid: List[List[float]]) -> Dict[str, float]:
    """Walk the joint grid once to derive every game-level market we care
    about. Returns probability for each."""
    p_home = p_draw = p_away = 0.0
    p_over_25 = p_under_25 = 0.0
    p_over_15 = p_under_15 = 0.0
    p_over_35 = p_under_35 = 0.0
    p_btts_yes = p_btts_no = 0.0
    # Team totals — over 1.5 each side
    p_home_over_15 = p_home_under_15 = 0.0
    p_away_over_15 = p_away_under_15 = 0.0
    for i in range(_MAX_GOALS + 1):
        for j in range(_MAX_GOALS + 1):
            p = grid[i][j]
            total = i + j
            if i > j:  p_home += p
            elif i < j: p_away += p
            else:       p_draw += p
            if total >= 2: p_over_15 += p
            else:          p_under_15 += p
            if total >= 3: p_over_25 += p
            else:          p_under_25 += p
            if total >= 4: p_over_35 += p
            else:          p_under_35 += p
            if i >= 1 and j >= 1: p_btts_yes += p
            else:                  p_btts_no  += p
            if i >= 2: p_home_over_15 += p
            else:      p_home_under_15 += p
            if j >= 2: p_away_over_15 += p
            else:      p_away_under_15 += p
    return {
        "p_home": p_home, "p_draw": p_draw, "p_away": p_away,
        "p_over_15": p_over_15, "p_under_15": p_under_15,
        "p_over_25": p_over_25, "p_under_25": p_under_25,
        "p_over_35": p_over_35, "p_under_35": p_under_35,
        "p_btts_yes": p_btts_yes, "p_btts_no": p_btts_no,
        "p_home_over_15": p_home_over_15, "p_home_under_15": p_home_under_15,
        "p_away_over_15": p_away_over_15, "p_away_under_15": p_away_under_15,
    }


# ── Adjustments (M7/M8/M9 reused) ───────────────────────────────────────────

def _apply_xg_adjustments(
    home_xg: Dict[str, Any],
    away_xg: Dict[str, Any],
    conn: sqlite3.Connection,
    league_hint: Optional[str],
    home_league: Optional[str],
    away_league: Optional[str],
    before_date: Optional[str],
    home_team_resolved: str,
    away_team_resolved: str,
) -> Tuple[float, float, Dict[str, Any]]:
    """Returns (lambda_home, lambda_away, traces) after applying M9 xG
    over/under-performance regression."""
    # Base λ from cross-league xG math (no home advantage; caller can scale
    # before sending to the joint-grid solver if they want a venue factor).
    lam_h = (home_xg["xg_for_pg"] + away_xg["xg_against_pg"]) / 2.0
    lam_a = (away_xg["xg_for_pg"] + home_xg["xg_against_pg"]) / 2.0
    traces = {"raw_lam_h": lam_h, "raw_lam_a": lam_a}

    # M9 xG priors. The function reads xg_for and goals_for from
    # soccer_source_team_match_stats and returns alpha/delta multipliers.
    # We don't need a league_hint per se but the helper expects one for
    # the Understat-league lookup; UCL falls back to "team-not-in-understat"
    # gracefully and just returns 1.0 / 1.0 multipliers in that case.
    # Each team gets its OWN league hint when looking up xG history — PSG's
    # Understat data lives under "Ligue 1", Arsenal's under "Premier League".
    # Passing league_hint (= the tournament, e.g. "UCL") to both would miss.
    try:
        alpha_h, delta_h, trace_h = _xg_prior_adjustment(
            home_team_resolved,
            home_league or league_hint or "Premier League",
            conn,
            before_date=before_date,
        )
        alpha_a, delta_a, trace_a = _xg_prior_adjustment(
            away_team_resolved,
            away_league or league_hint or "Premier League",
            conn,
            before_date=before_date,
        )
    except Exception:
        alpha_h = delta_h = alpha_a = delta_a = 1.0
        trace_h = trace_a = {}

    lam_h *= alpha_h * delta_a
    lam_a *= alpha_a * delta_h
    traces.update({
        "xg_alpha_h": round(alpha_h, 4),
        "xg_alpha_a": round(alpha_a, 4),
        "xg_delta_h": round(delta_h, 4),
        "xg_delta_a": round(delta_a, 4),
        "xg_trace_h": trace_h,
        "xg_trace_a": trace_a,
    })

    # M7 lineup-availability adjustment (attack side)
    try:
        lineup_mult_h, lineup_trace_h = _lineup_availability_adjustment(
            home_team_resolved, conn, before_date=before_date,
        )
        lineup_mult_a, lineup_trace_a = _lineup_availability_adjustment(
            away_team_resolved, conn, before_date=before_date,
        )
    except Exception:
        lineup_mult_h = lineup_mult_a = 1.0
        lineup_trace_h = lineup_trace_a = {}

    lam_h *= lineup_mult_h
    lam_a *= lineup_mult_a
    traces.update({
        "lineup_mult_h": round(lineup_mult_h, 4),
        "lineup_mult_a": round(lineup_mult_a, 4),
        "lineup_trace_h": lineup_trace_h,
        "lineup_trace_a": lineup_trace_a,
    })

    # M8 defensive-availability adjustment (boost opponent λ)
    try:
        vuln_h, defense_trace_h = _lineup_defensive_availability_adjustment(
            home_team_resolved, conn, before_date=before_date,
        )
        vuln_a, defense_trace_a = _lineup_defensive_availability_adjustment(
            away_team_resolved, conn, before_date=before_date,
        )
    except Exception:
        vuln_h = vuln_a = 1.0
        defense_trace_h = defense_trace_a = {}

    lam_h *= vuln_a  # away's defensive holes → boost home λ
    lam_a *= vuln_h  # home's defensive holes → boost away λ
    traces.update({
        "defense_vuln_h": round(vuln_h, 4),
        "defense_vuln_a": round(vuln_a, 4),
        "defense_trace_h": defense_trace_h,
        "defense_trace_a": defense_trace_a,
    })

    return lam_h, lam_a, traces


# ── Public entry point ───────────────────────────────────────────────────────

def intelligence_for_match(
    home_team: str,
    away_team: str,
    *,
    tournament: str = "UCL",
    home_league: Optional[str] = None,
    away_league: Optional[str] = None,
    league_hint: Optional[str] = None,
    commence_time: Optional[str] = None,
    game_id: Optional[str] = None,
    neutral_venue: bool = True,
    db_path: Optional[Path] = None,
    before_date: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Full ACE intelligence picture for one match.

    Returns a dict ready to drop into the trading-desk UI:
      {
        "fixture":   { home, away, tournament, kickoff, game_id, neutral_venue },
        "model":     { lambda_h, lambda_a, [all market probs] },
        "drivers":   { xg signals, lineup status, adjustment traces },
        "shrinkage": { factors applied },
      }
    None if either team lacks ≥6 Understat matches.
    """
    from ml.world_cup.signal_logger import DB_PATH as _DEFAULT_DB
    path = db_path or _DEFAULT_DB
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    try:
        home_xg = _team_xg_window(conn, home_team, before_date=before_date)
        away_xg = _team_xg_window(conn, away_team, before_date=before_date)
        if not home_xg or not away_xg:
            missing = []
            if not home_xg: missing.append(home_team)
            if not away_xg: missing.append(away_team)
            return {
                "fixture": {
                    "home": home_team, "away": away_team,
                    "tournament": tournament,
                    "commence_time": commence_time,
                    "game_id": game_id,
                    "neutral_venue": neutral_venue,
                },
                "error": f"insufficient Understat sample for: {', '.join(missing)}",
            }

        lam_h, lam_a, adj_trace = _apply_xg_adjustments(
            home_xg, away_xg, conn,
            league_hint=league_hint,
            home_league=home_league,
            away_league=away_league,
            before_date=before_date,
            home_team_resolved=home_xg["team"],
            away_team_resolved=away_xg["team"],
        )

        # Joint grid → all markets
        grid = _joint_probability_grid(lam_h, lam_a)
        raw_probs = _markets_from_grid(grid)

        # Apply shrinkage so the model isn't over-confident — same factors
        # as predict_match. 1X2 shrinks 28% toward uniform; totals 20%; BTTS 15%.
        p_h, p_d, p_a = _shrink_1x2(
            raw_probs["p_home"], raw_probs["p_draw"], raw_probs["p_away"],
        )
        p_o25, p_u25 = _shrink_two_way(
            raw_probs["p_over_25"], raw_probs["p_under_25"],
            SHRINKAGE_FACTOR_TOTALS,
        )
        p_btts, p_no_btts = _shrink_two_way(
            raw_probs["p_btts_yes"], raw_probs["p_btts_no"],
            SHRINKAGE_FACTOR_BTTS,
        )

        return {
            "fixture": {
                "home": home_team, "away": away_team,
                "home_canonical": home_xg["team"],
                "away_canonical": away_xg["team"],
                "tournament": tournament,
                "commence_time": commence_time,
                "game_id": game_id,
                "neutral_venue": neutral_venue,
            },
            "model": {
                "lambda_h": round(lam_h, 3),
                "lambda_a": round(lam_a, 3),
                # 1X2
                "p_home_win":  round(p_h, 4),
                "p_draw":      round(p_d, 4),
                "p_away_win":  round(p_a, 4),
                # Totals 2.5 (post-shrinkage)
                "p_over_25":   round(p_o25, 4),
                "p_under_25":  round(p_u25, 4),
                # Totals other lines (raw — no shrinkage applied at other lines yet)
                "p_over_15_raw":  round(raw_probs["p_over_15"], 4),
                "p_under_15_raw": round(raw_probs["p_under_15"], 4),
                "p_over_35_raw":  round(raw_probs["p_over_35"], 4),
                "p_under_35_raw": round(raw_probs["p_under_35"], 4),
                # BTTS (post-shrinkage)
                "p_btts_yes":  round(p_btts, 4),
                "p_btts_no":   round(p_no_btts, 4),
                # Team totals — raw (no shrinkage)
                "p_home_over_15_raw": round(raw_probs["p_home_over_15"], 4),
                "p_away_over_15_raw": round(raw_probs["p_away_over_15"], 4),
                # Raw 1X2 too (so the UI can show pre-shrinkage if it wants)
                "p_home_win_raw":  round(raw_probs["p_home"], 4),
                "p_draw_raw":      round(raw_probs["p_draw"], 4),
                "p_away_win_raw":  round(raw_probs["p_away"], 4),
            },
            "drivers": {
                "home_xg_window": home_xg,
                "away_xg_window": away_xg,
                "adjustments": adj_trace,
            },
            "shrinkage": {
                "factor_1x2":  SHRINKAGE_FACTOR_1X2,
                "factor_tot":  SHRINKAGE_FACTOR_TOTALS,
                "factor_btts": SHRINKAGE_FACTOR_BTTS,
            },
            "computed_at": datetime.now(timezone.utc).isoformat(),
        }
    finally:
        conn.close()


# ── Edge computation against book odds ──────────────────────────────────────

def edge_against_book(
    intelligence: Dict[str, Any],
    odds: Dict[str, Any],
) -> Dict[str, Any]:
    """Given an intelligence dict + a dict of book odds → return per-market
    edges with tier annotations.

    Expected ``odds`` shape:
      {
        "h2h": {"home": {"price": -120, "book": "fanduel"},
                "draw": {"price": +280, "book": "draftkings"},
                "away": {"price": +250, "book": "betmgm"}},
        "totals_25": {"over": {"price": -110, "book": "fanduel"},
                      "under": {"price": -110, "book": "draftkings"}},
        "btts": {"yes": {...}, "no": {...}},
      }
    Missing markets are skipped silently. Returns a list of edge entries
    sorted by absolute edge descending.
    """
    model = intelligence.get("model") or {}
    out: List[Dict[str, Any]] = []

    def push(market: str, side: str, model_prob: float, book_entry: Optional[Dict[str, Any]]):
        if not book_entry or book_entry.get("price") is None:
            return
        try:
            implied = _american_to_implied_prob(float(book_entry["price"]))
        except (TypeError, ValueError):
            return
        edge = model_prob - implied
        out.append({
            "market": market,
            "side": side,
            "model_prob": round(model_prob, 4),
            "implied_prob": round(implied, 4),
            "edge_pp": round(edge, 4),
            "best_book": book_entry.get("book"),
            "best_price": book_entry.get("price"),
            "tier": _tier_for_edge(edge),
        })

    h2h = odds.get("h2h") or {}
    push("1X2", "home", model.get("p_home_win") or 0.0, h2h.get("home"))
    push("1X2", "draw", model.get("p_draw") or 0.0, h2h.get("draw"))
    push("1X2", "away", model.get("p_away_win") or 0.0, h2h.get("away"))

    tot = odds.get("totals_25") or {}
    push("Totals 2.5", "over",  model.get("p_over_25") or 0.0,  tot.get("over"))
    push("Totals 2.5", "under", model.get("p_under_25") or 0.0, tot.get("under"))

    btts = odds.get("btts") or {}
    push("BTTS", "yes", model.get("p_btts_yes") or 0.0, btts.get("yes"))
    push("BTTS", "no",  model.get("p_btts_no")  or 0.0, btts.get("no"))

    out.sort(key=lambda e: e["edge_pp"], reverse=True)
    return {"edges": out}


def _tier_for_edge(edge: float) -> str:
    """A / B / C / pass classifier on per-market edge.

    Stricter than the prop-card thresholds because game-level markets are
    sharper (Pinnacle close is typically within 2 pp of true) — anything
    above 5pp is genuinely meaningful."""
    if edge >= 0.05: return "A"
    if edge >= 0.03: return "B"
    if edge >= 0.015: return "C"
    return "pass"
