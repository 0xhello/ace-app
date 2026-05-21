"""
Tests for the European-league + UCL signal orchestrator.

We don't hit the real Odds API. Each test stubs fetch_league_odds (or the
underlying httpx.get) with an Odds-API-shaped payload and asserts the
divergence engine fires the right signals into soccer_signals with the
right `tournament` tag.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List

import pytest


@pytest.fixture
def db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    p = tmp_path / "wc_signal_log.db"
    from ml.world_cup import signal_logger
    monkeypatch.setattr(signal_logger, "DB_PATH", p)
    monkeypatch.setenv("ODDS_API_KEY", "stub-key")
    return p


# ── Helper builders ───────────────────────────────────────────────────────────

def _future_iso(hours: float) -> str:
    return (datetime.now(timezone.utc) + timedelta(hours=hours)).isoformat().replace("+00:00", "Z")


def _h2h_game(
    home: str, away: str,
    pin_home: int = -150, pin_away: int = 200, pin_draw: int = 320,
    soft_home: int = -130, soft_away: int = 220, soft_draw: int = 320,
    soft_book: str = "fanduel",
    game_id: str = "g1",
) -> Dict[str, Any]:
    """Build an Odds API event with an h2h market on Pinnacle + one soft book."""
    return {
        "id": game_id,
        "sport_key": "soccer_epl",
        "home_team": home, "away_team": away,
        "commence_time": _future_iso(24),  # tomorrow, in window
        "bookmakers": [
            {
                "key": "pinnacle", "title": "Pinnacle",
                "markets": [{
                    "key": "h2h",
                    "outcomes": [
                        {"name": home,   "price": pin_home},
                        {"name": away,   "price": pin_away},
                        {"name": "Draw", "price": pin_draw},
                    ],
                }],
            },
            {
                "key": soft_book, "title": soft_book.title(),
                "markets": [{
                    "key": "h2h",
                    "outcomes": [
                        {"name": home,   "price": soft_home},
                        {"name": away,   "price": soft_away},
                        {"name": "Draw", "price": soft_draw},
                    ],
                }],
            },
        ],
    }


# ── _is_league_active ────────────────────────────────────────────────────────

def test_is_league_active_within_window() -> None:
    from ml.soccer.leagues import _is_league_active
    assert _is_league_active(date(2026, 5, 25), now=date(2026, 5, 20)) is True
    assert _is_league_active(date(2026, 5, 25), now=date(2026, 5, 25)) is True  # last-day inclusive


def test_is_league_active_after_season_end() -> None:
    from ml.soccer.leagues import _is_league_active
    assert _is_league_active(date(2026, 5, 25), now=date(2026, 5, 26)) is False


# ── run_league: signals fire, tagged with `tournament` ───────────────────────

def test_run_league_fires_h2h_signal_tagged_with_tournament(
    db: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A real divergence on EPL should land in soccer_signals with
    tournament='Premier League' (not 'FIFA World Cup'). The divergence
    convention: edge = pin_prob − book_prob; positive edge means the
    book has LONGER odds on the side than Pinnacle's de-vigged truth,
    so betting that side at the soft book is +EV.

    Prices chosen so de-vigged HOME prob on Pinnacle is meaningfully
    higher than HOME at FanDuel → fires a home-side signal."""
    import sqlite3
    from ml.soccer import leagues

    # Pinnacle has the favorite at -250 (clear sharp pricing)
    # FanDuel has the favorite at -140 (much weaker price = longer odds)
    # → de-vigged home prob diverges by well over 3pp
    game = _h2h_game(
        home="Liverpool", away="Arsenal",
        pin_home=-250, pin_away=600, pin_draw=400,
        soft_home=-140, soft_away=300, soft_draw=400,
    )
    monkeypatch.setattr(leagues, "fetch_league_odds", lambda sport_key: [game])

    result = leagues.run_league("soccer_epl", "Premier League")
    assert result["games"] == 1
    assert result["signals_fired"] >= 1, "expected at least one divergence on this matchup"

    conn = sqlite3.connect(db); conn.row_factory = sqlite3.Row
    rows = [dict(r) for r in conn.execute("SELECT * FROM soccer_signals").fetchall()]
    conn.close()
    assert len(rows) >= 1
    assert all(r["tournament"] == "Premier League" for r in rows)
    assert all(r["market"] in ("h2h", "totals", "asian_handicap") for r in rows)


def test_run_league_no_pinnacle_no_signal(
    db: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Without a Pinnacle reference line, we don't fire — we need a sharp
    anchor to compare against."""
    import sqlite3
    from ml.soccer import leagues

    game = {
        "id": "g1",
        "home_team": "Liverpool", "away_team": "Arsenal",
        "commence_time": _future_iso(24),
        "bookmakers": [
            {"key": "fanduel", "title": "FanDuel",
             "markets": [{"key": "h2h", "outcomes": [
                 {"name": "Liverpool", "price": -120},
                 {"name": "Arsenal",   "price":  200},
                 {"name": "Draw",      "price":  300},
             ]}]},
        ],
    }
    monkeypatch.setattr(leagues, "fetch_league_odds", lambda sport_key: [game])

    result = leagues.run_league("soccer_epl", "Premier League")
    assert result["signals_fired"] == 0

    # Initialize the table explicitly — when no signals fire, log_signal
    # never runs and the table may not exist yet. We're just verifying
    # the absence of writes, not the absence of the schema.
    from ml.world_cup.signal_logger import init_db
    init_db(db)
    conn = sqlite3.connect(db)
    count = conn.execute("SELECT COUNT(*) FROM soccer_signals").fetchone()[0]
    conn.close()
    assert count == 0


def test_run_league_empty_response_safe(
    db: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """422 / off-season / empty list should return zeros cleanly."""
    from ml.soccer import leagues
    monkeypatch.setattr(leagues, "fetch_league_odds", lambda sport_key: [])
    result = leagues.run_league("soccer_epl", "Premier League")
    assert result == {"signals_fired": 0, "signals_skipped": 0, "games": 0}


def test_run_league_dedupes_on_repeat(
    db: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Running the same game twice should fire signals once; the second
    run sees them as duplicates via the unique index."""
    from ml.soccer import leagues

    # Same aggressive prices as the firing test above so we know a signal
    # actually generates on the first pass.
    game = _h2h_game(home="Liverpool", away="Arsenal",
                     pin_home=-250, pin_away=600, pin_draw=400,
                     soft_home=-140, soft_away=300, soft_draw=400)
    monkeypatch.setattr(leagues, "fetch_league_odds", lambda sport_key: [game])

    a = leagues.run_league("soccer_epl", "Premier League")
    b = leagues.run_league("soccer_epl", "Premier League")
    # First run fired N signals; second run dups them all (signals_skipped > 0
    # or signals_fired == 0; behavior depends on how many markets diverged).
    assert a["signals_fired"] >= 1
    assert b["signals_fired"] == 0


# ── run_active_leagues orchestrator ──────────────────────────────────────────

def test_run_active_leagues_skips_past_season_end(
    db: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Override LEAGUES so all entries are past their active_until — none
    should be scanned (no API spend, returns empty summary)."""
    from ml.soccer import leagues
    monkeypatch.setattr(leagues, "LEAGUES", [
        ("soccer_epl",  "Premier League", date(2020, 1, 1)),
        ("soccer_germany_bundesliga", "Bundesliga", date(2020, 1, 1)),
    ])
    # Should not even attempt to call fetch_league_odds
    monkeypatch.setattr(leagues, "fetch_league_odds",
        lambda sport_key: (_ for _ in ()).throw(AssertionError("should not fetch")))

    summary = leagues.run_active_leagues()
    assert summary == {}


def test_run_active_leagues_runs_in_window(
    db: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When a league is in its active window, the orchestrator scans it."""
    from ml.soccer import leagues
    far_future = date.today() + timedelta(days=90)
    monkeypatch.setattr(leagues, "LEAGUES", [
        ("soccer_epl", "Premier League", far_future),
    ])
    monkeypatch.setattr(leagues, "fetch_league_odds", lambda sport_key: [])

    summary = leagues.run_active_leagues()
    assert "Premier League" in summary
    assert summary["Premier League"]["games"] == 0  # empty stub


def test_run_active_leagues_isolates_failures(
    db: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """One league throwing should not break the others — each gets its
    own try/except in the orchestrator."""
    from ml.soccer import leagues
    far_future = date.today() + timedelta(days=90)
    monkeypatch.setattr(leagues, "LEAGUES", [
        ("soccer_epl",                "Premier League", far_future),
        ("soccer_germany_bundesliga", "Bundesliga",     far_future),
    ])

    calls = {"epl": 0, "bundes": 0}
    def stub(sport_key):
        if sport_key == "soccer_epl":
            calls["epl"] += 1
            raise RuntimeError("transient")
        calls["bundes"] += 1
        return []
    monkeypatch.setattr(leagues, "fetch_league_odds", stub)

    summary = leagues.run_active_leagues()
    # Both leagues should appear in summary even though EPL errored.
    assert "Premier League" in summary
    assert "Bundesliga"     in summary
    assert summary["Premier League"]["signals_fired"] == 0
    assert calls["epl"] >= 1 and calls["bundes"] >= 1


# ── Backward-compat: WC log_signal default tournament unchanged ──────────────

def test_log_signal_default_tournament_is_wc(db: Path) -> None:
    """The tournament parameter defaults to 'FIFA World Cup' so existing
    callers (WC fetch_signals) keep tagging their rows correctly."""
    from ml.world_cup.signal_logger import log_signal
    import sqlite3

    log_signal(
        game_id="g1", game_date="2026-06-15",
        home_team="France", away_team="Argentina",
        commence_time="2026-06-15T19:00:00Z",
        market="h2h", bet_side="home",
        pinnacle_prob=0.45, book="fanduel", book_prob=0.50,
        book_odds=100, edge_pp=0.05, path=db,
    )
    conn = sqlite3.connect(db); conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT tournament FROM soccer_signals WHERE game_id='g1'").fetchone()
    conn.close()
    assert row["tournament"] == "FIFA World Cup"
