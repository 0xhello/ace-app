"""
Soccer intelligence model — v1.

Two-stage architecture:
  1. EloRatings — chronological per-team strength tracker. Updates after every
     match. Captures form swings the league table is slow to reflect.
  2. DixonColesModel — Poisson goal-expectancy with low-score correction.
     Per-team attack (α) and defense (δ) parameters fit by maximum likelihood
     on historical match data, recency-weighted.

The two work together: Elo gives a fast-moving strength signal, Dixon-Coles
gives calibrated per-scoreline probabilities. The output of this module is
a probability distribution over match outcomes that we then compare to book
prices to detect edge.

Trained on the ~5,200 unique matches × 3 seasons × Big 5 leagues already
ingested into soccer_team_form via ml/soccer/form.py.

See docs/SOCCER_MODEL_SPEC_V1.md for the full design rationale.

Usage:
    from ml.soccer.model import fit_and_save, load_and_predict
    fit_and_save()                          # Train + persist model state
    p = load_and_predict("Liverpool", "Brighton", "Premier League")
    # p = {"home": 0.61, "draw": 0.22, "away": 0.17, "lambda_h": 1.85, "lambda_a": 0.92, ...}
"""
from __future__ import annotations

import json
import math
import os
import pickle
import sqlite3
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from scipy.optimize import minimize
from scipy.stats import poisson


# ── DB + paths ───────────────────────────────────────────────────────────────

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DB_PATH    = _REPO_ROOT / "ml" / "nba_spread" / "data" / "wc_signal_log.db"
MODEL_DIR  = _REPO_ROOT / "ml" / "soccer" / "artifacts"


def _ensure_artifacts_dir() -> None:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)


def get_db(path: Optional[Path] = None) -> sqlite3.Connection:
    p = path or DB_PATH
    conn = sqlite3.connect(str(p))
    conn.row_factory = sqlite3.Row
    return conn


# ── Elo ratings ──────────────────────────────────────────────────────────────
# A standard Elo implementation tuned for soccer:
#   - K-factor: 20 (lower than chess because soccer outcomes are noisier)
#   - Home advantage: +60 Elo points (empirical for top-5 leagues)
#   - Goal-difference scaling: applies a margin-of-victory multiplier so a
#     5-0 win is more meaningful than a 1-0 win
#
# Reference: Hvattum & Arntzen 2010, "Using ELO ratings for match result
# prediction in association football."

ELO_INITIAL    = 1500.0
ELO_K          = 20.0
ELO_HOME_ADV   = 60.0   # added to home team's rating when computing expected score
ELO_GD_MIN_MULT = 1.0   # goal-difference multiplier for a 1-goal margin
ELO_GD_2_MULT   = 1.5   # 2-goal margin
ELO_GD_3PLUS_BASE = 1.75


def _gd_multiplier(goal_diff: int) -> float:
    """Scales the K-factor based on margin of victory. Standard formulation."""
    abs_gd = abs(goal_diff)
    if abs_gd == 1:
        return ELO_GD_MIN_MULT
    if abs_gd == 2:
        return ELO_GD_2_MULT
    return ELO_GD_3PLUS_BASE + (abs_gd - 3) * 0.0625


def _expected_score(elo_a: float, elo_b: float) -> float:
    """Expected probability that team A beats team B (0-1)."""
    return 1.0 / (1.0 + 10.0 ** ((elo_b - elo_a) / 400.0))


@dataclass
class EloState:
    """Final Elo state for a league after walking all historical matches."""
    ratings: Dict[str, float]
    league:  str
    last_match_date: str
    matches_processed: int


def compute_elo_for_league(league: str, conn: sqlite3.Connection) -> EloState:
    """Walk every historical match in `league` chronologically, updating Elo
    after each. Returns the final per-team ratings."""
    rows = conn.execute(
        """
        SELECT match_date, team_name, opponent, goals_for, goals_against
        FROM soccer_team_form
        WHERE league = ? AND venue = 'home'
        ORDER BY match_date ASC, team_name ASC
        """,
        (league,),
    ).fetchall()
    if not rows:
        return EloState({}, league, "—", 0)

    ratings: Dict[str, float] = {}
    last_date = ""
    for r in rows:
        h, a = r["team_name"], r["opponent"]
        gh, ga = r["goals_for"] or 0, r["goals_against"] or 0
        last_date = r["match_date"]

        ratings.setdefault(h, ELO_INITIAL)
        ratings.setdefault(a, ELO_INITIAL)

        # Expected score (home perspective, with home advantage)
        exp_h = _expected_score(ratings[h] + ELO_HOME_ADV, ratings[a])

        # Actual score (home perspective): 1 win, 0.5 draw, 0 loss
        if gh > ga:    actual_h = 1.0
        elif gh < ga:  actual_h = 0.0
        else:          actual_h = 0.5

        # Margin-adjusted K
        k = ELO_K * _gd_multiplier(gh - ga)

        delta = k * (actual_h - exp_h)
        ratings[h] += delta
        ratings[a] -= delta

    return EloState(ratings, league, last_date, len(rows))


# ── Dixon-Coles model ────────────────────────────────────────────────────────
# Reference: Dixon & Coles 1997, "Modelling Association Football Scores and
# Inefficiencies in the Football Betting Market" (Journal of the Royal
# Statistical Society, Series C).
#
# Model:
#   λ_home = α_h × δ_a × γ_league      (expected home goals)
#   λ_away = α_a × δ_h                 (expected away goals)
#   Goals ~ Poisson(λ)
#   τ(x, y) — DC correction for low scorelines (0-0, 1-0, 0-1, 1-1)
#
# Constraints:
#   sum(α) = N (number of teams)  → normalization
#   sum(δ) = N
# Estimated by maximum likelihood with recency weighting.

# Recency weighting: w(t) = exp(-ξ × age_days). Dixon-Coles paper finds
# ξ ≈ 0.0065 (per day) optimal — half-life of ~107 days.
RECENCY_XI = 0.0065


def _dc_tau(x: int, y: int, lambda_h: float, lambda_a: float, rho: float) -> float:
    """Dixon-Coles low-scoreline correction. ρ (rho) is the dependence param —
    typically in [-0.2, 0.0]. Adjusts pure-Poisson estimates upward for draws
    (0-0, 1-1) and downward for narrow non-draws (1-0, 0-1).
    """
    if x == 0 and y == 0:
        return 1.0 - lambda_h * lambda_a * rho
    if x == 0 and y == 1:
        return 1.0 + lambda_h * rho
    if x == 1 and y == 0:
        return 1.0 + lambda_a * rho
    if x == 1 and y == 1:
        return 1.0 - rho
    return 1.0


@dataclass
class DCFit:
    """Fitted Dixon-Coles model for one league."""
    league:        str
    alpha:         Dict[str, float]   # attack strength per team (normalized)
    delta:         Dict[str, float]   # defense strength per team (normalized — LOW δ = better defense)
    gamma:         float              # home advantage (multiplicative)
    rho:           float              # DC dependence parameter
    log_likelihood: float
    n_matches:     int
    n_teams:       int
    fit_at:        str

    def to_dict(self) -> Dict[str, Any]:
        return {
            "league": self.league,
            "alpha":  self.alpha,
            "delta":  self.delta,
            "gamma":  self.gamma,
            "rho":    self.rho,
            "log_likelihood": self.log_likelihood,
            "n_matches": self.n_matches,
            "n_teams":   self.n_teams,
            "fit_at":    self.fit_at,
        }

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "DCFit":
        return cls(**d)


def _build_match_arrays(
    league: str, conn: sqlite3.Connection,
    reference_date: Optional[str] = None,
    train_before: Optional[str] = None,
) -> Tuple[List[str], np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Pull home-perspective matches for a league. Returns:
        teams       — ordered list of unique team names
        home_idx    — int array, home team index per match
        away_idx    — int array, away team index per match
        goals_h     — int array of home goals
        goals_a     — int array of away goals
        weights     — recency weights per match

    train_before — when set, hard-filters the dataset to matches STRICTLY
    before this date. Used by the backtest to enforce no-leakage.
    """
    if train_before:
        rows = conn.execute(
            """
            SELECT match_date, team_name AS home, opponent AS away,
                   goals_for AS gh, goals_against AS ga
            FROM soccer_team_form
            WHERE league = ? AND venue = 'home' AND match_date < ?
                  AND goals_for IS NOT NULL AND goals_against IS NOT NULL
            ORDER BY match_date ASC
            """,
            (league, train_before),
        ).fetchall()
    else:
        rows = conn.execute(
            """
            SELECT match_date, team_name AS home, opponent AS away,
                   goals_for AS gh, goals_against AS ga
            FROM soccer_team_form
            WHERE league = ? AND venue = 'home'
                  AND goals_for IS NOT NULL AND goals_against IS NOT NULL
            ORDER BY match_date ASC
            """,
            (league,),
        ).fetchall()
    if not rows:
        return [], np.array([]), np.array([]), np.array([]), np.array([]), np.array([])

    teams = sorted(set(r["home"] for r in rows) | set(r["away"] for r in rows))
    idx = {t: i for i, t in enumerate(teams)}

    ref = reference_date or rows[-1]["match_date"]
    ref_dt = datetime.fromisoformat(ref)

    home_idx, away_idx, gh, ga, w = [], [], [], [], []
    for r in rows:
        home_idx.append(idx[r["home"]])
        away_idx.append(idx[r["away"]])
        gh.append(int(r["gh"]))
        ga.append(int(r["ga"]))
        try:
            age_days = (ref_dt - datetime.fromisoformat(r["match_date"])).days
        except ValueError:
            age_days = 0
        w.append(math.exp(-RECENCY_XI * age_days))

    return (
        teams,
        np.array(home_idx, dtype=np.int32),
        np.array(away_idx, dtype=np.int32),
        np.array(gh, dtype=np.int32),
        np.array(ga, dtype=np.int32),
        np.array(w, dtype=np.float64),
    )


def _neg_log_likelihood(
    params: np.ndarray,
    home_idx: np.ndarray, away_idx: np.ndarray,
    gh: np.ndarray, ga: np.ndarray, weights: np.ndarray,
    n_teams: int,
) -> float:
    """Weighted negative log-likelihood of all matches under the model.
    Param layout:
        [α_1 ... α_{N-1}, δ_1 ... δ_{N-1}, log(γ), rho]
    Last team's α/δ are fixed at N - sum(others) to enforce normalization.
    """
    alpha_free = params[:n_teams - 1]
    delta_free = params[n_teams - 1: 2 * (n_teams - 1)]
    log_gamma  = params[-2]
    rho        = params[-1]

    # Enforce normalization constraints
    alpha_last = n_teams - alpha_free.sum()
    delta_last = n_teams - delta_free.sum()
    if alpha_last <= 1e-6 or delta_last <= 1e-6:
        return 1e10  # constraint violation

    alpha = np.concatenate([alpha_free, [alpha_last]])
    delta = np.concatenate([delta_free, [delta_last]])
    if (alpha <= 0).any() or (delta <= 0).any():
        return 1e10
    if rho < -0.2 or rho > 0.2:
        return 1e10

    gamma = math.exp(log_gamma)

    lam_h = alpha[home_idx] * delta[away_idx] * gamma
    lam_a = alpha[away_idx] * delta[home_idx]

    # Pure Poisson log-likelihood (vectorized)
    log_p_h = gh * np.log(lam_h) - lam_h - np.array([math.lgamma(g + 1) for g in gh])
    log_p_a = ga * np.log(lam_a) - lam_a - np.array([math.lgamma(g + 1) for g in ga])

    # DC correction (only matters for {0,0}, {1,0}, {0,1}, {1,1})
    tau_log = np.zeros_like(lam_h)
    mask_00 = (gh == 0) & (ga == 0)
    mask_01 = (gh == 0) & (ga == 1)
    mask_10 = (gh == 1) & (ga == 0)
    mask_11 = (gh == 1) & (ga == 1)
    tau_00 = 1.0 - lam_h[mask_00] * lam_a[mask_00] * rho
    tau_01 = 1.0 + lam_h[mask_01] * rho
    tau_10 = 1.0 + lam_a[mask_10] * rho
    tau_11 = 1.0 - rho
    # Tau must stay positive; if rho makes it non-positive, the parameter is bad
    if (tau_00 <= 0).any() or (tau_01 <= 0).any() or (tau_10 <= 0).any() or tau_11 <= 0:
        return 1e10
    tau_log[mask_00] = np.log(tau_00)
    tau_log[mask_01] = np.log(tau_01)
    tau_log[mask_10] = np.log(tau_10)
    tau_log[mask_11] = np.log(tau_11)

    log_p = log_p_h + log_p_a + tau_log
    return -float((weights * log_p).sum())


def fit_dixon_coles(
    league: str,
    conn: sqlite3.Connection,
    reference_date: Optional[str] = None,
    train_before: Optional[str] = None,
) -> Optional[DCFit]:
    """Fit the Dixon-Coles model for one league. Returns None when data is
    insufficient.

    train_before — pass a date string to enforce a hard cutoff (used by the
    backtest to prevent leakage). When set, ONLY matches strictly before
    this date are used to fit.
    """
    teams, home_idx, away_idx, gh, ga, weights = _build_match_arrays(
        league, conn, reference_date, train_before=train_before,
    )
    if not teams or len(home_idx) < 50:
        print(f"  [model] {league}: insufficient data ({len(home_idx)} matches)", file=sys.stderr)
        return None

    n_teams = len(teams)

    # Initial guess: every team at 1.0, γ at 1.3 (typical home advantage), rho at -0.1
    init = np.concatenate([
        np.ones(n_teams - 1),       # alpha free params
        np.ones(n_teams - 1),       # delta free params
        np.array([math.log(1.3)]),  # log(gamma)
        np.array([-0.1]),           # rho
    ])

    result = minimize(
        _neg_log_likelihood,
        init,
        args=(home_idx, away_idx, gh, ga, weights, n_teams),
        method="L-BFGS-B",
        options={"maxiter": 500, "ftol": 1e-8},
    )

    if not result.success:
        print(f"  [model] {league}: optimizer non-convergence — {result.message}", file=sys.stderr)
        # Still return whatever it found; the params are usually usable

    params = result.x
    alpha_free = params[:n_teams - 1]
    delta_free = params[n_teams - 1: 2 * (n_teams - 1)]
    alpha_arr  = np.concatenate([alpha_free, [n_teams - alpha_free.sum()]])
    delta_arr  = np.concatenate([delta_free, [n_teams - delta_free.sum()]])

    return DCFit(
        league=league,
        alpha={teams[i]: float(alpha_arr[i]) for i in range(n_teams)},
        delta={teams[i]: float(delta_arr[i]) for i in range(n_teams)},
        gamma=float(math.exp(params[-2])),
        rho=float(params[-1]),
        log_likelihood=-float(result.fun),
        n_matches=int(len(home_idx)),
        n_teams=n_teams,
        fit_at=datetime.now(timezone.utc).isoformat(),
    )


# ── Match prediction ─────────────────────────────────────────────────────────

def _scoreline_matrix(
    lambda_h: float, lambda_a: float, rho: float,
    max_goals: int = 8,
) -> np.ndarray:
    """Probability of each (x, y) scoreline up to max_goals each."""
    # Pure Poisson outer product
    pmf_h = poisson.pmf(np.arange(max_goals + 1), lambda_h)
    pmf_a = poisson.pmf(np.arange(max_goals + 1), lambda_a)
    M = np.outer(pmf_h, pmf_a)
    # DC correction on the 4 low-score cells
    M[0, 0] *= 1.0 - lambda_h * lambda_a * rho
    M[0, 1] *= 1.0 + lambda_h * rho
    M[1, 0] *= 1.0 + lambda_a * rho
    M[1, 1] *= 1.0 - rho
    # Renormalize since DC adjustment perturbs total
    M = M / M.sum()
    return M


# ── Day 4 adjustments — applied at prediction time, on top of base DC fit ──
#
# SoT divergence:
#   If a team has been generating shots-on-target above what their actual
#   goal rate implies, they're "due" (regression upward). And vice versa.
#   We use this as a soft multiplier on the team's α at prediction time.
#
# Ref tendency (EPL-only, where ref data exists):
#   High-card refs raise red-card risk → games with 10-vs-11 stretches
#   skew unders. Modest λ multiplier downward.
#
# Both adjustments are clamped to keep the model honest — no individual
# feature can move λ by more than ~25%.

SOT_ADJ_LOOKBACK_MATCHES = 10
SOT_ADJ_MIN_MATCHES      = 5          # Need at least this many to compute
SOT_ADJ_MIN_MULT         = 0.85
SOT_ADJ_MAX_MULT         = 1.20
REF_ADJ_MIN_MULT         = 0.92
REF_ADJ_MAX_MULT         = 1.08


# ── Understat xG prior adjustments ─────────────────────────────────────────
# The Dixon-Coles α/δ are fit from actual GOALS over historical matches.
# xG is the gold-standard predictive metric for soccer — it measures shot
# quality, which is more predictive of FUTURE goal output than past goals
# (which include luck / variance).
#
# When a team's recent xG diverges from their recent goals, our DC α/δ
# is mis-calibrated:
#   • xG_for/match > goals_for/match → team's been UNLUCKY → α should be higher
#   • xG_for/match < goals_for/match → team's been LUCKY → α should be lower
#   • xG_against/match > goals_against → defense is BETTER than results show
#   • xG_against/match < goals_against → defense is WORSE than results show
#
# We use Understat's pre-cached `soccer_source_team_match_stats` (3,500+
# rows of real xG_for / xG_against / np_xG per match across Big 5 since
# at least 2024-25). No live scraping at predict time.
#
# Output: two multipliers per team — xg_alpha_mult (regress own α toward
# xG-implied) and xg_delta_mult (regress own δ toward xG-against-implied).

# Map our DC league names to Understat's "ISO3-LEAGUE" convention used in
# the soccer_source_team_match_stats.league column.
_UNDERSTAT_LEAGUE_MAP: Dict[str, str] = {
    "Premier League": "ENG-Premier League",
    "La Liga":        "ESP-La Liga",
    "Bundesliga":     "GER-Bundesliga",
    "Serie A":        "ITA-Serie A",
    "Ligue 1":        "FRA-Ligue 1",
}

XG_LOOKBACK_MATCHES = 12
XG_MIN_MATCHES      = 5
XG_ADJ_MIN          = 0.85
XG_ADJ_MAX          = 1.15


def _tokenize_team(name: str) -> set:
    """Lowercase non-stopword tokens of length ≥ 3."""
    import re as _re
    STOP = {"fc", "afc", "cf", "sc", "the", "ac", "as", "rc", "sv", "club", "de"}
    return {
        t for t in _re.split(r"\W+", (name or "").lower())
        if t and t not in STOP and len(t) >= 3
    }


def _tokens_compatible(qtokens: set, ttokens: set) -> Tuple[bool, int]:
    """Token compatibility with prefix-aware matching.

    Returns (compatible, overlap_count). A query token "matches" a team
    token if they're equal OR if the shorter is a prefix of the longer
    (≥ 3 chars). This catches "Man United" → "Manchester United"
    ("man" is a prefix of "manchester") while still rejecting
    "Saint Etienne" → "Paris Saint Germain" (only "saint" overlaps
    out of two query tokens).

    `compatible` = at least one side's tokens are FULLY covered by
    the other side (q_coverage or t_coverage == 1.0). Same rule as the
    plain token-set match used by the Sportmonks resolver.
    """
    if not qtokens or not ttokens:
        return False, 0

    def prefix_match(a: str, b: str) -> bool:
        if a == b:
            return True
        if len(a) < 3 or len(b) < 3:
            return False
        shorter, longer = (a, b) if len(a) < len(b) else (b, a)
        return longer.startswith(shorter)

    matched_q = 0
    for q in qtokens:
        for t in ttokens:
            if prefix_match(q, t):
                matched_q += 1
                break
    matched_t = 0
    for t in ttokens:
        for q in qtokens:
            if prefix_match(q, t):
                matched_t += 1
                break

    q_cov = matched_q / len(qtokens)
    t_cov = matched_t / len(ttokens)
    overlap = max(matched_q, matched_t)
    return (q_cov >= 1.0 or t_cov >= 1.0), overlap


def _understat_team_name(
    fit_team: str, understat_league: str, conn: sqlite3.Connection,
    before_date: Optional[str] = None,
) -> Optional[str]:
    """Resolve a DC fit team name to the corresponding Understat team name
    via exact / substring / token-overlap (with prefix-awareness) match.
    None when no Understat rows exist for this team (in which case the
    xG adjustment no-ops to 1.0 and we fall back to SoT)."""
    if not fit_team:
        return None

    lname = fit_team.lower().strip()
    date_filter = " AND match_date < ?" if before_date else ""
    date_args = (before_date,) if before_date else ()

    # Exact + substring
    row = conn.execute(
        f"""SELECT DISTINCT team FROM soccer_source_team_match_stats
           WHERE league = ?
             AND (LOWER(team) = ? OR LOWER(team) LIKE ? OR ? LIKE '%' || LOWER(team) || '%')
             {date_filter}
           LIMIT 1""",
        (understat_league, lname, f"%{lname}%", lname) + date_args,
    ).fetchone()
    if row:
        return row[0]

    # Token-overlap with prefix matching
    qtokens = _tokenize_team(lname)
    if not qtokens:
        return None

    all_teams = conn.execute(
        f"""SELECT DISTINCT team FROM soccer_source_team_match_stats
           WHERE league = ? {date_filter}""",
        (understat_league,) + date_args,
    ).fetchall()

    best_match = None
    best_overlap = 0
    for tr in all_teams:
        ttokens = _tokenize_team(tr[0] or "")
        ok, overlap = _tokens_compatible(qtokens, ttokens)
        if ok and overlap > best_overlap:
            best_overlap = overlap
            best_match = tr[0]
    return best_match


def _league_xg_baselines(
    understat_league: str, conn: sqlite3.Connection,
    before_date: Optional[str] = None,
) -> Tuple[float, float]:
    """League-wide rolling xG-for and xG-against per match. Used as the
    baseline to regress team xG toward."""
    date_filter = " AND match_date < ?" if before_date else ""
    date_args = (before_date,) if before_date else ()
    r = conn.execute(
        f"""SELECT AVG(xg_for) AS avg_xgf, AVG(xg_against) AS avg_xga
           FROM soccer_source_team_match_stats
           WHERE league = ? AND xg_for IS NOT NULL AND xg_against IS NOT NULL
                 {date_filter}""",
        (understat_league,) + date_args,
    ).fetchone()
    if not r or r["avg_xgf"] is None:
        # Reasonable global priors when league has no Understat data
        return 1.40, 1.40
    return float(r["avg_xgf"]), float(r["avg_xga"])


def _xg_prior_adjustment(
    fit_team: str, league: str, conn: sqlite3.Connection,
    before_date: Optional[str] = None,
) -> Tuple[float, float, Dict[str, Any]]:
    """Compute team xG-based α and δ prior multipliers.

    Returns (alpha_mult, delta_mult, trace):
      - alpha_mult adjusts the team's OWN attacking strength. >1.0 means
        the team's xG-for has been higher than their recent goals suggest
        → unlucky finishing, expected regression upward.
      - delta_mult adjusts the team's OWN defensive strength. Note δ
        convention in our fit: LOWER δ = better defense. So a delta_mult
        > 1.0 means the team's defense has been WORSE than goals show
        (conceded high xG, opponent finishing was poor) → expected
        regression toward conceding more.
      - trace shows the matched team name + counts + raw vs clamped.

    Both clamped to [0.85, 1.15]. No-op (1.0, 1.0) when team has fewer
    than XG_MIN_MATCHES of recent xG data.

    Same `before_date` leakage protocol used elsewhere in the model.
    """
    understat_league = _UNDERSTAT_LEAGUE_MAP.get(league)
    if not understat_league:
        return 1.0, 1.0, {"reason": "league-not-in-understat-map"}

    us_team = _understat_team_name(fit_team, understat_league, conn, before_date)
    if not us_team:
        return 1.0, 1.0, {"reason": "team-not-in-understat"}

    date_filter = " AND match_date < ?" if before_date else ""
    date_args = (before_date,) if before_date else ()
    rows = conn.execute(
        f"""SELECT goals_for, goals_against, xg_for, xg_against
           FROM soccer_source_team_match_stats
           WHERE league = ? AND team = ?
                 AND xg_for IS NOT NULL AND xg_against IS NOT NULL
                 {date_filter}
           ORDER BY match_date DESC LIMIT ?""",
        (understat_league, us_team) + date_args + (XG_LOOKBACK_MATCHES,),
    ).fetchall()
    if len(rows) < XG_MIN_MATCHES:
        return 1.0, 1.0, {"reason": "insufficient-xg-history",
                           "team": us_team, "n_matches": len(rows)}

    n = len(rows)
    team_xg_for_pg     = sum((r["xg_for"]      or 0) for r in rows) / n
    team_xg_against_pg = sum((r["xg_against"]  or 0) for r in rows) / n
    team_g_for_pg      = sum((r["goals_for"]   or 0) for r in rows) / n
    team_g_against_pg  = sum((r["goals_against"] or 0) for r in rows) / n

    league_xg_for, league_xg_against = _league_xg_baselines(
        understat_league, conn, before_date,
    )

    # α (attack) prior — team's xG_for relative to league baseline,
    # blended with the team's actual goal output. Sqrt softens the
    # adjustment so extreme single-match runs don't dominate.
    if league_xg_for <= 0 or team_g_for_pg <= 0:
        alpha_raw = 1.0
    else:
        # If xG > actual, team is due upward regression → alpha_mult > 1
        # If xG < actual, team's finishing has been hot → alpha_mult < 1
        alpha_raw = (team_xg_for_pg / team_g_for_pg) ** 0.5
    alpha_mult = max(XG_ADJ_MIN, min(XG_ADJ_MAX, alpha_raw))

    # δ (defense) prior — same logic on the conceded side. Note:
    # higher delta_mult = MORE goals conceded expected (defense worse
    # than recent results suggest).
    if team_g_against_pg <= 0:
        delta_raw = 1.0
    else:
        delta_raw = (team_xg_against_pg / team_g_against_pg) ** 0.5
    delta_mult = max(XG_ADJ_MIN, min(XG_ADJ_MAX, delta_raw))

    return alpha_mult, delta_mult, {
        "team":              us_team,
        "matched_dc_name":   fit_team,
        "n_matches":         n,
        "team_xg_for_pg":    round(team_xg_for_pg, 3),
        "team_g_for_pg":     round(team_g_for_pg, 3),
        "team_xg_against_pg": round(team_xg_against_pg, 3),
        "team_g_against_pg":  round(team_g_against_pg, 3),
        "league_xg_for_pg":  round(league_xg_for, 3),
        "league_xg_against_pg": round(league_xg_against, 3),
        "alpha_raw":         round(alpha_raw, 4),
        "alpha_clamped":     round(alpha_mult, 4),
        "delta_raw":         round(delta_raw, 4),
        "delta_clamped":     round(delta_mult, 4),
    }


def _league_sot_conversion(
    league: str, conn: sqlite3.Connection, before_date: Optional[str] = None,
) -> float:
    """League-wide conversion rate: total goals / total SoT. Used as the
    baseline for converting team SoT into expected goals.

    `before_date` enforces no-leakage in backtests by excluding future rows
    from the league baseline itself, not just the team lookbacks.
    """
    date_filter = "AND match_date < ?" if before_date else ""
    date_args = (before_date,) if before_date else ()
    r = conn.execute(
        f"""SELECT SUM(goals_for) AS g, SUM(sot) AS s
           FROM soccer_team_form
           WHERE league = ? AND sot IS NOT NULL AND sot > 0 {date_filter}""",
        (league,) + date_args,
    ).fetchone()
    if not r or not r["s"]:
        return 0.32  # global empirical default
    return float(r["g"]) / float(r["s"])


def _team_sot_adjustment(
    team: str, league: str, conn: sqlite3.Connection,
    league_conversion: float,
    before_date: Optional[str] = None,
) -> float:
    """Returns multiplier on team's α based on recent SoT vs actual-goals
    divergence. > 1 = team's "true" attacking ability is higher than recent
    goals suggest (positive regression). < 1 = team's true ability is lower."""
    before = before_date or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    rows = conn.execute(
        """SELECT goals_for, sot
           FROM soccer_team_form
           WHERE team_name = ? AND league = ? AND match_date < ?
                 AND sot IS NOT NULL
           ORDER BY match_date DESC LIMIT ?""",
        (team, league, before, SOT_ADJ_LOOKBACK_MATCHES),
    ).fetchall()
    if len(rows) < SOT_ADJ_MIN_MATCHES:
        return 1.0

    total_g   = sum((r["goals_for"] or 0) for r in rows)
    total_sot = sum((r["sot"]       or 0) for r in rows)
    if total_sot == 0:
        return 1.0

    actual_rate    = total_g / total_sot
    # "Expected" rate is the league-wide conversion — anything above
    # the league means lucky finishing, below means unlucky finishing.
    # We want to nudge α UP for unlucky teams, DOWN for lucky teams.
    if actual_rate <= 0:
        return SOT_ADJ_MAX_MULT  # zero goals on positive SoT — strong regression up
    ratio = league_conversion / actual_rate
    # Soften the adjustment — sqrt brings extremes toward 1.0
    mult = ratio ** 0.5
    return max(SOT_ADJ_MIN_MULT, min(SOT_ADJ_MAX_MULT, mult))


def _find_snapshot_team(
    team_name: str, conn: sqlite3.Connection,
    before_date: Optional[str] = None,
) -> Optional[str]:
    """Resolve a query team name to the canonical name used in the Sportmonks
    snapshot. Returns None if no matching team has a snapshot row (gated by
    `before_date` when given — used for no-leakage during backtests).

    Match strategy:
      1. Exact case-insensitive match
      2. Substring fuzzy match (either direction)
      3. Token-overlap fallback with FULL coverage rule — "Paris SG" matches
         "Paris Saint Germain" because {paris} ⊆ {paris,saint,germain},
         but "Saint Etienne" does NOT match because only 1/2 query tokens
         overlap.

    Shared by both lineup-availability adjustments (attack & defense) so they
    use identical team resolution and the leakage gate is enforced once.
    """
    if not team_name:
        return None

    lname = team_name.lower().strip()
    date_filter = " AND updated_at < ?" if before_date else ""
    date_args = (before_date,) if before_date else ()

    candidates = conn.execute(
        f"""SELECT DISTINCT team FROM soccer_player_feature_snapshot
           WHERE (LOWER(team) = ? OR LOWER(team) LIKE ? OR ? LIKE '%' || LOWER(team) || '%')
                 {date_filter}""",
        (lname, f"%{lname}%", lname) + date_args,
    ).fetchall()

    if candidates:
        return candidates[0][0]

    # Token-overlap fallback
    import re as _re
    STOP = {"fc", "afc", "cf", "sc", "the", "ac", "as", "rc", "sv", "club", "de"}
    qtokens = {
        t for t in _re.split(r"\W+", lname)
        if t and t not in STOP and len(t) >= 3
    }
    if not qtokens:
        return None

    all_teams = conn.execute(
        f"""SELECT DISTINCT team FROM soccer_player_feature_snapshot
           WHERE 1=1 {date_filter}""",
        date_args,
    ).fetchall()

    best_match = None
    best_overlap = 0
    for row in all_teams:
        tname = (row[0] or "").lower().strip()
        ttokens = {
            t for t in _re.split(r"\W+", tname)
            if t and t not in STOP and len(t) >= 3
        }
        if not ttokens:
            continue
        overlap = len(qtokens & ttokens)
        if overlap == 0:
            continue
        q_coverage = overlap / len(qtokens)
        t_coverage = overlap / len(ttokens)
        if (q_coverage >= 1.0 or t_coverage >= 1.0) and overlap > best_overlap:
            best_overlap = overlap
            best_match = row[0]
    return best_match


def _lineup_availability_adjustment(
    team_name: str, conn: sqlite3.Connection,
    before_date: Optional[str] = None,
) -> Tuple[float, Dict[str, Any]]:
    """Compute team α multiplier from Sportmonks player feature snapshot.

    The data lives in soccer_player_feature_snapshot — every player on the
    matchday squad has lineup_status (confirmed_starting / bench / out)
    plus attack_role_score (0-1, 1.0 = team's top attacker) and
    projected_minutes.

    Multiplier = available_attack / expected_attack where:
      - confirmed_starting: weight = attack_role × (projected_minutes / 90)
      - bench / confirmed_bench: weight = attack_role × 0.25 (sub appearance)
      - out / sidelined / suspended / injured: weight = 0
      - unknown lineup_status: weight = attack_role × 0.70 (gentle penalty)

    Returns (multiplier, trace) where trace logs what data was used.

    Falls back to 1.0 (no-op) when no snapshot exists for the team.
    Clamped to [0.75, 1.10] to prevent extreme swings on small snapshots.

    Team name matching is fuzzy — Sportmonks uses "Paris Saint Germain"
    while our fitted model uses "Paris SG". We try exact match first,
    then case-insensitive contains either direction.

    `before_date` enforces no-leakage during backtests. The snapshot table
    has no fixture/match-date binding — only `updated_at`. So a historical
    backtest of a 2026-05-24 match would otherwise pick up snapshots refreshed
    AFTER that date (e.g. the next matchday's lineup). When `before_date`
    is provided, only snapshots with updated_at strictly before it are
    eligible; if none qualify, the multiplier no-ops to 1.0.
    """
    if not team_name:
        return 1.0, {}

    sb_team = _find_snapshot_team(team_name, conn, before_date=before_date)
    if not sb_team:
        return 1.0, {"reason": "no-snapshot"}

    date_filter = " AND updated_at < ?" if before_date else ""
    date_args = (before_date,) if before_date else ()
    rows = conn.execute(
        f"""SELECT player_name, lineup_status, attack_role_score,
                  is_attacking_role, projected_minutes, unavailable_reason
           FROM soccer_player_feature_snapshot
           WHERE team = ? {date_filter}""",
        (sb_team,) + date_args,
    ).fetchall()
    if not rows:
        return 1.0, {"reason": "snapshot-empty"}

    expected = 0.0
    available = 0.0
    n_out_attackers = 0
    for r in rows:
        role = float(r["attack_role_score"] or 0)
        if role <= 0:
            continue  # Players w/ no attack contribution don't matter for α
        expected += role
        status = (r["lineup_status"] or "").lower()
        mins = float(r["projected_minutes"] or 0)
        if status == "confirmed_starting":
            # Sportmonks's projected_minutes defaults to ~78 for any
            # starter — a placeholder, not an explicit sub-off prediction.
            # Only scale below 60 mins (signal of a planned short cameo).
            # Above 60: treat as a full-shift starter at full weight.
            available += role * (1.0 if mins >= 60 else (mins / 90.0))
        elif status in ("confirmed_bench", "bench"):
            available += role * 0.25
        elif status in ("out", "sidelined", "injured", "suspended", "doubtful"):
            available += 0.0
            if role >= 0.6:  # losing a top attacker is significant
                n_out_attackers += 1
        else:
            available += role * 0.70

    if expected <= 0:
        return 1.0, {"reason": "no-attack-roles", "team": sb_team}

    raw_mult = available / expected
    mult = max(0.75, min(1.10, raw_mult))
    return mult, {
        "team":               sb_team,
        "matched_team_name":  team_name,
        "expected_attack":    round(expected, 3),
        "available_attack":   round(available, 3),
        "raw_multiplier":     round(raw_mult, 4),
        "clamped_multiplier": round(mult, 4),
        "key_attackers_out":  n_out_attackers,
    }


# ── Defensive lineup vulnerability ─────────────────────────────────────────
# Complements _lineup_availability_adjustment, which targets α (attack).
# This produces a multiplier > 1.0 applied to the OPPONENT's λ when the
# team's defenders or goalkeeper are unavailable — losing defenders
# concedes more goals.
#
# Position weights (per snapshot's position_bucket):
#   goalkeeper → 1.0  (only 1 GK; an unavailable starter is a big hit)
#   defender   → 0.5  (4 typical starters; lose one ≈ 12-13% of defense)
# Other positions don't contribute to defensive coverage and are ignored.

_DEFENSIVE_POSITION_WEIGHTS: Dict[str, float] = {
    "goalkeeper": 1.0,
    "defender":   0.5,
}


def _lineup_defensive_availability_adjustment(
    team_name: str, conn: sqlite3.Connection,
    before_date: Optional[str] = None,
) -> Tuple[float, Dict[str, Any]]:
    """Compute opponent-λ multiplier reflecting this team's defensive
    fragility. Returns (vulnerability_multiplier, trace).

    Logic mirrors the attack adjustment but inverts the math: when the
    coverage of expected defensive players drops, the OPPONENT scores
    more, so we return a multiplier ≥ 1.0 that callers apply to the
    opponent's λ.

    multiplier = clamp(expected_defense / available_defense, 0.95, 1.20)

    Same `before_date` leakage gate as the attack adjustment.
    Returns (1.0, {"reason": "no-snapshot"}) when no usable snapshot.
    """
    if not team_name:
        return 1.0, {}

    sb_team = _find_snapshot_team(team_name, conn, before_date=before_date)
    if not sb_team:
        return 1.0, {"reason": "no-snapshot"}

    date_filter = " AND updated_at < ?" if before_date else ""
    date_args = (before_date,) if before_date else ()
    rows = conn.execute(
        f"""SELECT lineup_status, position_bucket, projected_minutes,
                  player_name, attack_role_score
           FROM soccer_player_feature_snapshot
           WHERE team = ? AND position_bucket IN ('defender', 'goalkeeper')
                 {date_filter}""",
        (sb_team,) + date_args,
    ).fetchall()

    if not rows:
        return 1.0, {"reason": "no-defensive-players", "team": sb_team}

    expected = 0.0
    available = 0.0
    keepers_out = 0
    defenders_out = 0
    for r in rows:
        pos = (r["position_bucket"] or "").lower()
        weight = _DEFENSIVE_POSITION_WEIGHTS.get(pos, 0.0)
        if weight <= 0:
            continue
        status = (r["lineup_status"] or "").lower()
        mins = float(r["projected_minutes"] or 0)

        if status == "confirmed_starting":
            # Same calibration as attack: Sportmonks default mins=78 is a
            # placeholder, not real per-player projection. Treat starters
            # at full weight unless mins < 60 (signals a real cameo).
            expected += weight
            available += weight * (1.0 if mins >= 60 else (mins / 90.0))
        elif status in ("out", "sidelined", "injured", "suspended", "doubtful"):
            # The player would have started; they don't anymore.
            # Penalize fully (they contribute 0 to available).
            expected += weight
            if pos == "goalkeeper":
                keepers_out += 1
            else:
                defenders_out += 1
        elif status in ("bench", "confirmed_bench"):
            # Bench defenders aren't expected starters; small partial credit
            # if they get on the field as a late sub.
            available += weight * 0.15
        else:
            # Unknown status — gentle prior, half weight either way
            expected += weight * 0.5
            available += weight * 0.5 * 0.70

    if expected <= 0:
        return 1.0, {"reason": "no-defensive-roles", "team": sb_team}

    coverage = available / expected
    # Inverse: less defense = more goals expected against this team.
    # Cap at 1.20 — even a missing keeper can't justify a 50% λ bump in v1.
    raw_vuln = (1.0 / coverage) if coverage > 0 else 1.20
    vuln = max(0.95, min(1.20, raw_vuln))

    return vuln, {
        "team":                  sb_team,
        "matched_team_name":     team_name,
        "expected_defense":      round(expected, 3),
        "available_defense":     round(available, 3),
        "coverage":              round(coverage, 4),
        "raw_vulnerability":     round(raw_vuln, 4),
        "clamped_vulnerability": round(vuln, 4),
        "keepers_out":           keepers_out,
        "defenders_out":         defenders_out,
    }


def _ref_card_adjustment(
    referee: Optional[str], league: str, conn: sqlite3.Connection,
    before_date: Optional[str] = None,
) -> float:
    """Returns a multiplier reflecting the referee's card-issuing tendency.
    High-card refs slightly depress λ (because games where someone goes off
    on a red have lower scoring on average — fewer players = lower xG).

    Only computes when we have enough history on this ref (≥10 matches).
    `before_date` enforces no-leakage during backtest.
    """
    if not referee:
        return 1.0
    date_filter = "AND match_date < ?" if before_date else ""
    date_args   = (before_date,) if before_date else ()
    # Per-ref cards-per-match for this league
    r = conn.execute(
        f"""SELECT
               COUNT(*) AS n,
               AVG(yellows + yellows_against) AS yc_avg,
               AVG(reds + reds_against)       AS rc_avg
           FROM soccer_team_form
           WHERE league = ? AND referee = ? AND venue = 'home' {date_filter}""",
        (league, referee) + date_args,
    ).fetchone()
    if not r or (r["n"] or 0) < 10:
        return 1.0
    # League baseline for comparison
    base = conn.execute(
        f"""SELECT
               AVG(yellows + yellows_against) AS yc_avg,
               AVG(reds + reds_against)       AS rc_avg
           FROM soccer_team_form
           WHERE league = ? AND referee IS NOT NULL AND venue = 'home' {date_filter}""",
        (league,) + date_args,
    ).fetchone()
    if not base or (base["yc_avg"] or 0) <= 0:
        return 1.0

    yc_z = (r["yc_avg"] - base["yc_avg"]) / base["yc_avg"]    # +0.2 = 20% more cards than avg
    rc_z = (r["rc_avg"] - base["rc_avg"]) / (base["rc_avg"] + 1e-6)
    # Red cards have more impact than yellows on scoring
    combined = 0.3 * yc_z + 0.7 * rc_z
    mult = 1.0 - 0.05 * combined  # heavy-card refs → 5% λ depression at z=1
    return max(REF_ADJ_MIN_MULT, min(REF_ADJ_MAX_MULT, mult))


# ── Calibration shrinkage ────────────────────────────────────────────────────
# v0 backtest showed the model is over-confident on favorites and slightly
# under-confident on long-shots (classic v1 under-featured model behavior).
# Log-odds shrinkage toward 0 (= toward p=0.5) symmetrically corrects both:
#   shrunk_p = sigmoid( logit(p) × shrinkage_factor )
# Factor < 1.0 pulls toward the center; 1.0 = no change; 0.0 = constant 0.5.
# Tuned by re-running the holdout backtest; values around 0.65-0.80 are
# typical for under-featured DC models per literature (Karlis & Ntzoufras 2003).
SHRINKAGE_FACTOR_1X2    = 0.72   # tuned for 1X2 over-confidence pattern
SHRINKAGE_FACTOR_TOTALS = 0.80   # totals were closer to calibrated
SHRINKAGE_FACTOR_BTTS   = 0.85


def _logit_shrink(p: float, factor: float) -> float:
    """Pull a probability toward 0.5 by `factor` in log-odds space.
    Robust to extreme values via clipping."""
    p = max(min(p, 1.0 - 1e-6), 1e-6)
    logit = math.log(p / (1.0 - p))
    return 1.0 / (1.0 + math.exp(-(logit * factor)))


def _shrink_1x2(p_home: float, p_draw: float, p_away: float) -> Tuple[float, float, float]:
    """Shrink each leg in log-odds space, then renormalize so they sum to 1."""
    h = _logit_shrink(p_home, SHRINKAGE_FACTOR_1X2)
    d = _logit_shrink(p_draw, SHRINKAGE_FACTOR_1X2)
    a = _logit_shrink(p_away, SHRINKAGE_FACTOR_1X2)
    total = h + d + a
    if total <= 0:
        return (1.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0)
    return (h / total, d / total, a / total)


def _shrink_two_way(p_over: float, p_under: float, factor: float) -> Tuple[float, float]:
    """Shrink each side and renormalize so they sum to 1."""
    o = _logit_shrink(p_over, factor)
    u = _logit_shrink(p_under, factor)
    total = o + u
    if total <= 0:
        return (0.5, 0.5)
    return (o / total, u / total)


def predict_match(
    fit: DCFit, home_team: str, away_team: str,
    league: Optional[str] = None,
    referee: Optional[str] = None,
    apply_adjustments: bool = True,
    apply_shrinkage: bool = True,
    conn: Optional[sqlite3.Connection] = None,
    before_date: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Returns full probability output for a match. None if either team
    not in the fitted dataset.

    When apply_adjustments=True and a connection is available, layers in:
      - Per-team SoT divergence adjustment on α
      - Per-ref card tendency adjustment on λ (only when referee given)
      - Per-team lineup-availability adjustment on α (Sportmonks player
        snapshot — confirmed_starting / bench / out × attack_role_score)

    `before_date` enforces no-leakage in backtests — the adjustments only
    look at data BEFORE this date when computing per-team / per-ref stats
    AND when reading the lineup snapshot table. Pass the match_date being
    predicted. None = use all available data (correct for live prediction).
    """
    a_h = fit.alpha.get(home_team)
    d_h = fit.delta.get(home_team)
    a_a = fit.alpha.get(away_team)
    d_a = fit.delta.get(away_team)
    if a_h is None or a_a is None or d_h is None or d_a is None:
        return None

    # Base lambdas from DC fit
    lam_h = a_h * d_a * fit.gamma
    lam_a = a_a * d_h

    # Day 4 + M7 + M8 + M9 adjustments — only when we have a DB to look at
    sot_mult_h = sot_mult_a = ref_mult = 1.0
    lineup_mult_h = lineup_mult_a = 1.0
    defense_vuln_h = defense_vuln_a = 1.0
    xg_alpha_h = xg_alpha_a = xg_delta_h = xg_delta_a = 1.0
    lineup_trace_h: Dict[str, Any] = {}
    lineup_trace_a: Dict[str, Any] = {}
    defense_trace_h: Dict[str, Any] = {}
    defense_trace_a: Dict[str, Any] = {}
    xg_trace_h: Dict[str, Any] = {}
    xg_trace_a: Dict[str, Any] = {}
    if apply_adjustments and league:
        owned_conn = conn is None
        c = conn or get_db()
        try:
            league_conv = _league_sot_conversion(league, c, before_date=before_date)
            sot_mult_h = _team_sot_adjustment(home_team, league, c, league_conv,
                                              before_date=before_date)
            sot_mult_a = _team_sot_adjustment(away_team, league, c, league_conv,
                                              before_date=before_date)
            ref_mult   = _ref_card_adjustment(referee, league, c,
                                              before_date=before_date)
            # M7: attack-side lineup adjustment — multiplies own α by share
            # of expected attacking strength actually available pre-match.
            lineup_mult_h, lineup_trace_h = _lineup_availability_adjustment(
                home_team, c, before_date=before_date,
            )
            lineup_mult_a, lineup_trace_a = _lineup_availability_adjustment(
                away_team, c, before_date=before_date,
            )
            # M8: defense-side vulnerability — when this team's defenders
            # or keeper are out, opponent's λ goes UP. Applied to the
            # OPPOSITE side's λ below.
            defense_vuln_h, defense_trace_h = _lineup_defensive_availability_adjustment(
                home_team, c, before_date=before_date,
            )
            defense_vuln_a, defense_trace_a = _lineup_defensive_availability_adjustment(
                away_team, c, before_date=before_date,
            )
            # M9: Understat xG priors. Regress α and δ toward what recent
            # xG suggests they should be. xg_alpha bumps own α when team
            # has been creating chances above their goal output. xg_delta
            # bumps own δ (toward 'weaker defense' direction) when team
            # has been conceding high-xG chances despite few goals against.
            xg_alpha_h, xg_delta_h, xg_trace_h = _xg_prior_adjustment(
                home_team, league, c, before_date=before_date,
            )
            xg_alpha_a, xg_delta_a, xg_trace_a = _xg_prior_adjustment(
                away_team, league, c, before_date=before_date,
            )
        finally:
            if owned_conn:
                c.close()
        # Attack multipliers act on own team's λ; defense vulnerability acts
        # on OPPONENT's λ. Ref multiplier dampens both sides equally.
        # xG α-prior multiplies own λ (their attacking output should be
        # regressed). xG δ-prior multiplies OPPONENT's λ (since a high
        # δ_mult means this team's defense is "weaker than results show",
        # which boosts the opponent's expected goals).
        lam_h *= sot_mult_h * lineup_mult_h * xg_alpha_h * defense_vuln_a * xg_delta_a * ref_mult
        lam_a *= sot_mult_a * lineup_mult_a * xg_alpha_a * defense_vuln_h * xg_delta_h * ref_mult

    M = _scoreline_matrix(lam_h, lam_a, fit.rho)

    # 1X2 raw probabilities (from Dixon-Coles + adjustments — uncalibrated)
    p_home_raw = float(np.tril(M, -1).sum())   # home_goals > away_goals (lower triangle)
    p_draw_raw = float(np.trace(M))            # diagonal
    p_away_raw = float(np.triu(M, 1).sum())    # home_goals < away_goals

    # Totals raw — P(total > k.5) for common lines
    raw_totals: Dict[str, float] = {}
    rows, cols = np.indices(M.shape)
    sum_grid = rows + cols
    for k in (0.5, 1.5, 2.5, 3.5, 4.5):
        raw_totals[f"over_{k}"]  = float(M[sum_grid > k].sum())
        raw_totals[f"under_{k}"] = float(M[sum_grid < k].sum())

    # BTTS raw
    btts_yes_raw = float(M[1:, 1:].sum())

    # ── Calibration shrinkage layer (v1 calibration fix) ──
    # The raw DC + adjustments output was over-confident on favorites per
    # held-out backtest. Log-odds shrinkage pulls extremes toward the center.
    if apply_shrinkage:
        p_home, p_draw, p_away = _shrink_1x2(p_home_raw, p_draw_raw, p_away_raw)
        totals: Dict[str, float] = {}
        for k in (0.5, 1.5, 2.5, 3.5, 4.5):
            o, u = _shrink_two_way(
                raw_totals[f"over_{k}"], raw_totals[f"under_{k}"],
                SHRINKAGE_FACTOR_TOTALS,
            )
            totals[f"over_{k}"]  = o
            totals[f"under_{k}"] = u
        btts_yes, btts_no = _shrink_two_way(
            btts_yes_raw, 1.0 - btts_yes_raw, SHRINKAGE_FACTOR_BTTS,
        )
    else:
        p_home, p_draw, p_away = p_home_raw, p_draw_raw, p_away_raw
        totals = raw_totals
        btts_yes = btts_yes_raw
        btts_no  = 1.0 - btts_yes_raw

    return {
        "home_team": home_team,
        "away_team": away_team,
        "lambda_h":  float(lam_h),
        "lambda_a":  float(lam_a),
        "p_home":    p_home,
        "p_draw":    p_draw,
        "p_away":    p_away,
        **totals,
        "btts_yes":  btts_yes,
        "btts_no":   btts_no,
        # Transparency block — raw model + adjustment trace before calibration
        "_adj":      {
            "sot_mult_h":            round(sot_mult_h, 4),
            "sot_mult_a":            round(sot_mult_a, 4),
            "ref_mult":              round(ref_mult, 4),
            "lineup_mult_h":         round(lineup_mult_h, 4),
            "lineup_mult_a":         round(lineup_mult_a, 4),
            "lineup_trace_h":        lineup_trace_h,
            "lineup_trace_a":        lineup_trace_a,
            "defense_vuln_h":        round(defense_vuln_h, 4),
            "defense_vuln_a":        round(defense_vuln_a, 4),
            "defense_trace_h":       defense_trace_h,
            "defense_trace_a":       defense_trace_a,
            "xg_alpha_h":            round(xg_alpha_h, 4),
            "xg_alpha_a":            round(xg_alpha_a, 4),
            "xg_delta_h":            round(xg_delta_h, 4),
            "xg_delta_a":            round(xg_delta_a, 4),
            "xg_trace_h":            xg_trace_h,
            "xg_trace_a":            xg_trace_a,
            "shrinkage":   {
                "applied":     apply_shrinkage,
                "factor_1x2":  SHRINKAGE_FACTOR_1X2,
                "factor_tot":  SHRINKAGE_FACTOR_TOTALS,
                "factor_btts": SHRINKAGE_FACTOR_BTTS,
            },
            "raw":         {
                "p_home":  round(p_home_raw, 4),
                "p_draw":  round(p_draw_raw, 4),
                "p_away":  round(p_away_raw, 4),
                "over_25": round(raw_totals["over_2.5"], 4),
                "btts":    round(btts_yes_raw, 4),
            },
        },
    }


# ── Persistence ──────────────────────────────────────────────────────────────

def save_fits(fits: Dict[str, DCFit], elos: Dict[str, EloState]) -> Path:
    """Pickle all fitted models + Elos. Single artifact file per build."""
    _ensure_artifacts_dir()
    path = MODEL_DIR / "soccer_model_v1.pkl"
    with open(path, "wb") as f:
        pickle.dump({
            "dc_fits":  {k: v.to_dict() for k, v in fits.items()},
            "elos":     {k: {"ratings": v.ratings, "league": v.league,
                             "last_match_date": v.last_match_date,
                             "matches_processed": v.matches_processed}
                         for k, v in elos.items()},
            "saved_at": datetime.now(timezone.utc).isoformat(),
            "version":  "v1.0",
        }, f)
    return path


def load_fits() -> Tuple[Dict[str, DCFit], Dict[str, EloState]]:
    """Load persisted model state. Empty dicts if no model has been fit yet."""
    path = MODEL_DIR / "soccer_model_v1.pkl"
    if not path.exists():
        return {}, {}
    with open(path, "rb") as f:
        d = pickle.load(f)
    fits = {k: DCFit.from_dict(v) for k, v in d["dc_fits"].items()}
    elos = {k: EloState(**v) for k, v in d["elos"].items()}
    return fits, elos


# ── Orchestration ────────────────────────────────────────────────────────────

LEAGUES_TO_FIT = ["Premier League", "La Liga", "Bundesliga", "Serie A", "Ligue 1"]


def fit_and_save(
    leagues: Optional[List[str]] = None,
    reference_date: Optional[str] = None,
    db_path: Optional[Path] = None,
) -> Dict[str, Any]:
    """Train Elo + Dixon-Coles for every Big-5 league. Persist to disk.
    Returns a summary dict."""
    leagues = leagues or LEAGUES_TO_FIT
    conn = get_db(db_path)
    fits: Dict[str, DCFit] = {}
    elos: Dict[str, EloState] = {}
    summary: Dict[str, Any] = {}

    for league in leagues:
        print(f"  [model] Fitting {league}…", flush=True)
        # Elo
        elos[league] = compute_elo_for_league(league, conn)
        print(f"  [model] {league} Elo: {elos[league].matches_processed} matches, "
              f"{len(elos[league].ratings)} teams", flush=True)
        # Dixon-Coles
        fit = fit_dixon_coles(league, conn, reference_date)
        if fit is None:
            summary[league] = {"status": "failed"}
            continue
        fits[league] = fit
        summary[league] = {
            "status":          "ok",
            "n_matches":       fit.n_matches,
            "n_teams":         fit.n_teams,
            "gamma":           round(fit.gamma, 3),
            "rho":             round(fit.rho, 3),
            "log_likelihood":  round(fit.log_likelihood, 1),
        }
        print(f"  [model] {league} DC: γ={fit.gamma:.3f} ρ={fit.rho:.3f} "
              f"log-L={fit.log_likelihood:.0f}", flush=True)

    conn.close()
    path = save_fits(fits, elos)
    print(f"  [model] Saved to {path}", flush=True)
    summary["saved_to"] = str(path)
    return summary


def show_team_rankings(league: str, top_n: int = 10) -> List[Dict[str, Any]]:
    """Sanity-check view — Elo + DC strength rankings for a league."""
    fits, elos = load_fits()
    if league not in fits:
        return []
    fit = fits[league]
    elo = elos.get(league, EloState({}, league, "—", 0))

    teams = list(fit.alpha.keys())
    rows = []
    for t in teams:
        rows.append({
            "team":      t,
            "elo":       round(elo.ratings.get(t, ELO_INITIAL), 1),
            "alpha":     round(fit.alpha[t], 3),
            "delta":     round(fit.delta[t], 3),
            "strength":  round(fit.alpha[t] / fit.delta[t], 3),
        })
    rows.sort(key=lambda r: -r["strength"])
    return rows[:top_n]


# ── CLI ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "fit"

    if cmd == "fit":
        s = fit_and_save()
        print(f"\n[model] Fit summary:\n{json.dumps(s, indent=2)}")
    elif cmd == "rankings":
        for lg in LEAGUES_TO_FIT:
            print(f"\n=== {lg} — top 10 by strength (α / δ) ===")
            for r in show_team_rankings(lg, top_n=10):
                print(f"  {r['team']:25s}  Elo {r['elo']:6.1f}   "
                      f"α={r['alpha']:.3f}  δ={r['delta']:.3f}   "
                      f"strength={r['strength']:.3f}")
    elif cmd.startswith("predict:"):
        # predict:Liverpool:Brighton:Premier League:OptionalRefName
        parts = cmd.split(":", 4)
        home, away, league = parts[1], parts[2], parts[3]
        referee = parts[4] if len(parts) > 4 else None
        fits, _ = load_fits()
        if league not in fits:
            print(f"League not fit: {league}", file=sys.stderr); sys.exit(1)
        p = predict_match(fits[league], home, away, league=league, referee=referee)
        print(json.dumps(p, indent=2))
    else:
        print("usage: python3 -m ml.soccer.model [fit|rankings|predict:<home>:<away>:<league>]",
              file=sys.stderr)
        sys.exit(1)
