"""Tests for M40.6 — leakage-aware stake cap in approve_pick."""
from __future__ import annotations

from pathlib import Path

from ml.soccer.approved_picks import (
    _LEAKAGE_CAP_CROSSCHECK,
    _LEAKAGE_CAP_UNVALIDATED,
    _LEAKAGE_CAP_VALIDATED,
    _apply_leakage_cap,
    approve_pick,
)


# ── Pure helper ─────────────────────────────────────────────────────────

def test_no_rationale_no_cap() -> None:
    """When rationale is None, the raw Kelly stake passes through unchanged."""
    out = _apply_leakage_cap(3.5, market="totals_2.5", rationale=None)
    assert out["cap_applied"] is False
    assert out["stake_units"] == 3.5


def test_rationale_without_leakage_flag_no_cap() -> None:
    """A future model that's properly validated would have a rationale
    block without a leakage_note — that path keeps its Kelly stake."""
    out = _apply_leakage_cap(4.0, market="totals_2.5",
                             rationale={"model_prob_source": "v3_clean_split"})
    assert out["cap_applied"] is False
    assert out["stake_units"] == 4.0


def test_validated_market_with_leakage_caps_at_1u() -> None:
    """Totals 2.5 (the one market with positive ROI in any backtest)
    gets the highest cap when its rationale flags leakage."""
    out = _apply_leakage_cap(
        5.0, market="totals_2.5",
        rationale={"leakage_note": "edges upward-biased per audit"},
    )
    assert out["cap_applied"] is True
    assert out["stake_units"] == _LEAKAGE_CAP_VALIDATED == 1.0


def test_btts_with_leakage_caps_at_05u() -> None:
    """BTTS is cross-checked positive but not directly backtested →
    middle cap tier."""
    out = _apply_leakage_cap(
        3.9, market="btts",
        rationale={"leakage_note": "edges upward-biased per audit"},
    )
    assert out["cap_applied"] is True
    assert out["stake_units"] == _LEAKAGE_CAP_CROSSCHECK == 0.5


def test_anytime_scorer_with_no_backtest_caps_at_025u() -> None:
    """Anytime scorer market has zero backtest support — tightest cap."""
    out = _apply_leakage_cap(
        4.7, market="anytime_scorer",
        rationale={
            "leakage_note": "edges upward-biased per audit",
            "backtest_support": "NONE",
        },
    )
    assert out["cap_applied"] is True
    assert out["stake_units"] == _LEAKAGE_CAP_UNVALIDATED == 0.25


def test_raw_stake_preserved_for_audit() -> None:
    """The original Kelly value must be preserved so we can re-evaluate
    once M40.2 produces a clean calibration."""
    out = _apply_leakage_cap(
        4.74, market="anytime_scorer",
        rationale={"leakage_note": "...", "backtest_support": "NONE"},
    )
    assert out["raw_stake_units"] == 4.74


def test_cap_skipped_when_kelly_already_under_ceiling() -> None:
    """If raw Kelly is already below the cap (e.g. small edge), don't
    artificially reduce further. Anytime-scorer cap is 0.25u; raw 0.10
    is below that, so the cap is a no-op."""
    out = _apply_leakage_cap(
        0.10, market="anytime_scorer",
        rationale={"leakage_note": "...", "backtest_support": "NONE"},
    )
    assert out["cap_applied"] is False
    assert out["stake_units"] == 0.10


# ── End-to-end through approve_pick ─────────────────────────────────────

def test_approve_pick_caps_unvalidated_and_decorates_rationale(tmp_path: Path) -> None:
    """approve_pick must write the capped value AND record the original
    Kelly + cap reason in the rationale_json so the UI can show a badge."""
    import json
    db = tmp_path / "ap.db"
    row = approve_pick(
        game_id="test_fxt", market="anytime_scorer", side="yes",
        bet_label="Test Striker anytime",
        model_prob=0.45, best_price=210, best_book="dk",
        rationale={
            "leakage_note": "upward-biased per audit",
            "backtest_support": "NONE",
        },
        path=db,
    )
    # Stored stake_units is the capped value
    assert row["stake_units"] == _LEAKAGE_CAP_UNVALIDATED
    # The rationale carries the raw Kelly + cap reason for transparency
    rat = json.loads(row["rationale_json"])
    assert rat["stake_cap_applied"] is True
    assert "untested" in rat["stake_cap_reason"].lower()
    assert rat["raw_kelly_stake_units"] > _LEAKAGE_CAP_UNVALIDATED


def test_approve_pick_no_leakage_flag_preserves_kelly(tmp_path: Path) -> None:
    """Without a leakage_note, Kelly behaviour is unchanged (no cap, no
    rationale decoration)."""
    import json
    db = tmp_path / "ap.db"
    row = approve_pick(
        game_id="test_fxt_2", market="totals_2.5", side="over",
        bet_label="Test Over 2.5",
        model_prob=0.60, best_price=120, best_book="br",
        rationale={"model_prob_source": "clean_v3"},
        path=db,
    )
    # No cap — original Kelly recommendation persists
    assert row["stake_units"] > _LEAKAGE_CAP_VALIDATED
    rat = json.loads(row["rationale_json"])
    assert "stake_cap_applied" not in rat
