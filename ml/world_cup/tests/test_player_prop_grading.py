"""
Tests for player-prop grading via API-Football fixture events.

Coverage (per the spec):
  1. Scorer hit: Mbappé in scorers → his anytime-scorer signal grades WIN
  2. Scorer miss: Mbappé NOT in scorers → grades LOSS
  3. Unresolved fixture: no events available → signal stays OPEN, retries next run
  4. Name normalization: "K. Mbappé" matches "Kylian Mbappe" via the alias map
  5. Multiple goals same player: still single WIN (anytime, not "N or more")
  6. Own goals don't credit the kicker
  7. Penalty-shootout goals don't credit the kicker (anytime settles at 90+ET)

We mock the API-Football _get helper so tests don't hit the network.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest


@pytest.fixture
def db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    p = tmp_path / "wc_signal_log.db"
    from ml.world_cup import signal_logger
    monkeypatch.setattr(signal_logger, "DB_PATH", p)
    return p


def _log_prop(db: Path, **kwargs: Any) -> int:
    """Log a player-prop signal via the real function. Returns row id."""
    from ml.world_cup.signal_logger import log_player_prop_signal
    defaults: Dict[str, Any] = {
        "game_id":       "g1",
        "game_date":     "2026-06-15",
        "home_team":     "France",
        "away_team":     "Argentina",
        "commence_time": "2026-06-15T19:00:00Z",
        "market":        "player_goal_scorer_anytime",
        "bet_side":      "yes",
        "player_name":   "Kylian Mbappe",
        "api_player_id": 99,
        "prior_prob":    0.55,
        "book":          "fanduel",
        "book_prob":     0.40,
        "book_odds":     +150.0,
        "edge_pp":       0.15,
        "tournament":    "FIFA World Cup",
        "path":          db,
    }
    defaults.update(kwargs)
    return log_player_prop_signal(**defaults)


def _read_row(db: Path, row_id: int) -> Dict[str, Any]:
    conn = sqlite3.connect(db); conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT * FROM soccer_signals WHERE id = ?", (row_id,)).fetchone()
    conn.close()
    assert row is not None
    return dict(row)


# ── 1. Scorer hit ─────────────────────────────────────────────────────────────

def test_player_scored_grades_win(db: Path) -> None:
    """Mbappé scored — his anytime-scorer YES bet wins."""
    from ml.world_cup.signal_logger import grade_signal
    rid = _log_prop(db, player_name="Kylian Mbappe")
    # scorers set comes from extract_goalscorers — canonical names
    grade_signal("g1", home_score=2, away_score=1,
                 scorers={"Kylian Mbappe", "Lionel Messi"}, path=db)
    row = _read_row(db, rid)
    assert row["status"]  == "graded"
    assert row["correct"] == 1
    assert row["result"]  == "scored"


# ── 2. Scorer miss ────────────────────────────────────────────────────────────

def test_player_did_not_score_grades_loss(db: Path) -> None:
    """Mbappé NOT in scorers — bet loses."""
    from ml.world_cup.signal_logger import grade_signal
    rid = _log_prop(db, player_name="Kylian Mbappe")
    grade_signal("g1", home_score=1, away_score=0,
                 scorers={"Antoine Griezmann"}, path=db)
    row = _read_row(db, rid)
    assert row["status"]  == "graded"
    assert row["correct"] == 0
    assert row["result"]  == "no_score"


# ── 3. Unresolved fixture (no events available yet) ──────────────────────────

def test_unresolved_fixture_leaves_signal_open(db: Path) -> None:
    """When the grader can't fetch fixture events, the player-prop row
    stays OPEN — game-level rows can still grade against home/away score."""
    from ml.world_cup.signal_logger import grade_signal
    rid = _log_prop(db, player_name="Kylian Mbappe")
    # scorers=None signals "unresolved" — grade_signal must NOT touch the row
    grade_signal("g1", home_score=2, away_score=1, scorers=None, path=db)
    row = _read_row(db, rid)
    assert row["status"] == "open"
    assert row["correct"] is None


def test_unresolved_fixture_doesnt_block_game_level_grading(db: Path) -> None:
    """A game-level h2h signal on the same game should grade even when
    fixture events aren't available for the player-prop sibling."""
    from ml.world_cup.signal_logger import grade_signal, log_signal
    prop_id = _log_prop(db, player_name="Kylian Mbappe")
    h2h_id  = log_signal(
        game_id="g1", game_date="2026-06-15",
        home_team="France", away_team="Argentina",
        commence_time="2026-06-15T19:00:00Z",
        market="h2h", bet_side="home",
        pinnacle_prob=0.55, book="fanduel", book_prob=0.45,
        book_odds=+120, edge_pp=0.10, path=db,
    )
    grade_signal("g1", home_score=2, away_score=1, scorers=None, path=db)
    prop_row = _read_row(db, prop_id)
    h2h_row  = _read_row(db, h2h_id)
    assert prop_row["status"] == "open"          # left for retry
    assert h2h_row["status"]  == "graded"        # graded against score
    assert h2h_row["correct"] == 1                # home win


# ── 4. Name normalization (alias map handles K. Mbappé ↔ Kylian Mbappe) ──────

def test_name_normalization_canonical_match(db: Path) -> None:
    """Signal stored as 'Kylian Mbappe' (canonical) matches a scorer
    extracted as 'Kylian Mbappé Lottin' from API-Football. The
    normalization step on extract_goalscorers + grade_player_anytime
    collapses both to 'Kylian Mbappe'."""
    from ml.world_cup.fixture_events import extract_goalscorers, grade_player_anytime
    # Simulate API-Football returning the long-name form
    events = [{
        "type": "Goal",
        "detail": "Normal Goal",
        "time": {"elapsed": 33},
        "player": {"name": "Kylian Mbappé Lottin"},
    }]
    scorers = extract_goalscorers(events)
    assert "Kylian Mbappe" in scorers
    # And the grade-helper returns 1 even though the input came in long form
    assert grade_player_anytime("K. Mbappé", scorers) == 1


# ── 5. Multiple goals same player ────────────────────────────────────────────

def test_multiple_goals_same_player_grades_single_win(db: Path) -> None:
    """Anytime market settles on 'did you score at least once' —
    multiple goals don't change the result. Implemented via set membership."""
    from ml.world_cup.fixture_events import extract_goalscorers
    from ml.world_cup.signal_logger import grade_signal
    events = [
        {"type": "Goal", "detail": "Normal Goal", "time": {"elapsed": 12},
         "player": {"name": "Kylian Mbappé"}},
        {"type": "Goal", "detail": "Normal Goal", "time": {"elapsed": 67},
         "player": {"name": "Kylian Mbappé"}},
        {"type": "Goal", "detail": "Normal Goal", "time": {"elapsed": 88},
         "player": {"name": "Kylian Mbappé"}},  # Hat trick
    ]
    scorers = extract_goalscorers(events)
    assert len(scorers) == 1  # set collapses duplicates
    rid = _log_prop(db, player_name="Kylian Mbappe")
    grade_signal("g1", home_score=3, away_score=0, scorers=scorers, path=db)
    row = _read_row(db, rid)
    assert row["correct"] == 1
    assert row["status"]  == "graded"


# ── 6. Own goals don't credit the kicker ─────────────────────────────────────

def test_own_goal_doesnt_credit_player(db: Path) -> None:
    """If Mbappé puts it in his own net, that's NOT an anytime-scorer
    credit for him. extract_goalscorers must drop 'Own Goal' detail events."""
    from ml.world_cup.fixture_events import extract_goalscorers
    events = [
        # Mbappé own goal — should NOT count
        {"type": "Goal", "detail": "Own Goal", "time": {"elapsed": 23},
         "player": {"name": "Kylian Mbappé"}},
        # Messi normal goal — should count
        {"type": "Goal", "detail": "Normal Goal", "time": {"elapsed": 78},
         "player": {"name": "Lionel Messi"}},
    ]
    scorers = extract_goalscorers(events)
    assert "Kylian Mbappe" not in scorers
    assert "Lionel Messi" in scorers


# ── 7. Penalty-shootout goals don't credit ───────────────────────────────────

def test_shootout_goal_doesnt_credit_player() -> None:
    """Anytime markets settle at 90+ET. Shootout goals (elapsed > 120)
    must not credit the player."""
    from ml.world_cup.fixture_events import extract_goalscorers
    events = [
        # Regulation goal — counts
        {"type": "Goal", "detail": "Normal Goal", "time": {"elapsed": 45},
         "player": {"name": "Lionel Messi"}},
        # Shootout goal — doesn't count
        {"type": "Goal", "detail": "Penalty", "time": {"elapsed": 130},
         "player": {"name": "Kylian Mbappé"}},
    ]
    scorers = extract_goalscorers(events)
    assert "Lionel Messi" in scorers
    assert "Kylian Mbappe" not in scorers


# ── 8. Missed penalty doesn't credit ─────────────────────────────────────────

def test_missed_penalty_doesnt_credit(db: Path) -> None:
    """A missed penalty in regulation isn't a 'goal' even though it's a
    Goal-type event. Drop on detail = 'Missed Penalty'."""
    from ml.world_cup.fixture_events import extract_goalscorers
    events = [{
        "type": "Goal", "detail": "Missed Penalty",
        "time": {"elapsed": 60},
        "player": {"name": "Kylian Mbappé"},
    }]
    scorers = extract_goalscorers(events)
    assert "Kylian Mbappe" not in scorers


# ── 9. End-to-end: grade_results.run() pulls scorers + grades prop signals ──

def test_grade_results_end_to_end_with_mocked_apifootball(
    db: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Full path: open prop signal + open h2h signal on the same game.
    Mock the Odds API scores fetch AND the API-Football fixture-events
    fetch. Both should grade correctly."""
    from ml.world_cup import grade_results as gr
    from ml.world_cup import fixture_events as fx
    from ml.world_cup.signal_logger import log_signal

    # Two signals on the same WC game
    _log_prop(db, game_id="wc1", player_name="Kylian Mbappe",
              home_team="France", away_team="Argentina", game_date="2026-06-15")
    log_signal(
        game_id="wc1", game_date="2026-06-15",
        home_team="France", away_team="Argentina",
        commence_time="2026-06-15T19:00:00Z",
        market="h2h", bet_side="home",
        pinnacle_prob=0.55, book="fanduel", book_prob=0.45,
        book_odds=+125, edge_pp=0.10, path=db,
    )

    # Mock Odds API scores
    def stub_scores(sport_key: str, days_back: int = 3) -> List[Dict[str, Any]]:
        if sport_key == "soccer_fifa_world_cup":
            return [{
                "id": "wc1", "completed": True,
                "home_team": "France", "away_team": "Argentina",
                "scores": [
                    {"name": "France",    "score": "2"},
                    {"name": "Argentina", "score": "1"},
                ],
            }]
        return []
    monkeypatch.setattr(gr, "fetch_scores_for_sport", stub_scores)

    # Mock API-Football fixture-events — Mbappé scored once in regulation
    monkeypatch.setattr(fx, "find_api_football_fixture",
        lambda home, away, date: 12345)
    monkeypatch.setattr(fx, "fetch_fixture_events", lambda fid: [
        {"type": "Goal", "detail": "Normal Goal", "time": {"elapsed": 33},
         "player": {"name": "Kylian Mbappé"}},
    ])

    gr.run(days_back=3)

    # Both signals should be graded after the run
    conn = sqlite3.connect(db); conn.row_factory = sqlite3.Row
    rows = {(r["market"], r["bet_side"]): dict(r)
            for r in conn.execute("SELECT * FROM soccer_signals").fetchall()}
    conn.close()
    assert rows[("h2h", "home")]["status"]  == "graded"
    assert rows[("h2h", "home")]["correct"] == 1
    assert rows[("player_goal_scorer_anytime", "yes")]["status"]  == "graded"
    assert rows[("player_goal_scorer_anytime", "yes")]["correct"] == 1


# ── 10. Game-level grading still unaffected (regression guard) ───────────────

def test_game_level_grading_untouched_with_scorers_passed(db: Path) -> None:
    """Passing scorers shouldn't affect how h2h/totals/AH grade. They use
    home_score/away_score; scorers parameter is ignored for them."""
    from ml.world_cup.signal_logger import grade_signal, log_signal
    h2h_id = log_signal(
        game_id="g1", game_date="2026-06-15",
        home_team="France", away_team="Argentina",
        commence_time="2026-06-15T19:00:00Z",
        market="h2h", bet_side="away",
        pinnacle_prob=0.40, book="fanduel", book_prob=0.50,
        book_odds=+200, edge_pp=0.10, path=db,
    )
    grade_signal("g1", home_score=0, away_score=2,
                 scorers={"Lionel Messi"}, path=db)
    row = _read_row(db, h2h_id)
    assert row["status"]  == "graded"
    assert row["correct"] == 1   # away win 0-2 → away bet wins
