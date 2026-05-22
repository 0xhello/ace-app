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
) -> Tuple[List[str], np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Pull all home-perspective matches for a league. Returns:
        teams       — ordered list of unique team names
        home_idx    — int array, home team index per match
        away_idx    — int array, away team index per match
        goals_h     — int array of home goals
        goals_a     — int array of away goals
        weights     — recency weights per match
    """
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
) -> Optional[DCFit]:
    """Fit the Dixon-Coles model for one league. Returns None when data is
    insufficient."""
    teams, home_idx, away_idx, gh, ga, weights = _build_match_arrays(
        league, conn, reference_date,
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


def _league_sot_conversion(league: str, conn: sqlite3.Connection) -> float:
    """League-wide conversion rate: total goals / total SoT. Used as the
    baseline for converting team SoT into expected goals."""
    r = conn.execute(
        """SELECT SUM(goals_for) AS g, SUM(sot) AS s
           FROM soccer_team_form
           WHERE league = ? AND sot IS NOT NULL AND sot > 0""",
        (league,),
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


def _ref_card_adjustment(
    referee: Optional[str], league: str, conn: sqlite3.Connection,
) -> float:
    """Returns a multiplier reflecting the referee's card-issuing tendency.
    High-card refs slightly depress λ (because games where someone goes off
    on a red have lower scoring on average — fewer players = lower xG).

    Only computes when we have enough history on this ref (≥10 matches).
    """
    if not referee:
        return 1.0
    # Per-ref cards-per-match for this league
    r = conn.execute(
        """SELECT
               COUNT(*) AS n,
               AVG(yellows + yellows_against) AS yc_avg,
               AVG(reds + reds_against)       AS rc_avg
           FROM soccer_team_form
           WHERE league = ? AND referee = ? AND venue = 'home'""",
        (league, referee),
    ).fetchone()
    if not r or (r["n"] or 0) < 10:
        return 1.0
    # League baseline for comparison
    base = conn.execute(
        """SELECT
               AVG(yellows + yellows_against) AS yc_avg,
               AVG(reds + reds_against)       AS rc_avg
           FROM soccer_team_form
           WHERE league = ? AND referee IS NOT NULL AND venue = 'home'""",
        (league,),
    ).fetchone()
    if not base or (base["yc_avg"] or 0) <= 0:
        return 1.0

    yc_z = (r["yc_avg"] - base["yc_avg"]) / base["yc_avg"]    # +0.2 = 20% more cards than avg
    rc_z = (r["rc_avg"] - base["rc_avg"]) / (base["rc_avg"] + 1e-6)
    # Red cards have more impact than yellows on scoring
    combined = 0.3 * yc_z + 0.7 * rc_z
    mult = 1.0 - 0.05 * combined  # heavy-card refs → 5% λ depression at z=1
    return max(REF_ADJ_MIN_MULT, min(REF_ADJ_MAX_MULT, mult))


def predict_match(
    fit: DCFit, home_team: str, away_team: str,
    league: Optional[str] = None,
    referee: Optional[str] = None,
    apply_adjustments: bool = True,
    conn: Optional[sqlite3.Connection] = None,
) -> Optional[Dict[str, Any]]:
    """Returns full probability output for a match. None if either team
    not in the fitted dataset.

    When apply_adjustments=True and a connection is available, layers in:
      - Per-team SoT divergence adjustment on α
      - Per-ref card tendency adjustment on λ (only when referee given)
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

    # Day 4 adjustments — only when we have a DB to look at
    sot_mult_h = sot_mult_a = ref_mult = 1.0
    if apply_adjustments and league:
        owned_conn = conn is None
        c = conn or get_db()
        try:
            league_conv = _league_sot_conversion(league, c)
            sot_mult_h = _team_sot_adjustment(home_team, league, c, league_conv)
            sot_mult_a = _team_sot_adjustment(away_team, league, c, league_conv)
            ref_mult   = _ref_card_adjustment(referee, league, c)
        finally:
            if owned_conn:
                c.close()
        lam_h *= sot_mult_h * ref_mult
        lam_a *= sot_mult_a * ref_mult

    M = _scoreline_matrix(lam_h, lam_a, fit.rho)

    # 1X2 probabilities
    p_home = float(np.tril(M, -1).sum())   # home_goals > away_goals (lower triangle)
    p_draw = float(np.trace(M))            # diagonal
    p_away = float(np.triu(M, 1).sum())    # home_goals < away_goals

    # Totals — P(total > k.5) for common lines
    totals = {}
    rows, cols = np.indices(M.shape)
    sum_grid = rows + cols
    for k in (0.5, 1.5, 2.5, 3.5, 4.5):
        totals[f"over_{k}"]  = float(M[sum_grid > k].sum())
        totals[f"under_{k}"] = float(M[sum_grid < k].sum())

    # BTTS
    btts_yes = float(M[1:, 1:].sum())

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
        "btts_no":   1.0 - btts_yes,
        # Adjustment multipliers (for transparency / debugging)
        "_adj":      {
            "sot_mult_h": round(sot_mult_h, 4),
            "sot_mult_a": round(sot_mult_a, 4),
            "ref_mult":   round(ref_mult, 4),
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
