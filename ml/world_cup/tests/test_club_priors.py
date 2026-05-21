"""
Tests for the club-league extension of the player-prop pipeline.

The goal: when a player is in EPL/La Liga/etc. but NOT in a WC squad
(e.g. a U23 prospect or a club-only star), the prior compute + player
prop divergence still works because find_wc_player falls back to
club_players and compute_goalscorer_prior resolves via either table.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any, Dict, List

import pytest


@pytest.fixture
def db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    p = tmp_path / "wc_signal_log.db"
    from ml.world_cup import signal_logger, players
    monkeypatch.setattr(signal_logger, "DB_PATH", p)
    monkeypatch.setattr(players,        "DB_PATH", p)
    return p


def _seed_club_player(
    db: Path,
    *,
    player_id: int,
    name: str,
    club: str,
    league_id: int = 39,            # EPL by default
    position: str = "Attacker",
    minutes: int = 2400,
    goals: int = 18,
) -> None:
    """Insert a player into club_players + matching form rows. Mimics
    what sync_club_form does in production."""
    from ml.world_cup.players import init_player_tables
    init_player_tables(db)
    conn = sqlite3.connect(db)
    conn.execute(
        """INSERT INTO club_players
           (api_player_id, player_name, club_name, league_id, position, updated_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'))""",
        (player_id, name, club, league_id, position),
    )
    conn.execute(
        """INSERT INTO wc_player_form
           (api_player_id, season, club_league_id, club_name,
            appearances, minutes, goals, position, updated_at)
           VALUES (?, 2025, ?, ?, 30, ?, ?, ?, datetime('now'))""",
        (player_id, league_id, club, minutes, goals, position),
    )
    conn.commit()
    conn.close()


# ── find_wc_player falls back to club_players ────────────────────────────────

def test_find_player_falls_back_to_club_players(db: Path) -> None:
    """Erling Haaland is in club_players (Man City) but NOT in wc_players
    (Norway didn't qualify for WC 2026). The resolver should still find
    him so club-league prop signals work for him."""
    _seed_club_player(db, player_id=99, name="Erling Haaland", club="Manchester City")
    from ml.world_cup.players import find_wc_player
    row = find_wc_player("Erling Haaland", db)
    assert row is not None
    assert row["api_player_id"] == 99
    assert row["team_name"] == "Manchester City"  # club name surfaces via alias


def test_wc_players_takes_priority_over_club_players(db: Path) -> None:
    """When a player is in BOTH tables (most WC starters are also in a
    club squad), wc_players wins so the team_name shows their national
    team during the tournament context."""
    from ml.world_cup.players import find_wc_player, init_player_tables
    init_player_tables(db)
    conn = sqlite3.connect(db)
    conn.execute(
        """INSERT INTO wc_players (api_player_id, player_name, team_name, position, updated_at)
           VALUES (?, ?, ?, ?, datetime('now'))""",
        (50, "Kylian Mbappe", "France", "Attacker"),
    )
    conn.execute(
        """INSERT INTO club_players (api_player_id, player_name, club_name, league_id, position, updated_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'))""",
        (50, "Kylian Mbappe", "Paris Saint-Germain", 61, "Attacker"),
    )
    conn.commit()
    conn.close()
    row = find_wc_player("Kylian Mbappe", db)
    assert row is not None
    assert row["team_name"] == "France"  # wc_players wins


def test_compute_prior_works_for_club_only_player(db: Path) -> None:
    """compute_goalscorer_prior should succeed for a player that exists
    in club_players + wc_player_form but NOT in wc_players."""
    _seed_club_player(db, player_id=99, name="Erling Haaland", club="Manchester City")
    from ml.world_cup.players import compute_goalscorer_prior
    prior = compute_goalscorer_prior(99, path=db)
    assert prior is not None
    assert prior["api_player_id"] == 99
    assert prior["team_name"] == "Manchester City"
    # 18 goals in 2400 min ≈ 0.675 g/90 → reasonable prior on the order of 40-55%
    assert 0.30 < prior["anytime_scorer_prob"] < 0.75


def test_compute_prior_falls_back_to_club_lookup(db: Path) -> None:
    """If a player_id is in club_players but not wc_players, the prior
    function should fall back gracefully — not return None."""
    _seed_club_player(db, player_id=200, name="Bukayo Saka", club="Arsenal",
                      minutes=2700, goals=14)
    from ml.world_cup.players import compute_goalscorer_prior
    prior = compute_goalscorer_prior(200, path=db)
    assert prior is not None
    assert prior["team_name"] == "Arsenal"


def test_compute_prior_none_for_truly_unknown(db: Path) -> None:
    """When a player isn't in EITHER table, the prior is None — not a
    crash."""
    from ml.world_cup.players import compute_goalscorer_prior
    assert compute_goalscorer_prior(9999, path=db) is None


# ── compute_all_priors walks both tables ─────────────────────────────────────

def test_compute_all_priors_includes_club_players(db: Path) -> None:
    """The bulk-compute should iterate WC squads AND club rosters so the
    club-league prop scanner has priors ready when it runs."""
    from ml.world_cup.players import init_player_tables, compute_all_priors
    init_player_tables(db)
    conn = sqlite3.connect(db)
    # 1 WC player + 1 club-only player + 1 player in BOTH
    conn.execute(
        """INSERT INTO wc_players (api_player_id, player_name, team_name, position, updated_at)
           VALUES (1, 'Player A', 'France',    'Attacker', datetime('now')),
                  (3, 'Player C', 'Argentina', 'Attacker', datetime('now'))""")
    conn.execute(
        """INSERT INTO club_players (api_player_id, player_name, club_name, league_id, position, updated_at)
           VALUES (2, 'Player B', 'Arsenal',   39, 'Attacker', datetime('now')),
                  (3, 'Player C', 'PSG',       61, 'Attacker', datetime('now'))""")
    # Form for all three
    for pid, mins, gls in [(1, 2700, 20), (2, 2400, 16), (3, 2700, 25)]:
        conn.execute(
            """INSERT INTO wc_player_form
               (api_player_id, season, club_league_id, club_name,
                appearances, minutes, goals, position, updated_at)
               VALUES (?, 2025, 39, 'Club', 30, ?, ?, 'Attacker', datetime('now'))""",
            (pid, mins, gls),
        )
    conn.commit()
    conn.close()

    written = compute_all_priors(path=db)
    assert written == 3  # all three players got priors computed

    conn = sqlite3.connect(db); conn.row_factory = sqlite3.Row
    pids_with_priors = {
        r["api_player_id"]
        for r in conn.execute("SELECT api_player_id FROM wc_player_priors").fetchall()
    }
    conn.close()
    assert pids_with_priors == {1, 2, 3}
