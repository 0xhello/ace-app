"""Tests for ml/soccer/predictions_crosscheck.py (M39)."""
from __future__ import annotations

from typing import Any, Dict

import pytest

from ml.soccer.predictions_crosscheck import (
    apply_demotion,
    crosscheck_pick,
    evaluate_agreement,
    lookup_sportmonks_prob,
)


def _bundle_with_preds(preds: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "fixture_id": 1,
        "home_team_name": "Home",
        "away_team_name": "Away",
        "lineups": [],
        "predictions": preds,
        "xgfixture": {},
    }


# ── lookup_sportmonks_prob ──────────────────────────────────────────────

def test_lookup_totals_over_returns_yes_pct_as_unit_fraction() -> None:
    b = _bundle_with_preds({
        "Over/Under 2.5 Probability": {"yes": 65.37, "no": 34.63},
    })
    assert lookup_sportmonks_prob(b, "totals_2.5", "over") == pytest.approx(0.6537)
    assert lookup_sportmonks_prob(b, "totals_2.5", "under") == pytest.approx(0.3463)


def test_lookup_1x2_home_draw_away() -> None:
    b = _bundle_with_preds({
        "Fulltime Result Probability": {"home": 42.0, "draw": 23.0, "away": 35.0},
    })
    assert lookup_sportmonks_prob(b, "1x2", "home") == pytest.approx(0.42)
    assert lookup_sportmonks_prob(b, "1x2", "draw") == pytest.approx(0.23)
    assert lookup_sportmonks_prob(b, "1x2", "away") == pytest.approx(0.35)


def test_lookup_btts_yes_no() -> None:
    b = _bundle_with_preds({
        "Both Teams To Score Probability": {"yes": 65.89, "no": 34.11},
    })
    assert lookup_sportmonks_prob(b, "btts", "yes") == pytest.approx(0.6589)


def test_lookup_corners_with_half_line() -> None:
    """Book line 8.5 (over wins iff corners ≥ 9) maps to Sportmonks
    'Corners Over/Under 8' yes (corners > 8 = corners ≥ 9)."""
    b = _bundle_with_preds({
        "Corners Over/Under 8 Probability": {"yes": 56.66, "no": 31.57},
    })
    assert lookup_sportmonks_prob(b, "corners", "over", line=8.5) == pytest.approx(0.5666)
    assert lookup_sportmonks_prob(b, "corners", "under", line=8.5) == pytest.approx(0.3157)


def test_lookup_returns_none_for_player_props() -> None:
    """Player markets aren't in the Sportmonks predictions surface —
    must return None (no_signal path downstream)."""
    b = _bundle_with_preds({
        "Fulltime Result Probability": {"home": 50, "draw": 25, "away": 25},
    })
    assert lookup_sportmonks_prob(b, "anytime_scorer", "yes") is None
    assert lookup_sportmonks_prob(b, "shots", "over", line=2.5) is None


def test_lookup_handles_missing_bundle_or_predictions() -> None:
    assert lookup_sportmonks_prob(None, "totals_2.5", "over") is None
    assert lookup_sportmonks_prob({"predictions": {}}, "totals_2.5", "over") is None


# ── evaluate_agreement ──────────────────────────────────────────────────

def test_evaluate_agree_within_5pp() -> None:
    out = evaluate_agreement(ace_prob=0.62, sportmonks_prob=0.65)
    assert out["tier"] == "agree"
    assert out["demote_steps"] == 0
    assert "agrees" in out["badge"].lower()


def test_evaluate_mild_disagree_demotes_one_step() -> None:
    out = evaluate_agreement(ace_prob=0.70, sportmonks_prob=0.60)
    assert out["tier"] == "mild_disagree"
    assert out["demote_steps"] == 1
    # The badge should tell the user which way Sportmonks leans
    assert "lower" in out["badge"].lower() or "higher" in out["badge"].lower()


def test_evaluate_strong_disagree_signals_watch() -> None:
    out = evaluate_agreement(ace_prob=0.80, sportmonks_prob=0.40)
    assert out["tier"] == "strong_disagree"
    assert out["demote_steps"] >= 99
    assert "conflict" in out["badge"].lower()


def test_evaluate_no_signal_when_sm_missing() -> None:
    out = evaluate_agreement(ace_prob=0.60, sportmonks_prob=None)
    assert out["tier"] == "no_signal"
    assert out["delta_pp"] is None
    assert out["demote_steps"] == 0


def test_evaluate_direction_blind() -> None:
    """We demote on either over- OR under-shoot. ACE 70% / SM 60% (we're
    higher) and ACE 60% / SM 70% (we're lower) BOTH get mild_disagree."""
    a = evaluate_agreement(ace_prob=0.70, sportmonks_prob=0.60)
    b = evaluate_agreement(ace_prob=0.60, sportmonks_prob=0.70)
    assert a["tier"] == "mild_disagree"
    assert b["tier"] == "mild_disagree"
    assert a["delta_pp"] == -b["delta_pp"]  # signed delta flips


# ── apply_demotion ──────────────────────────────────────────────────────

def test_apply_demotion_a_to_b_on_mild() -> None:
    agree = {"demote_steps": 1}
    assert apply_demotion("A", agree) == "B"


def test_apply_demotion_b_to_c_on_mild() -> None:
    assert apply_demotion("B", {"demote_steps": 1}) == "C"


def test_apply_demotion_strong_always_to_watch() -> None:
    assert apply_demotion("A", {"demote_steps": 99}) == "watch"
    assert apply_demotion("B", {"demote_steps": 99}) == "watch"
    assert apply_demotion("C", {"demote_steps": 99}) == "watch"


def test_apply_demotion_no_signal_keeps_tier() -> None:
    assert apply_demotion("A", {"demote_steps": 0}) == "A"


def test_watch_stays_watch_under_any_demotion() -> None:
    assert apply_demotion("watch", {"demote_steps": 1}) == "watch"
    assert apply_demotion("watch", {"demote_steps": 99}) == "watch"


# ── crosscheck_pick (the one-shot integration helper) ──────────────────

def test_crosscheck_pick_agree_keeps_tier() -> None:
    b = _bundle_with_preds({
        "Over/Under 2.5 Probability": {"yes": 65.0, "no": 35.0},
    })
    out = crosscheck_pick(
        bundle=b, ace_market="totals_2.5", ace_side="over",
        ace_prob=0.62, original_tier="A",
    )
    assert out["tier"] == "agree"
    assert out["new_tier"] == "A"
    assert out["tier_was_demoted"] is False


def test_crosscheck_pick_strong_disagree_drops_to_watch() -> None:
    b = _bundle_with_preds({
        "Fulltime Result Probability": {"home": 30, "draw": 25, "away": 45},
    })
    out = crosscheck_pick(
        bundle=b, ace_market="1x2", ace_side="home",
        ace_prob=0.70, original_tier="A",
    )
    assert out["tier"] == "strong_disagree"
    assert out["new_tier"] == "watch"
    assert out["tier_was_demoted"] is True


def test_crosscheck_pick_no_signal_for_player_prop_keeps_tier() -> None:
    """Player props always return no_signal — they don't get gated by M39."""
    b = _bundle_with_preds({
        "Fulltime Result Probability": {"home": 50, "draw": 25, "away": 25},
    })
    out = crosscheck_pick(
        bundle=b, ace_market="anytime_scorer", ace_side="yes",
        ace_prob=0.55, original_tier="B",
    )
    assert out["tier"] == "no_signal"
    assert out["new_tier"] == "B"
    assert out["sportmonks_prob"] is None


def test_crosscheck_pick_corners_half_line() -> None:
    """Book FanDuel offers Over 8.5 corners. M39 maps that to Sportmonks
    Corners Over/Under 8 'yes' (corners > 8 = corners ≥ 9 = book over 8.5)."""
    b = _bundle_with_preds({
        "Corners Over/Under 8 Probability": {"yes": 60.0, "no": 30.0},
    })
    out = crosscheck_pick(
        bundle=b, ace_market="corners", ace_side="over",
        ace_prob=0.55, original_tier="B", line=8.5,
    )
    assert out["sportmonks_prob"] == pytest.approx(0.60)
    assert out["tier"] == "agree"  # 55% vs 60% = 5pp boundary, agree side
    assert out["new_tier"] == "B"
