"""
Smoke test — full MLB signal/pick pipeline with a temp DB, no real API calls.

Scenario
--------
Yankees @ Red Sox, 2026-05-19. Pinnacle prices Yankees ML at ~56%, FanDuel
at ~50% (FD offering longer odds on the road favorite → +6pp edge on NYY).
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from ml.mlb.signal_logger import (
    confidence_tier,
    devig,
    get_all_signals,
    get_open_signals,
    grade_signal,
    init_db,
    kelly_fraction,
    log_signal,
    update_closing_lines,
)


GAME_ID   = "SMOKE_MLB_001"
GAME_DATE = "2026-05-19"
HOME      = "Boston Red Sox"
AWAY      = "New York Yankees"


@pytest.fixture
def db(tmp_path: Path) -> Path:
    return tmp_path / "smoke_mlb.db"


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

def test_init_db_creates_full_schema(db: Path) -> None:
    init_db(db)
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(mlb_signals)").fetchall()}
    conn.close()
    for required in ("game_id", "market", "bet_side", "line", "pinnacle_prob",
                     "book_odds", "edge_pp", "status",
                     "confidence_tier", "kelly_fraction", "reasoning_json",
                     "closing_pinnacle_prob", "closing_book_odds", "clv_pp"):
        assert required in cols, f"missing column: {required}"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def test_confidence_tier_thresholds() -> None:
    assert confidence_tier(0.10) == "A"
    assert confidence_tier(0.07) == "A"
    assert confidence_tier(0.05) == "B"
    assert confidence_tier(0.04) == "B"
    assert confidence_tier(0.03) == "C"
    assert confidence_tier(None) == "C"


def test_kelly_zero_at_no_edge() -> None:
    assert kelly_fraction(0.50, -110) == 0.0


def test_kelly_caps() -> None:
    assert kelly_fraction(0.80, +200) == 0.05


# ---------------------------------------------------------------------------
# Full chain — ML signal
# ---------------------------------------------------------------------------

def _insert_ml_signal(db: Path) -> int:
    """Yankees ML at +110 vs Pinnacle implied ~+80 → soft book offering longer odds."""
    pin_probs = devig([-150, +130])   # Pinnacle: home -150 / away +130 → ~56%/44% sharp
    fd_probs  = devig([-115, +110])   # FanDuel:  home -115 / away +110 → ~50%/50% (cheaper away)
    return log_signal(
        game_id        = GAME_ID,
        game_date      = GAME_DATE,
        home_team      = HOME,
        away_team      = AWAY,
        commence_time  = "2026-05-19T23:05:00Z",
        market         = "h2h",
        bet_side       = "away",
        pinnacle_prob  = pin_probs[1],
        book           = "fanduel",
        book_prob      = fd_probs[1],
        book_odds      = +110,
        edge_pp        = pin_probs[1] - fd_probs[1],
        notes          = "test",
        reasoning_json = json.dumps({"note": "test"}),
        path           = db,
    )


def test_log_ml_signal(db: Path) -> None:
    row_id = _insert_ml_signal(db)
    assert row_id > 0
    sigs = get_open_signals(db)
    assert len(sigs) == 1
    assert sigs[0]["market"] == "h2h"
    assert sigs[0]["bet_side"] == "away"
    assert sigs[0]["confidence_tier"] in ("A", "B", "C")
    assert sigs[0]["kelly_fraction"] >= 0


def test_grade_ml_signal_win(db: Path) -> None:
    _insert_ml_signal(db)
    # Yankees win 7-5 → away wins, bet_side=away → correct=1
    graded = grade_signal(GAME_ID, home_score=5, away_score=7, path=db)
    assert graded[0]["result"] == "away"
    assert graded[0]["correct"] == 1


def test_grade_ml_signal_loss(db: Path) -> None:
    _insert_ml_signal(db)
    # Red Sox win 4-3 → home wins, bet_side=away → correct=0
    graded = grade_signal(GAME_ID, home_score=4, away_score=3, path=db)
    assert graded[0]["result"] == "home"
    assert graded[0]["correct"] == 0


# ---------------------------------------------------------------------------
# Run line — push handling
# ---------------------------------------------------------------------------

def test_grade_run_line_push_on_exact_margin(db: Path) -> None:
    """Home -1.5 with a 7-6 final → margin = -0.5 → away wins the RL.
    Test the exact-push case with a 0-line: home 0.0 → margin == 0 → push."""
    pin_rl   = devig([-110, -110])
    log_signal(
        game_id="MLB_RL_PUSH",
        game_date=GAME_DATE,
        home_team=HOME, away_team=AWAY,
        commence_time="2026-05-19T23:05:00Z",
        market="run_line",
        bet_side="home",
        line=0.0,
        pinnacle_prob=pin_rl[0],
        book="fanduel",
        book_prob=0.45,
        book_odds=-110,
        edge_pp=0.05,
        path=db,
    )
    # 5-5 → margin = 0 → push
    graded = grade_signal("MLB_RL_PUSH", home_score=5, away_score=5, path=db)
    assert graded[0]["result"] == "push"
    assert graded[0]["correct"] is None
    assert get_all_signals(db)[0]["status"] == "void"


# ---------------------------------------------------------------------------
# Totals
# ---------------------------------------------------------------------------

def test_grade_totals_over(db: Path) -> None:
    log_signal(
        game_id="MLB_TOT_001",
        game_date=GAME_DATE,
        home_team=HOME, away_team=AWAY,
        commence_time="2026-05-19T23:05:00Z",
        market="totals",
        bet_side="over",
        line=8.5,
        pinnacle_prob=0.55,
        book="fanduel",
        book_prob=0.48,
        book_odds=-105,
        edge_pp=0.07,
        path=db,
    )
    # 6-4 → total 10 → over 8.5 → win
    graded = grade_signal("MLB_TOT_001", home_score=6, away_score=4, path=db)
    assert graded[0]["result"] == "over"
    assert graded[0]["correct"] == 1


def test_grade_totals_push(db: Path) -> None:
    log_signal(
        game_id="MLB_TOT_PUSH",
        game_date=GAME_DATE,
        home_team=HOME, away_team=AWAY,
        commence_time="2026-05-19T23:05:00Z",
        market="totals",
        bet_side="under",
        line=9.0,
        pinnacle_prob=0.55,
        book="fanduel",
        book_prob=0.48,
        book_odds=-110,
        edge_pp=0.07,
        path=db,
    )
    # 5-4 → total 9.0 → push
    graded = grade_signal("MLB_TOT_PUSH", home_score=5, away_score=4, path=db)
    assert graded[0]["result"] == "push"
    assert graded[0]["correct"] is None


# ---------------------------------------------------------------------------
# Closing lines
# ---------------------------------------------------------------------------

def test_closing_lines_compute_clv(db: Path) -> None:
    _insert_ml_signal(db)
    pre = get_open_signals(db)
    book_prob = pre[0]["book_prob"]
    updated = update_closing_lines(
        GAME_ID,
        pinnacle_probs_by_side={"home": 0.50, "away": 0.50},  # sharp drifted toward us
        book_odds_by_side_book={("fanduel", "away"): +100},
        path=db,
    )
    assert updated == 1
    row = get_all_signals(db)[0]
    assert row["closing_pinnacle_prob"] == 0.50
    assert row["clv_pp"] == pytest.approx(0.50 - book_prob, abs=1e-6)
    assert row["clv_pp"] > 0  # we beat the close
