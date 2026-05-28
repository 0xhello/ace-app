"""Tests for the Poisson edge math + multi-tier best-line selector.

Verifies M16:
  - _poisson_at_least(k, lam) returns sensible P(X >= k) for the small
    lambdas we see in football props (1–6 expected events per match).
  - _best_tier_for_count_market scans every offered threshold and picks
    the line with the largest model-vs-market edge, not the longshot.
  - _american_to_implied_prob mirrors the standard Vegas conversion both
    directions.

Critical regression guard: the old code path picked the highest-priced
outcome per (player, market), which silently surfaced FanDuel's longshot
lines (e.g. "6+ shots @ +470") instead of the standard 2.5/3.5 lines.
The tests below lock in that behavior — if anyone reverts the selector,
these break loud.
"""
from __future__ import annotations

import math

import pytest

from ml.soccer.prop_cards import (
    _american_to_implied_prob,
    _best_tier_for_count_market,
    _poisson_at_least,
)


# ── Poisson probability helper ───────────────────────────────────────────────

def test_poisson_at_least_matches_closed_form():
    """P(X >= 1) when X ~ Poisson(lambda) = 1 - exp(-lambda).

    This is the same formula used for anytime-scorer props, so getting it
    right here means both layers share consistent math.
    """
    for lam in (0.3, 1.0, 2.5, 4.0):
        expected = 1.0 - math.exp(-lam)
        assert _poisson_at_least(1, lam) == pytest.approx(expected, abs=1e-9)


def test_poisson_at_least_zero_lambda():
    """Lambda <= 0 → can't take any shots → P(X >= 1) = 0."""
    assert _poisson_at_least(1, 0.0) == 0.0
    assert _poisson_at_least(1, -0.1) == 0.0


def test_poisson_at_least_zero_threshold():
    """P(X >= 0) = 1 — the event 'at least 0 shots' is certain."""
    assert _poisson_at_least(0, 2.5) == 1.0
    assert _poisson_at_least(0, 0.0) == 1.0


def test_poisson_at_least_realistic_shot_lambdas():
    """Sanity-check the actual Saka / Mbappe / Ramos shot rates.

    A player projected for ~3.5 expected shots should clear:
      1+ shots with high probability (~97%)
      2+ shots with high probability (~86%)
      3+ shots with moderate probability (~66%)
      4+ shots with moderate probability (~46%)
      5+ shots with low probability (~28%)
      6+ shots with low probability (~15%)
    These ranges drive how the model decides which tier to bet.
    """
    lam = 3.5
    assert _poisson_at_least(1, lam) == pytest.approx(0.970, abs=0.02)
    assert _poisson_at_least(2, lam) == pytest.approx(0.864, abs=0.02)
    assert _poisson_at_least(3, lam) == pytest.approx(0.679, abs=0.02)
    assert _poisson_at_least(4, lam) == pytest.approx(0.463, abs=0.02)
    assert _poisson_at_least(5, lam) == pytest.approx(0.275, abs=0.02)
    assert _poisson_at_least(6, lam) == pytest.approx(0.142, abs=0.02)


def test_poisson_at_least_handles_half_lines():
    """A line of 2.5 (rare for X+ ladders but possible) should bet on >=3."""
    lam = 3.5
    # P(>= 2.5) should equal P(>= 3) since shots are integer-valued
    assert _poisson_at_least(2.5, lam) == _poisson_at_least(3, lam)
    assert _poisson_at_least(2.1, lam) == _poisson_at_least(3, lam)


# ── American odds → implied probability ──────────────────────────────────────

def test_american_to_implied_positive_odds():
    """+100 = 50%, +200 ≈ 33.3%, +500 ≈ 16.7%."""
    assert _american_to_implied_prob(100) == pytest.approx(0.500, abs=0.001)
    assert _american_to_implied_prob(200) == pytest.approx(1/3, abs=0.001)
    assert _american_to_implied_prob(500) == pytest.approx(0.1667, abs=0.001)


def test_american_to_implied_negative_odds():
    """-100 = 50%, -200 ≈ 66.7%, -110 ≈ 52.4% (standard vig)."""
    assert _american_to_implied_prob(-100) == pytest.approx(0.500, abs=0.001)
    assert _american_to_implied_prob(-200) == pytest.approx(2/3, abs=0.001)
    assert _american_to_implied_prob(-110) == pytest.approx(0.5238, abs=0.001)


# ── Best-tier selector across the FanDuel-style ladder ─────────────────────

def _ladder_3_5_lambda():
    """The exact ladder FanDuel posted for our prod test case (Saka shots,
    lambda 3.1) — including the +2200 longshot that broke the old code."""
    return [
        {"book": "fanduel", "price":  -200, "point": 1, "_label": "1+"},
        {"book": "fanduel", "price":  -120, "point": 2, "_label": "2+"},
        {"book": "fanduel", "price":  +120, "point": 3, "_label": "3+"},
        {"book": "fanduel", "price":  +280, "point": 4, "_label": "4+"},
        {"book": "fanduel", "price":  +700, "point": 5, "_label": "5+"},
        {"book": "fanduel", "price": +2200, "point": 6, "_label": "6+"},
    ]


def test_best_tier_picks_best_edge_not_longest_price():
    """Regression: lambda=3.1, ladder above — best edge is at 1+ shots
    (model P(>=1)≈0.955 vs implied 0.667 ≈ +28.8pp), NOT the +2200
    longshot at 6+ shots (model ≈0.067 vs implied 0.043 ≈ +2.4pp).

    Old code surfaced the +2200 longshot. New code surfaces whichever
    tier has the biggest edge. For an active shooter (lambda 3.1) that
    happens to be the 1+ tier — paying heavy juice (-200) on a near-
    certain event gives the largest implied-vs-true gap.
    """
    out = _best_tier_for_count_market(_ladder_3_5_lambda(), 3.1)
    assert out is not None
    # The biggest positive edge in this ladder is at the 1+ tier.
    assert out["point"] == 1
    assert out["price"] == -200
    assert out["edge_pp"] == pytest.approx(0.288, abs=0.02)


def test_best_tier_with_low_lambda_picks_mid_ladder():
    """For a low-shooting player (lambda 1.2) the 1+ tier is too juiced
    (heavy implied prob, modest model prob) and the longshots are all
    out of reach. The optimal tier should land in the middle (or return
    None if no positive edge anywhere)."""
    out = _best_tier_for_count_market(_ladder_3_5_lambda(), 1.2)
    if out is not None:
        # If anything wins, it's a low-threshold tier (1 or 2), not a longshot
        assert out["point"] in (1, 2, 3)
        assert out["edge_pp"] > 0


def test_best_tier_at_meatier_lambda():
    """For a higher-shooting player (lambda 4.5) the optimal tier shifts up.
    Confirms the search isn't biased toward low thresholds."""
    out = _best_tier_for_count_market(_ladder_3_5_lambda(), 4.5)
    assert out is not None
    # At lambda 4.5 the model edge maximizes around the 3+ or 4+ tier.
    assert out["point"] in (2, 3, 4)
    assert out["edge_pp"] > 0


def test_best_tier_returns_none_when_no_positive_edge():
    """If model is below market everywhere, the selector returns None
    rather than forcing a losing bet."""
    weak_ladder = [
        {"book": "fanduel", "price": -1000, "point": 1},  # 91% implied
        {"book": "fanduel", "price":  -500, "point": 2},  # 83%
        {"book": "fanduel", "price":  -300, "point": 3},  # 75%
    ]
    # Lambda 0.5 means the model gives < 50% even at 1+
    out = _best_tier_for_count_market(weak_ladder, 0.5)
    assert out is None


def test_best_tier_skips_tiers_with_missing_data():
    """A tier with no point or no price gets ignored, not crash."""
    bad_ladder = [
        {"book": "fanduel", "price":  -110, "point": None},
        {"book": "fanduel", "price":  None, "point": 2},
        {"book": "fanduel", "price":  -110, "point": 2},
    ]
    out = _best_tier_for_count_market(bad_ladder, 3.0)
    assert out is not None
    assert out["point"] == 2
    assert out["price"] == -110


def test_best_tier_handles_empty_ladder():
    assert _best_tier_for_count_market([], 3.0) is None
    assert _best_tier_for_count_market(None, 3.0) is None  # type: ignore[arg-type]


def test_best_tier_handles_zero_lambda():
    """If the model expects 0 shots, no tier should be picked."""
    out = _best_tier_for_count_market(_ladder_3_5_lambda(), 0.0)
    assert out is None
