"""
Tests for the multi-tournament grader. Before Phase 2.1, the grader was
WC-only — Premier League / La Liga / etc. signals would sit open forever
even after games finished. These tests cover the fix.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any, Dict, List

import pytest


@pytest.fixture
def db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    p = tmp_path / "wc_signal_log.db"
    from ml.world_cup import signal_logger, grade_results
    monkeypatch.setattr(signal_logger,  "DB_PATH", p)
    # grade_results imports init_db / DB_PATH from signal_logger; the
    # monkeypatch above covers it via the module attribute.
    monkeypatch.setenv("ODDS_API_KEY", "stub-key")
    return p


def _log_signal(db: Path, **kwargs: Any) -> int:
    """Convenience: log a signal via the real function, ensuring path is
    respected. Returns the row id."""
    from ml.world_cup.signal_logger import log_signal
    defaults: Dict[str, Any] = {
        "game_date":     "2026-05-25",
        "home_team":     "Liverpool",
        "away_team":     "Arsenal",
        "commence_time": "2026-05-25T15:00:00Z",
        "market":        "h2h",
        "bet_side":      "home",
        "pinnacle_prob": 0.50,
        "book":          "fanduel",
        "book_prob":     0.45,
        "book_odds":     +120,
        "edge_pp":       0.05,
        "path":          db,
    }
    defaults.update(kwargs)
    return log_signal(**defaults)


# ── tournament → sport key map ───────────────────────────────────────────────

def test_sport_key_mapping() -> None:
    from ml.world_cup.grade_results import _sport_key_for
    assert _sport_key_for("FIFA World Cup")  == "soccer_fifa_world_cup"
    assert _sport_key_for("Premier League")  == "soccer_epl"
    assert _sport_key_for("La Liga")         == "soccer_spain_la_liga"
    assert _sport_key_for("Bundesliga")      == "soccer_germany_bundesliga"
    assert _sport_key_for("Serie A")         == "soccer_italy_serie_a"
    assert _sport_key_for("Ligue 1")         == "soccer_france_ligue_one"
    assert _sport_key_for("UCL")             == "soccer_uefa_champs_league"


def test_sport_key_unknown_falls_back_to_wc() -> None:
    """Defensive default for legacy rows + unknown labels."""
    from ml.world_cup.grade_results import _sport_key_for
    assert _sport_key_for(None) == "soccer_fifa_world_cup"
    assert _sport_key_for("")   == "soccer_fifa_world_cup"
    assert _sport_key_for("Mystery Cup") == "soccer_fifa_world_cup"


# ── multi-sport scores fetch (one call per unique sport) ─────────────────────

def test_grader_calls_scores_per_unique_sport(
    db: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Three open signals across WC + EPL + La Liga should trigger exactly
    three /scores calls (not one, not seven)."""
    from ml.world_cup import grade_results as gr

    _log_signal(db, game_id="g-wc-1",   tournament="FIFA World Cup")
    _log_signal(db, game_id="g-epl-1",  tournament="Premier League",  home_team="Tottenham", away_team="Chelsea")
    _log_signal(db, game_id="g-liga-1", tournament="La Liga",         home_team="Madrid",    away_team="Barca")

    calls: List[str] = []
    def stub(sport_key: str, days_back: int = 3) -> List[Dict[str, Any]]:
        calls.append(sport_key)
        return []  # all "not found yet"
    monkeypatch.setattr(gr, "fetch_scores_for_sport", stub)

    gr.run(days_back=3)

    assert sorted(calls) == sorted([
        "soccer_fifa_world_cup",
        "soccer_epl",
        "soccer_spain_la_liga",
    ])


def test_grader_grades_epl_signal_correctly(
    db: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An open EPL h2h home-side signal on Liverpool 2-1 Arsenal should
    grade to WIN — the bug we're fixing is that this was failing because
    the grader only fetched WC scores."""
    import sqlite3
    from ml.world_cup import grade_results as gr

    _log_signal(db,
        game_id="g-epl-99", tournament="Premier League",
        home_team="Liverpool", away_team="Arsenal",
        market="h2h", bet_side="home",
        pinnacle_prob=0.60, book_prob=0.45, edge_pp=0.15, book_odds=+150,
    )

    def stub(sport_key: str, days_back: int = 3) -> List[Dict[str, Any]]:
        if sport_key == "soccer_epl":
            return [{
                "id": "g-epl-99", "completed": True,
                "home_team": "Liverpool", "away_team": "Arsenal",
                "scores": [
                    {"name": "Liverpool", "score": "2"},
                    {"name": "Arsenal",   "score": "1"},
                ],
            }]
        return []
    monkeypatch.setattr(gr, "fetch_scores_for_sport", stub)

    gr.run(days_back=3)

    conn = sqlite3.connect(db); conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT * FROM soccer_signals WHERE game_id = 'g-epl-99'").fetchone()
    conn.close()
    assert row["status"]  == "graded"
    assert row["correct"] == 1   # home bet won when home scored more
    assert row["home_score"] == 2
    assert row["away_score"] == 1


def test_grader_one_sport_failure_doesnt_block_others(
    db: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If the Odds API call fails for EPL, the WC + La Liga grader
    paths must still run cleanly."""
    import sqlite3
    from ml.world_cup import grade_results as gr

    _log_signal(db, game_id="g-wc-1",  tournament="FIFA World Cup",
                home_team="France",  away_team="Brazil",
                pinnacle_prob=0.55, book_prob=0.40, edge_pp=0.15)
    _log_signal(db, game_id="g-epl-1", tournament="Premier League",
                home_team="Liverpool", away_team="Arsenal")
    _log_signal(db, game_id="g-liga-1", tournament="La Liga",
                home_team="Madrid",  away_team="Barca",
                pinnacle_prob=0.50, book_prob=0.35, edge_pp=0.15)

    def stub(sport_key: str, days_back: int = 3) -> List[Dict[str, Any]]:
        if sport_key == "soccer_epl":
            raise RuntimeError("Odds API blip on EPL")
        if sport_key == "soccer_fifa_world_cup":
            return [{
                "id": "g-wc-1", "completed": True,
                "home_team": "France", "away_team": "Brazil",
                "scores": [
                    {"name": "France", "score": "3"},
                    {"name": "Brazil", "score": "1"},
                ],
            }]
        if sport_key == "soccer_spain_la_liga":
            return [{
                "id": "g-liga-1", "completed": True,
                "home_team": "Madrid", "away_team": "Barca",
                "scores": [
                    {"name": "Madrid", "score": "2"},
                    {"name": "Barca",  "score": "0"},
                ],
            }]
        return []
    monkeypatch.setattr(gr, "fetch_scores_for_sport", stub)

    gr.run(days_back=3)

    conn = sqlite3.connect(db); conn.row_factory = sqlite3.Row
    rows = {r["game_id"]: dict(r) for r in conn.execute("SELECT * FROM soccer_signals").fetchall()}
    conn.close()
    assert rows["g-wc-1"]["status"]   == "graded"
    assert rows["g-wc-1"]["correct"]  == 1   # home (France) won 3-1
    assert rows["g-liga-1"]["status"] == "graded"
    assert rows["g-liga-1"]["correct"] == 1  # home (Madrid) won 2-0
    # EPL signal should still be open — its sport's fetch failed
    assert rows["g-epl-1"]["status"] == "open"


def test_grader_no_open_signals_short_circuits(
    db: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With nothing open to grade, the grader shouldn't call the scores
    endpoint at all (saves credits)."""
    from ml.world_cup import grade_results as gr
    calls: List[str] = []
    monkeypatch.setattr(gr, "fetch_scores_for_sport",
        lambda sport_key, days_back=3: calls.append(sport_key) or [])
    gr.run(days_back=3)
    assert calls == []


def test_grader_handles_legacy_null_tournament_row(
    db: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Rows logged before the tournament column existed have NULL there.
    The grader should route those to WC (the legacy default)."""
    import sqlite3
    from ml.world_cup import grade_results as gr

    # Insert a row directly with NULL tournament to simulate legacy data.
    from ml.world_cup.signal_logger import init_db
    init_db(db)
    conn = sqlite3.connect(db)
    conn.execute(
        """INSERT INTO soccer_signals
           (game_id, game_date, home_team, away_team, commence_time,
            tournament, market, bet_side, pinnacle_prob, book, book_prob,
            book_odds, edge_pp, status, detected_at)
           VALUES ('g-legacy', '2026-05-25', 'France', 'Brazil',
                   '2026-05-25T15:00:00Z',
                   NULL, 'h2h', 'home', 0.55, 'fanduel', 0.40,
                   +130, 0.15, 'open', datetime('now'))""",
    )
    conn.commit()
    conn.close()

    calls: List[str] = []
    def stub(sport_key, days_back=3):
        calls.append(sport_key)
        return []
    monkeypatch.setattr(gr, "fetch_scores_for_sport", stub)
    gr.run(days_back=3)
    assert calls == ["soccer_fifa_world_cup"]
