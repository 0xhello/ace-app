"""Tests for player-prop grading on soccer_approved_picks.

Covers anytime_scorer, first_scorer, to_score_2_or_more — the three
markets we've actually approved picks on at any point. Game-level
markets (1X2, totals, BTTS) are exercised by the existing
grade_approved_picks integration tests.
"""
from __future__ import annotations

from pathlib import Path

from ml.soccer.approved_picks import (
    _extract_player_from_bet_label,
    _norm_player_name,
    _resolve_outcome,
    approve_pick,
    grade_approved_picks,
)


# ── name normalisation + bet-label parsing ────────────────────────────

def test_norm_handles_accents() -> None:
    """'Ousmane Dembélé' and 'O. Dembele' both collapse to the same token."""
    assert _norm_player_name("Ousmane Dembélé") == "ousmanedembele"
    assert _norm_player_name("O. Dembele") == "odembele"


def test_extract_player_from_anytime_label() -> None:
    assert _extract_player_from_bet_label(
        "Ousmane Dembélé to score anytime"
    ) == "Ousmane Dembélé"
    assert _extract_player_from_bet_label(
        "Bukayo Saka anytime"
    ) == "Bukayo Saka"
    assert _extract_player_from_bet_label(
        "Erling Haaland 2+ goals"
    ) == "Erling Haaland"


def test_extract_player_handles_first_scorer_variants() -> None:
    assert _extract_player_from_bet_label(
        "Harry Kane to score first"
    ) == "Harry Kane"
    assert _extract_player_from_bet_label(
        "Harry Kane first scorer"
    ) == "Harry Kane"


# ── _resolve_outcome — anytime_scorer ─────────────────────────────────

def test_anytime_scorer_won_when_named_player_scored() -> None:
    out = _resolve_outcome(
        "anytime_scorer", "yes", hs=2, as_=1,
        goal_scorers=["Ousmane Dembélé", "Bukayo Saka", "Marquinhos"],
        bet_label="Ousmane Dembélé to score anytime",
    )
    assert out == "won"


def test_anytime_scorer_lost_when_named_player_didnt_score() -> None:
    out = _resolve_outcome(
        "anytime_scorer", "yes", hs=2, as_=1,
        goal_scorers=["Marquinhos", "Vitinha"],
        bet_label="Ousmane Dembélé to score anytime",
    )
    assert out == "lost"


def test_anytime_scorer_fuzzy_match_handles_short_name() -> None:
    """Sportmonks events sometimes return 'O. Dembele' instead of full
    'Ousmane Dembélé' — must still match."""
    out = _resolve_outcome(
        "anytime_scorer", "yes", hs=1, as_=0,
        goal_scorers=["O. Dembele"],
        bet_label="Ousmane Dembélé to score anytime",
    )
    assert out == "won"


def test_anytime_scorer_no_scorers_means_lost_for_yes_side() -> None:
    """Match ended 0-0 — nobody scored — our YES pick loses cleanly."""
    out = _resolve_outcome(
        "anytime_scorer", "yes", hs=0, as_=0,
        goal_scorers=[],
        bet_label="Ousmane Dembélé to score anytime",
    )
    assert out == "lost"


def test_anytime_scorer_missing_scorer_list_returns_none() -> None:
    """If goal_scorers is None (data not yet available), don't fake a
    grade — leave it open for a later run."""
    out = _resolve_outcome(
        "anytime_scorer", "yes", hs=2, as_=1,
        goal_scorers=None,
        bet_label="Ousmane Dembélé to score anytime",
    )
    assert out is None


def test_anytime_scorer_missing_bet_label_returns_none() -> None:
    out = _resolve_outcome(
        "anytime_scorer", "yes", hs=2, as_=1,
        goal_scorers=["Mbappé"],
        bet_label=None,
    )
    assert out is None


# ── _resolve_outcome — first_scorer ────────────────────────────────────

def test_first_scorer_won_when_player_scored_first() -> None:
    out = _resolve_outcome(
        "first_scorer", "yes", hs=2, as_=1,
        goal_scorers=["Saka", "Dembélé", "Marquinhos"],
        bet_label="Bukayo Saka to score first",
    )
    assert out == "won"


def test_first_scorer_lost_when_player_scored_but_not_first() -> None:
    out = _resolve_outcome(
        "first_scorer", "yes", hs=2, as_=1,
        goal_scorers=["Dembélé", "Saka"],
        bet_label="Bukayo Saka to score first",
    )
    assert out == "lost"


# ── _resolve_outcome — to_score_2_or_more ──────────────────────────────

def test_2_plus_goals_won_on_brace() -> None:
    out = _resolve_outcome(
        "to_score_2_or_more", "yes", hs=3, as_=0,
        goal_scorers=["Dembélé", "Dembélé", "Vitinha"],
        bet_label="Ousmane Dembélé 2+ goals",
    )
    assert out == "won"


def test_2_plus_goals_lost_on_one_goal() -> None:
    out = _resolve_outcome(
        "to_score_2_or_more", "yes", hs=2, as_=1,
        goal_scorers=["Dembélé", "Saka"],
        bet_label="Ousmane Dembélé 2+ goals",
    )
    assert out == "lost"


# ── End-to-end through grade_approved_picks ────────────────────────────

def test_grade_approved_picks_settles_anytime_scorer(tmp_path: Path) -> None:
    """An approved anytime_scorer pick should land as 'won' after a
    grade run with a result_lookup that returns goal_scorers."""
    db = tmp_path / "ap.db"
    approve_pick(
        game_id="ucl_final", market="anytime_scorer", side="yes",
        bet_label="Ousmane Dembélé to score anytime",
        model_prob=0.45, best_price=210, best_book="dk",
        rationale={"leakage_note": "...", "backtest_support": "NONE"},
        path=db,
    )

    def lookup(game_id: str):
        if game_id == "ucl_final":
            return {
                "home_score": 2, "away_score": 1, "status": "final",
                "goal_scorers": ["Marquinhos", "Ousmane Dembélé", "Saka"],
            }
        return None

    res = grade_approved_picks(result_lookup=lookup, path=db)
    assert res["graded"] == 1

    # Confirm the row landed as won + pnl > 0
    from ml.soccer.approved_picks import list_approved_picks
    rows = list_approved_picks(path=db, model_version=None)
    assert rows[0]["graded_status"] == "won"
    assert rows[0]["pnl_units"] > 0


def test_grade_approved_picks_settles_anytime_scorer_lost(tmp_path: Path) -> None:
    """Same setup but our player didn't score — pick lands 'lost'."""
    db = tmp_path / "ap.db"
    approve_pick(
        game_id="ucl_final", market="anytime_scorer", side="yes",
        bet_label="Bukayo Saka to score anytime",
        model_prob=0.31, best_price=380, best_book="br",
        rationale={"leakage_note": "...", "backtest_support": "NONE"},
        path=db,
    )

    def lookup(game_id: str):
        return {
            "home_score": 2, "away_score": 0, "status": "final",
            "goal_scorers": ["Dembélé", "Marquinhos"],
        }

    res = grade_approved_picks(result_lookup=lookup, path=db)
    assert res["graded"] == 1

    from ml.soccer.approved_picks import list_approved_picks
    rows = list_approved_picks(path=db, model_version=None)
    assert rows[0]["graded_status"] == "lost"
    assert rows[0]["pnl_units"] < 0


def test_grade_approved_picks_skips_anytime_when_scorers_missing(tmp_path: Path) -> None:
    """If result_lookup returns no goal_scorers, anytime_scorer stays open
    so a later run with better data can settle it."""
    db = tmp_path / "ap.db"
    approve_pick(
        game_id="ucl_final", market="anytime_scorer", side="yes",
        bet_label="Bukayo Saka to score anytime",
        model_prob=0.31, best_price=380, best_book="br",
        rationale={"leakage_note": "...", "backtest_support": "NONE"},
        path=db,
    )

    def lookup(game_id: str):
        # Score in, but no goal_scorers list
        return {"home_score": 2, "away_score": 0, "status": "final"}

    res = grade_approved_picks(result_lookup=lookup, path=db)
    assert res["graded"] == 0  # left open

    from ml.soccer.approved_picks import list_approved_picks
    rows = list_approved_picks(path=db, model_version=None)
    assert rows[0]["graded_status"] == "open"


def test_grade_approved_picks_still_grades_totals_and_btts_alongside(tmp_path: Path) -> None:
    """Mixed slate: totals_2.5 + anytime_scorer settle in the same pass."""
    db = tmp_path / "ap.db"
    approve_pick(
        game_id="ucl_final", market="totals_2.5", side="over",
        bet_label="Over 2.5 goals", model_prob=0.60, best_price=120,
        best_book="br",
        path=db,
    )
    approve_pick(
        game_id="ucl_final:dembele", market="anytime_scorer", side="yes",
        bet_label="Ousmane Dembélé to score anytime",
        model_prob=0.45, best_price=210, best_book="dk",
        rationale={"leakage_note": "...", "backtest_support": "NONE"},
        path=db,
    )

    def lookup(game_id: str):
        return {
            "home_score": 2, "away_score": 1, "status": "final",
            "goal_scorers": ["Dembélé", "Marquinhos", "Saka"],
        }

    res = grade_approved_picks(result_lookup=lookup, path=db)
    assert res["graded"] == 2

    from ml.soccer.approved_picks import list_approved_picks
    rows = list_approved_picks(path=db, model_version=None)
    by_market = {r["market"]: r for r in rows}
    assert by_market["totals_2.5"]["graded_status"] == "won"     # 3 goals > 2.5
    assert by_market["anytime_scorer"]["graded_status"] == "won"  # Dembélé scored
