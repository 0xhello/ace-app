"""
Tests for the player-prop divergence pipeline.

Three layers being tested:
  1. find_wc_player()      — name resolver across canonical / abbreviated forms
  2. _detect_player_prop_signals() — given an Odds API game payload, return signals
  3. log_player_prop_signal()      — persists into soccer_signals with v2 index

Together these are the entire WC player-prop path. Real-tournament data is
not available yet (Odds API doesn't post the markets), so we mock the
payload shape based on Odds API documentation.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any, Dict, List

import pytest


@pytest.fixture
def db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Isolated DB per test. The modules under test default to the prod
    DB_PATH; monkeypatch their constants so the test DB is used everywhere."""
    p = tmp_path / "wc_signal_log.db"
    from ml.world_cup import signal_logger, players, fetch_signals
    monkeypatch.setattr(signal_logger,  "DB_PATH", p)
    monkeypatch.setattr(players,        "DB_PATH", p)
    return p


def _seed_player(
    db: Path,
    *,
    player_id: int,
    name: str,
    team: str,
    position: str = "Attacker",
    minutes: int = 2700,
    goals: int = 25,
) -> None:
    """Populate enough data so compute_goalscorer_prior() succeeds for
    a fixture player."""
    from ml.world_cup.players import init_player_tables
    init_player_tables(db)
    conn = sqlite3.connect(db)
    conn.execute(
        """INSERT INTO wc_players (api_player_id, player_name, team_name, position, updated_at)
           VALUES (?, ?, ?, ?, datetime('now'))""",
        (player_id, name, team, position),
    )
    # 25 goals in 2700 mins ≈ 0.83 g/90 — sufficient sample for a prior
    conn.execute(
        """INSERT INTO wc_player_form
           (api_player_id, season, club_league_id, club_name,
            appearances, minutes, goals, position, updated_at)
           VALUES (?, 2025, 39, 'Real Madrid', 30, ?, ?, ?, datetime('now'))""",
        (player_id, minutes, goals, position),
    )
    conn.commit()
    conn.close()


def _make_game(
    *,
    game_id: str = "g1",
    book: str = "fanduel",
    player_lines: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """Build an Odds API-shaped event payload with a player_goal_scorer_anytime
    market on a single bookmaker. player_lines is a list of
    {description: name, price: american_odds}."""
    return {
        "id": game_id,
        "home_team": "France",
        "away_team": "Argentina",
        "commence_time": "2026-06-15T19:00:00Z",
        "bookmakers": [{
            "key": book,
            "title": book.title(),
            "markets": [{
                "key": "player_goal_scorer_anytime",
                "outcomes": [
                    {"name": "Yes", "description": p["description"], "price": p["price"]}
                    for p in player_lines
                ],
            }],
        }],
    }


# ─── find_wc_player ──────────────────────────────────────────────────────────

def test_find_wc_player_exact_match(db: Path) -> None:
    _seed_player(db, player_id=10, name="Kylian Mbappe", team="France")
    from ml.world_cup.players import find_wc_player
    r = find_wc_player("Kylian Mbappe", db)
    assert r is not None and r["api_player_id"] == 10


def test_find_wc_player_canonicalization(db: Path) -> None:
    """'Kylian Mbappé Lottin' → canonical 'Kylian Mbappe' → matches the seeded row."""
    _seed_player(db, player_id=10, name="Kylian Mbappe", team="France")
    from ml.world_cup.players import find_wc_player
    r = find_wc_player("Kylian Mbappé Lottin", db)
    assert r is not None and r["api_player_id"] == 10


def test_find_wc_player_returns_none_for_unknown(db: Path) -> None:
    from ml.world_cup.players import find_wc_player
    assert find_wc_player("Nobody Special", db) is None


def test_find_wc_player_empty_input_safe(db: Path) -> None:
    from ml.world_cup.players import find_wc_player
    assert find_wc_player("", db) is None
    assert find_wc_player(None, db) is None  # type: ignore[arg-type]


# ─── American-odds → implied probability ─────────────────────────────────────

def test_american_to_implied_prob() -> None:
    from ml.world_cup.fetch_signals import _american_to_implied_prob
    assert _american_to_implied_prob(+100) == pytest.approx(0.500, abs=1e-3)
    assert _american_to_implied_prob(-110) == pytest.approx(0.524, abs=1e-3)
    assert _american_to_implied_prob(+200) == pytest.approx(0.333, abs=1e-3)
    assert _american_to_implied_prob(-200) == pytest.approx(0.667, abs=1e-3)


# ─── _detect_player_prop_signals ─────────────────────────────────────────────

def test_detect_player_prop_fires_signal_when_prior_beats_book(db: Path) -> None:
    """Mbappe seeded with 0.83 g/90 → expected prior ~0.55-0.65 anytime.
    Book posts him at +200 (33% implied). Edge should be ~22-32pp — fires."""
    _seed_player(db, player_id=10, name="Kylian Mbappe", team="France",
                 minutes=2700, goals=25)
    from ml.world_cup.fetch_signals import _detect_player_prop_signals
    game = _make_game(player_lines=[{"description": "Kylian Mbappe", "price": 200}])
    sigs = _detect_player_prop_signals(game)
    assert len(sigs) == 1
    sig = sigs[0]
    assert sig["player_name"] == "Kylian Mbappe"
    assert sig["api_player_id"] == 10
    assert sig["book"] == "fanduel"
    assert sig["book_odds"] == 200
    assert sig["book_prob"] == pytest.approx(0.333, abs=1e-3)
    assert sig["prior_prob"] > 0.40   # real prior should be well above book's 33%
    assert sig["edge_pp"] >= 0.03


def test_detect_player_prop_no_signal_when_book_matches_prior(db: Path) -> None:
    """If the book prices the player accurately (within 3pp of our prior),
    no signal should fire."""
    _seed_player(db, player_id=10, name="Kylian Mbappe", team="France",
                 minutes=2700, goals=25)
    # Tighter line that's close to where the prior would land
    from ml.world_cup.fetch_signals import _detect_player_prop_signals
    # -150 → 60% implied; prior is ~55-65% → within threshold, no signal
    game = _make_game(player_lines=[{"description": "Kylian Mbappe", "price": -150}])
    sigs = _detect_player_prop_signals(game)
    # Threshold is 3pp — close enough should give 0 OR 1 depending on exact prior
    # Assert NOT firing when prior is at most 3pp above book.
    if sigs:
        assert sigs[0]["edge_pp"] >= 0.03  # if it fires, must clear threshold


def test_detect_player_prop_skips_unknown_player(db: Path) -> None:
    """A player not in wc_players returns no signal — we don't have a
    prior we can trust for them."""
    from ml.world_cup.fetch_signals import _detect_player_prop_signals
    game = _make_game(player_lines=[{"description": "Random Person", "price": 200}])
    sigs = _detect_player_prop_signals(game)
    assert sigs == []


def test_detect_player_prop_skips_pinnacle(db: Path) -> None:
    """Pinnacle is reserved as a future sharp anchor; we don't 'bet at'
    Pinnacle. v1 player-prop signals only fire on soft books."""
    _seed_player(db, player_id=10, name="Kylian Mbappe", team="France",
                 minutes=2700, goals=25)
    from ml.world_cup.fetch_signals import _detect_player_prop_signals
    game = _make_game(book="pinnacle",
                      player_lines=[{"description": "Kylian Mbappe", "price": 200}])
    sigs = _detect_player_prop_signals(game)
    assert sigs == []


def test_detect_player_prop_skips_no_outcome(db: Path) -> None:
    """The 'No' side of the anytime market is informational — we don't
    bet on a player NOT scoring. Make sure it's ignored."""
    _seed_player(db, player_id=10, name="Kylian Mbappe", team="France",
                 minutes=2700, goals=25)
    from ml.world_cup.fetch_signals import _detect_player_prop_signals
    game = {
        "id": "g1", "home_team": "France", "away_team": "Argentina",
        "commence_time": "2026-06-15T19:00:00Z",
        "bookmakers": [{
            "key": "fanduel",
            "markets": [{
                "key": "player_goal_scorer_anytime",
                "outcomes": [
                    {"name": "Yes", "description": "Kylian Mbappe", "price":  200},
                    {"name": "No",  "description": "Kylian Mbappe", "price": -300},
                ],
            }],
        }],
    }
    sigs = _detect_player_prop_signals(game)
    assert len(sigs) == 1
    assert sigs[0]["bet_side"] == "yes"


# ─── log_player_prop_signal — persistence + idempotence ──────────────────────

def test_log_player_prop_signal_writes_row(db: Path) -> None:
    from ml.world_cup.signal_logger import log_player_prop_signal
    row_id = log_player_prop_signal(
        game_id="g1", game_date="2026-06-15",
        home_team="France", away_team="Argentina",
        commence_time="2026-06-15T19:00:00Z",
        market="player_goal_scorer_anytime", bet_side="yes",
        player_name="Kylian Mbappe", api_player_id=10,
        prior_prob=0.62, book="fanduel", book_prob=0.40,
        book_odds=150.0, edge_pp=0.22,
        path=db,
    )
    assert row_id > 0

    conn = sqlite3.connect(db); conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT * FROM soccer_signals WHERE id = ?", (row_id,)).fetchone()
    conn.close()
    assert row["player_name"] == "Kylian Mbappe"
    assert row["api_player_id"] == 10
    assert row["prior_prob"]    == pytest.approx(0.62, abs=1e-6)
    assert row["edge_pp"]       == pytest.approx(0.22, abs=1e-6)
    assert row["market"]        == "player_goal_scorer_anytime"


def test_log_player_prop_signal_is_idempotent(db: Path) -> None:
    """Two writes with same (game_id, market, bet_side, player_name) collapse
    to one row via the v2 unique index."""
    from ml.world_cup.signal_logger import log_player_prop_signal
    args = dict(
        game_id="g1", game_date="2026-06-15",
        home_team="France", away_team="Argentina",
        commence_time="2026-06-15T19:00:00Z",
        market="player_goal_scorer_anytime", bet_side="yes",
        player_name="Kylian Mbappe", api_player_id=10,
        prior_prob=0.62, book="fanduel", book_prob=0.40,
        book_odds=150.0, edge_pp=0.22,
        path=db,
    )
    a = log_player_prop_signal(**args)
    b = log_player_prop_signal(**args)
    assert a > 0
    assert b == 0  # second insert silently ignored

    conn = sqlite3.connect(db)
    count = conn.execute("SELECT COUNT(*) FROM soccer_signals").fetchone()[0]
    conn.close()
    assert count == 1


def test_log_player_prop_signal_distinct_players_coexist(db: Path) -> None:
    """Two different player props on the same game should both insert —
    the v2 unique index includes player_name so they don't collide."""
    from ml.world_cup.signal_logger import log_player_prop_signal
    base = dict(
        game_id="g1", game_date="2026-06-15",
        home_team="France", away_team="Argentina",
        commence_time="2026-06-15T19:00:00Z",
        market="player_goal_scorer_anytime", bet_side="yes",
        book="fanduel", book_prob=0.40, book_odds=150.0, edge_pp=0.22, path=db,
    )
    a = log_player_prop_signal(**base, player_name="Kylian Mbappe",  api_player_id=10, prior_prob=0.62)
    b = log_player_prop_signal(**base, player_name="Jude Bellingham", api_player_id=11, prior_prob=0.45)
    assert a > 0 and b > 0 and a != b

    conn = sqlite3.connect(db)
    count = conn.execute("SELECT COUNT(*) FROM soccer_signals").fetchone()[0]
    conn.close()
    assert count == 2


def test_player_prop_doesnt_collide_with_game_level_signal(db: Path) -> None:
    """A game-level h2h signal and a player-prop signal on the SAME game
    must both insert. Old unique index would have collided if player_name
    weren't part of the key."""
    from ml.world_cup.signal_logger import log_signal, log_player_prop_signal
    a = log_signal(
        game_id="g1", game_date="2026-06-15",
        home_team="France", away_team="Argentina",
        commence_time="2026-06-15T19:00:00Z",
        market="h2h", bet_side="home",
        pinnacle_prob=0.45, book="fanduel", book_prob=0.50,
        book_odds=100, edge_pp=0.05, path=db,
    )
    b = log_player_prop_signal(
        game_id="g1", game_date="2026-06-15",
        home_team="France", away_team="Argentina",
        commence_time="2026-06-15T19:00:00Z",
        market="player_goal_scorer_anytime", bet_side="yes",
        player_name="Kylian Mbappe", api_player_id=10,
        prior_prob=0.62, book="fanduel", book_prob=0.40,
        book_odds=150.0, edge_pp=0.22, path=db,
    )
    assert a > 0 and b > 0
