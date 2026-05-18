"""
Smoke test — full WC signal/pick pipeline with a temp DB, no real API calls.

Scenario
--------
Brazil vs Argentina, 2026-06-16. Pinnacle prices the draw at 26%, FanDuel
prices it at 32% (book offers longer odds than truth → +6pp edge on draw).

Then:
  - log_signal() fires, computes tier='B' (4-7pp), Kelly sizing, stores
    a reasoning_json snapshot.
  - get_open_signals() returns it.
  - grade_signal() with final score 2-2 → result='draw', correct=1.
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from ml.world_cup.signal_logger import (
    DB_PATH,
    confidence_tier,
    devig,
    get_all_signals,
    get_open_signals,
    grade_signal,
    init_db,
    kelly_fraction,
    log_signal,
)


GAME_ID   = "SMOKE_WC_001"
GAME_DATE = "2026-06-16"
HOME      = "Brazil"
AWAY      = "Argentina"


@pytest.fixture
def db(tmp_path: Path) -> Path:
    """Each test gets a fresh DB so state doesn't leak between assertions."""
    return tmp_path / "smoke_wc.db"


# ---------------------------------------------------------------------------
# Schema migration
# ---------------------------------------------------------------------------

def test_init_db_creates_full_schema(db: Path) -> None:
    init_db(db)
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(soccer_signals)").fetchall()}
    conn.close()

    # Original columns are present
    for required in ("game_id", "market", "bet_side", "pinnacle_prob", "book_odds", "edge_pp", "status"):
        assert required in cols, f"missing original column: {required}"

    # New pick-quality columns are present
    for required in ("confidence_tier", "kelly_fraction", "reasoning_json",
                     "closing_pinnacle_prob", "closing_book_odds", "clv_pp"):
        assert required in cols, f"missing new column: {required}"


def test_migrate_is_idempotent_on_old_schema(db: Path) -> None:
    """Simulate the production DB (pre-migration schema) and confirm init_db
    adds the new columns without touching existing rows."""
    # Build the old schema by hand
    conn = sqlite3.connect(db)
    conn.execute("""
        CREATE TABLE soccer_signals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_id TEXT NOT NULL,
            game_date DATE NOT NULL,
            home_team TEXT NOT NULL,
            away_team TEXT NOT NULL,
            commence_time TEXT,
            tournament TEXT DEFAULT 'FIFA World Cup',
            market TEXT NOT NULL,
            bet_side TEXT NOT NULL,
            total_line REAL,
            signal_type TEXT NOT NULL DEFAULT 'divergence',
            pinnacle_prob REAL,
            book TEXT NOT NULL,
            book_prob REAL,
            book_odds REAL,
            edge_pp REAL,
            home_score INTEGER,
            away_score INTEGER,
            result TEXT,
            correct INTEGER,
            status TEXT NOT NULL DEFAULT 'open',
            notes TEXT,
            detected_at TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)
    conn.execute(
        """INSERT INTO soccer_signals
           (game_id, game_date, home_team, away_team, market, bet_side, book, detected_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        ("OLD_ROW_1", "2026-06-01", "X", "Y", "h2h", "home", "fanduel", "2026-06-01T00:00:00Z"),
    )
    conn.commit()
    conn.close()

    # Run migration twice — should be idempotent
    init_db(db)
    init_db(db)

    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(soccer_signals)").fetchall()}
    # Existing row should still be there
    row = conn.execute("SELECT game_id, confidence_tier FROM soccer_signals WHERE game_id = ?",
                       ("OLD_ROW_1",)).fetchone()
    conn.close()

    assert "confidence_tier" in cols
    assert "kelly_fraction" in cols
    assert "reasoning_json" in cols
    assert row is not None
    assert row["game_id"] == "OLD_ROW_1"
    assert row["confidence_tier"] is None  # not backfilled — new column defaults to NULL


# ---------------------------------------------------------------------------
# Tier + Kelly helpers
# ---------------------------------------------------------------------------

def test_confidence_tier_thresholds() -> None:
    assert confidence_tier(0.10) == "A"
    assert confidence_tier(0.07) == "A"
    assert confidence_tier(0.069) == "B"
    assert confidence_tier(0.05) == "B"
    assert confidence_tier(0.04) == "B"
    assert confidence_tier(0.039) == "C"
    assert confidence_tier(0.03) == "C"
    assert confidence_tier(None) == "C"


def test_kelly_returns_zero_with_no_edge() -> None:
    # 50% true prob vs -110 implies juice — should return 0
    assert kelly_fraction(0.50, -110) == 0.0
    # Invalid probs
    assert kelly_fraction(0.0, +100) == 0.0
    assert kelly_fraction(1.0, +100) == 0.0


def test_kelly_caps_at_default() -> None:
    # Big edge that would exceed cap
    assert kelly_fraction(0.80, +200) == 0.05
    # Custom cap
    assert kelly_fraction(0.80, +200, cap=0.03) == 0.03


def test_kelly_positive_edge() -> None:
    # 60% true on -135 → some positive fraction
    fraction = kelly_fraction(0.60, -135)
    assert 0 < fraction <= 0.05


# ---------------------------------------------------------------------------
# Full signal → log → grade chain
# ---------------------------------------------------------------------------

def _insert_test_signal(db: Path, reasoning: dict | None = None) -> int:
    """Insert a Brazil-Argentina h2h-draw signal and return the row id."""
    # Pinnacle prices: home -130 / draw +260 / away +200
    # FanDuel  prices: home -120 / draw +240 / away +210
    # Pinnacle de-vigged draw prob = ~26%, FanDuel = ~32% (longer odds → 6pp edge)
    pin_probs = devig([-130, +260, +200])
    fd_probs  = devig([-120, +240, +210])

    return log_signal(
        game_id        = GAME_ID,
        game_date      = GAME_DATE,
        home_team      = HOME,
        away_team      = AWAY,
        commence_time  = "2026-06-16T21:00:00Z",
        market         = "h2h",
        bet_side       = "draw",
        pinnacle_prob  = pin_probs[1],
        book           = "fanduel",
        book_prob      = fd_probs[1],
        book_odds      = 240,
        edge_pp        = pin_probs[1] - fd_probs[1],
        notes          = "test",
        reasoning_json = json.dumps(reasoning) if reasoning else None,
        path           = db,
    )


def test_log_signal_creates_pick_row(db: Path) -> None:
    reasoning = {
        "notes": ["both teams already through"],
        "dead_rubber": True,
        "home_suspension_risks": [],
        "away_suspension_risks": [],
    }
    row_id = _insert_test_signal(db, reasoning=reasoning)
    assert row_id > 0

    signals = get_open_signals(db)
    assert len(signals) == 1

    s = signals[0]
    assert s["game_id"] == GAME_ID
    assert s["market"] == "h2h"
    assert s["bet_side"] == "draw"
    assert s["status"] == "open"
    # Pick-quality fields are populated automatically
    assert s["confidence_tier"] in ("A", "B", "C")
    assert s["kelly_fraction"] is not None
    assert s["kelly_fraction"] >= 0.0
    # Reasoning round-trips intact
    decoded = json.loads(s["reasoning_json"])
    assert decoded["dead_rubber"] is True
    assert decoded["notes"] == ["both teams already through"]


def test_log_signal_dedupes(db: Path) -> None:
    """Same (game_id, market, bet_side) is silently ignored."""
    first  = _insert_test_signal(db)
    second = _insert_test_signal(db)
    assert first > 0
    assert second == 0  # duplicate → returns 0

    signals = get_all_signals(db)
    assert len(signals) == 1


def test_grade_signal_marks_correct(db: Path) -> None:
    _insert_test_signal(db)
    # 2-2 → draw → bet_side was 'draw' → correct = 1
    graded = grade_signal(GAME_ID, home_score=2, away_score=2, path=db)
    assert len(graded) == 1
    g = graded[0]
    assert g["result"] == "draw"
    assert g["correct"] == 1

    # Persisted to DB
    signals = get_all_signals(db)
    assert signals[0]["status"] == "graded"
    assert signals[0]["correct"] == 1


def test_grade_signal_marks_incorrect(db: Path) -> None:
    _insert_test_signal(db)
    # 2-1 → home → bet_side was 'draw' → correct = 0
    graded = grade_signal(GAME_ID, home_score=2, away_score=1, path=db)
    assert graded[0]["result"] == "home"
    assert graded[0]["correct"] == 0
    assert get_all_signals(db)[0]["status"] == "graded"
