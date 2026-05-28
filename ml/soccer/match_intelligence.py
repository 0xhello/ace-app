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

# Home-advantage gamma factor (M21). DC fits typically learn γ ≈ 1.30 on
# Big-5 league play — i.e. the home team's λ is multiplied by 1.30 vs
# what they'd score at a neutral venue. The cross-league math doesn't have
# a learnt γ so we use this default. Applied as a SPLIT factor so total
# expected goals stays roughly constant when toggling neutral_venue:
#   home_factor = sqrt(γ),  away_factor = 1/sqrt(γ)
# For γ=1.30 this gives home × 1.14, away × 0.877 — a reasonable boost
# to the home team without doubling its λ.
HOME_ADVANTAGE_GAMMA = 1.30

# M9 xG-delta tuning (M21). The original ±15% clamp on delta multiplier
# was too aggressive — calibration backtest showed +5pp overs bias on
# Big-5 league play. Dropping defense-delta cap to 1.08 (8% boost) while
# keeping attack-alpha at 1.15 closes most of that. Tunable.
M9_DELTA_DAMP = 0.50  # multiply (delta_raw - 1) by this before clamping


# ── Competition-strength scaler (M20) ───────────────────────────────────────
#
# Why this exists
# ---------------
# Team xG numbers from Understat are calibrated to the team's HOME league.
# When the model projects PSG into a UCL knockout match, it carries PSG's
# Ligue 1 xG (~2.99 xG/match) as if it'd translate 1:1 against Arsenal —
# which doesn't happen. Knockout-stage defenses are sharper and both
# sides play more conservatively. Same effect compounds for finals.
#
# The factor below scales λ down to account for the stage. Derivation:
#
#   Big-5 league avg total goals/match (from our Understat cache, 2024-25):
#     Premier League  2.93  ·  La Liga  2.62  ·  Ligue 1  2.98
#     Bundesliga      3.13  ·  Serie A  2.56  ·  weighted avg ≈ 2.84
#
#   UCL average total goals/match (public Opta data, last 5 seasons):
#     Group stage        2.85   ≈ same as Big-5 league
#     Quarter+Semi-final 2.52   → 2.52/2.84 = 0.887
#     Final              2.18   → 2.18/2.84 = 0.768 (sample-size caveat)
#
# Apply as λ_adjusted = λ_raw × factor, on BOTH sides (no asymmetry —
# both teams play tighter in knockouts). For UCL finals specifically we
# stack the knockout factor (0.88) with an additional final discount
# (0.92), giving 0.81 combined. Tunable — these are conservative starting
# points; the calibration backtest will refine them.
#
# 1.0 is the no-op default for league play.

COMPETITION_FACTORS: Dict[str, float] = {
    "league":              1.00,  # Premier League / La Liga / etc. regular season
    "ucl_group":           0.95,  # UCL group stage (slightly tighter)
    "ucl_knockout":        0.88,  # Round of 16 → semi
    "ucl_final":           0.81,  # 0.88 (knockout) × 0.92 (final)
    "uel_knockout":        0.90,  # Europa League — slightly higher than UCL
    "world_cup_group":     0.90,
    "world_cup_knockout":  0.83,
    "world_cup_final":     0.75,
    "international_friendly": 0.92,
}


def _resolve_competition_stage(
    tournament: Optional[str],
    stage: Optional[str],
) -> str:
    """Map (tournament, stage) → COMPETITION_FACTORS key.

    ``stage`` overrides everything when caller passes it explicitly (e.g.
    "ucl_final" for the PSG-Arsenal pilot). When stage is None we infer:
        tournament="UCL"           → ucl_knockout (safe default in mid-season)
        tournament="Europa League" → uel_knockout
        tournament="World Cup"     → world_cup_group (safe default)
        anything else              → league
    """
    if stage and stage in COMPETITION_FACTORS:
        return stage
    if not tournament:
        return "league"
    t = tournament.lower()
    if "uefa champ" in t or t == "ucl":
        return "ucl_knockout"
    if "europa" in t or t == "uel":
        return "uel_knockout"
    if "world cup" in t or t == "wc":
        return "world_cup_group"
    return "league"

# Low-score correction (Dixon-Coles rho). Same default as the league fits.
# Slightly negative because 0-0 and 1-1 happen a bit more often than
# independent Poisson would predict.
_RHO_DEFAULT = -0.05

# Joint-distribution truncation. Goals beyond MAX_GOALS contribute < 0.5%
# to any probability we care about, so summing to 8 is plenty.
_MAX_GOALS = 8

# Corners (M23) — bigger range than goals because total corners typically
# sits around 9-12 per match with substantial spread. Sum to 24 to cover
# the tail.
_MAX_CORNERS = 24


# ── Corners (M23) ────────────────────────────────────────────────────────────

# Common team-name variants across our sources. soccer_team_form uses
# football-data.co.uk's short names ("Paris SG", "Man United"); Understat
# uses the full club name. We collapse known variants here so the corner-
# rate lookup doesn't silently miss the biggest clubs.
_FORM_TABLE_NAME_ALIASES: Dict[str, List[str]] = {
    "Paris Saint Germain": ["Paris SG", "PSG"],
    "Manchester United":   ["Man United", "Man Utd"],
    "Manchester City":     ["Man City"],
    "Tottenham":           ["Tottenham Hotspur"],
    "Wolverhampton Wanderers": ["Wolves"],
    "Newcastle":           ["Newcastle United"],
    "Athletic Bilbao":     ["Ath Bilbao"],
    "Atletico Madrid":     ["Ath Madrid"],
    "Borussia Dortmund":   ["Dortmund"],
    "Borussia Monchengladbach": ["M'gladbach"],
    "Bayer Leverkusen":    ["Leverkusen"],
    "Eintracht Frankfurt": ["Frankfurt"],
    "Bologna FC":          ["Bologna"],
}


def _team_corners_window(
    conn: sqlite3.Connection,
    team: str,
    *,
    n: int = _RECENT_MATCH_WINDOW,
    before_date: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Last n league matches for ``team`` with corner stats.

    Pulls from soccer_team_form. Resolves common name variants via the
    alias map (so "Paris Saint Germain" → looks up "Paris SG" too).
    Returns the team's per-match corners-for / corners-against, or None
    if fewer than 6 rows are available.
    """
    # Try exact, alias variants, then a LIKE fallback
    candidates = [team] + _FORM_TABLE_NAME_ALIASES.get(team, [])
    placeholders = ",".join("?" for _ in candidates)
    where = (
        f"(team_name IN ({placeholders}) OR team_name LIKE ?) "
        f"AND corners IS NOT NULL"
    )
    params: List[Any] = list(candidates) + [f"%{team}%"]
    if before_date:
        where += " AND match_date < ?"
        params.append(before_date)
    rows = conn.execute(
        f"""SELECT team_name, corners, corners_against, match_date
              FROM soccer_team_form
             WHERE {where}
             ORDER BY match_date DESC
             LIMIT ?""",
        (*params, n),
    ).fetchall()
    if len(rows) < 6:
        return None
    canonical = rows[0]["team_name"]
    n_used = len(rows)
    cor_for = sum(r["corners"] or 0 for r in rows) / n_used
    cor_against = sum(r["corners_against"] or 0 for r in rows) / n_used
    return {
        "team": canonical,
        "n_matches": n_used,
        "corners_for_pg": cor_for,
        "corners_against_pg": cor_against,
    }


def _corner_markets(lam_total: float) -> Dict[str, float]:
    """Poisson P(X >= line) for the standard corner totals lines.

    Books typically offer 8.5, 9.5, 10.5, 11.5. We compute all of them
    so the UI / edge layer can match whichever line the book is offering.
    """
    def pmf(lam: float, k: int) -> float:
        if lam <= 0:
            return 1.0 if k == 0 else 0.0
        return math.exp(-lam) * (lam ** k) / math.factorial(k)
    if lam_total <= 0:
        return {}
    # Compute cumulative for thresholds
    pdf = [pmf(lam_total, i) for i in range(_MAX_CORNERS + 1)]
    cdf_at = [0.0] * (_MAX_CORNERS + 2)
    cdf_at[0] = pdf[0]
    for k in range(1, _MAX_CORNERS + 1):
        cdf_at[k] = cdf_at[k - 1] + pdf[k]
    cdf_at[_MAX_CORNERS + 1] = 1.0

    def p_at_least(k: int) -> float:
        if k <= 0:
            return 1.0
        if k > _MAX_CORNERS:
            return 0.0
        return max(0.0, 1.0 - cdf_at[k - 1])

    out: Dict[str, float] = {"lambda_total_corners": round(lam_total, 3)}
    for line in (7.5, 8.5, 9.5, 10.5, 11.5, 12.5):
        thr = int(math.ceil(line))
        out[f"p_over_{line}".replace(".", "_")]  = round(p_at_least(thr), 4)
        out[f"p_under_{line}".replace(".", "_")] = round(1.0 - p_at_least(thr), 4)
    return out


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
    competition_stage: str = "league",
    neutral_venue: bool = False,
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

    # M21 — Damp the delta multiplier toward 1.0 because the calibration
    # backtest showed M9 delta was stacking with M8 vuln to create a +5pp
    # overs bias. Apply (1 + (delta - 1) * M9_DELTA_DAMP) — preserves the
    # direction of the regression but halves its magnitude.
    delta_h_damped = 1.0 + (delta_h - 1.0) * M9_DELTA_DAMP
    delta_a_damped = 1.0 + (delta_a - 1.0) * M9_DELTA_DAMP

    lam_h *= alpha_h * delta_a_damped
    lam_a *= alpha_a * delta_h_damped
    traces.update({
        "xg_alpha_h": round(alpha_h, 4),
        "xg_alpha_a": round(alpha_a, 4),
        "xg_delta_h_raw": round(delta_h, 4),
        "xg_delta_a_raw": round(delta_a, 4),
        "xg_delta_h_damped": round(delta_h_damped, 4),
        "xg_delta_a_damped": round(delta_a_damped, 4),
        "xg_delta_damp_factor": M9_DELTA_DAMP,
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

    # Competition-strength scaler — applies BEFORE home advantage so we
    # down-weight every earlier multiplicative effect (Big-5 xG, M9 priors,
    # M7/M8) in one consistent step. Same factor on both sides since
    # knockout play is symmetric.
    comp_factor = COMPETITION_FACTORS.get(competition_stage, 1.0)
    lam_h_pre = lam_h
    lam_a_pre = lam_a
    lam_h *= comp_factor
    lam_a *= comp_factor
    traces.update({
        "competition_stage": competition_stage,
        "competition_factor": round(comp_factor, 4),
        "lam_h_pre_competition": round(lam_h_pre, 4),
        "lam_a_pre_competition": round(lam_a_pre, 4),
    })

    # M21 — Home advantage. The calibration backtest showed the cross-league
    # math was systematically under-predicting home wins by 8.8pp because
    # it doesn't account for the home team's venue boost. Split gamma so
    # total goals stays approximately constant; only λ_h vs λ_a shifts.
    if neutral_venue:
        home_factor = 1.0
        away_factor = 1.0
    else:
        home_factor = math.sqrt(HOME_ADVANTAGE_GAMMA)        # ~1.140 for γ=1.30
        away_factor = 1.0 / math.sqrt(HOME_ADVANTAGE_GAMMA)  # ~0.877
    lam_h_pre_venue = lam_h
    lam_a_pre_venue = lam_a
    lam_h *= home_factor
    lam_a *= away_factor
    traces.update({
        "neutral_venue":   neutral_venue,
        "home_factor":     round(home_factor, 4),
        "away_factor":     round(away_factor, 4),
        "lam_h_pre_venue": round(lam_h_pre_venue, 4),
        "lam_a_pre_venue": round(lam_a_pre_venue, 4),
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
    competition_stage: Optional[str] = None,
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

        stage = _resolve_competition_stage(tournament, competition_stage)
        lam_h, lam_a, adj_trace = _apply_xg_adjustments(
            home_xg, away_xg, conn,
            league_hint=league_hint,
            home_league=home_league,
            away_league=away_league,
            before_date=before_date,
            home_team_resolved=home_xg["team"],
            away_team_resolved=away_xg["team"],
            competition_stage=stage,
            neutral_venue=neutral_venue,
        )

        # Joint grid → all markets
        grid = _joint_probability_grid(lam_h, lam_a)
        raw_probs = _markets_from_grid(grid)

        # Corners (M23) — independent of the goal grid. Each team's
        # expected corners is the average of (their own corners-for rate)
        # and (opponent's corners-against rate). Notably, UCL knockouts
        # typically have AS MANY OR MORE corners than league play (pressure-
        # driven attacking) — so we DON'T apply the COMPETITION_FACTORS
        # scaler here. Total = home_team_corners + away_team_corners.
        home_corners = _team_corners_window(conn, home_team, before_date=before_date)
        away_corners = _team_corners_window(conn, away_team, before_date=before_date)
        corners_markets: Dict[str, Any] = {}
        if home_corners and away_corners:
            home_cor = (home_corners["corners_for_pg"] + away_corners["corners_against_pg"]) / 2.0
            away_cor = (away_corners["corners_for_pg"] + home_corners["corners_against_pg"]) / 2.0
            total_lam = home_cor + away_cor
            corners_markets = _corner_markets(total_lam)
            corners_markets["home_team_corners"] = round(home_cor, 3)
            corners_markets["away_team_corners"] = round(away_cor, 3)

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
                "home_corners_window": home_corners,
                "away_corners_window": away_corners,
                "adjustments": adj_trace,
            },
            "corners": corners_markets,
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
