"""
Tests for the StatsBomb historical data pipeline.

We don't hit GitHub here — we exercise the schema, the event-aggregation
helpers (using synthetic StatsBomb-shaped fixtures), and the uplift
integration into players.compute_goalscorer_prior.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from ml.world_cup.historical import (
    _assists_by_player,
    _parse_clock,
    _player_minutes_from_lineups,
    _shot_outcomes_by_player,
    historical_goals_per_90,
    init_historical_tables,
)
from ml.world_cup.players import (
    _tournament_uplift,
    compute_goalscorer_prior,
    init_player_tables,
)


@pytest.fixture
def db(tmp_path: Path) -> Path:
    return tmp_path / "smoke_historical.db"


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

def test_historical_schema(db: Path) -> None:
    init_historical_tables(db)
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    cols = {r["name"] for r in conn.execute(
        "PRAGMA table_info(wc_historical_form)"
    ).fetchall()}
    conn.close()
    for required in ("player_name", "competition", "country", "matches_played",
                     "minutes", "goals", "shots", "shots_on_target", "assists"):
        assert required in cols, f"missing column: {required}"


def test_init_idempotent(db: Path) -> None:
    init_historical_tables(db)
    init_historical_tables(db)  # second call must be safe
    init_historical_tables(db)


# ---------------------------------------------------------------------------
# StatsBomb time parsing
# ---------------------------------------------------------------------------

def test_parse_clock_handles_formats() -> None:
    assert _parse_clock("00:00") == 0
    assert _parse_clock("45:00") == 45
    assert _parse_clock("90:00") == 90
    assert _parse_clock("1:30:00") == 90      # hours:minutes:seconds → minutes
    assert _parse_clock(45) == 45
    assert _parse_clock(45.5) == 45
    assert _parse_clock(None) == 0
    assert _parse_clock("garbage") == 0


# ---------------------------------------------------------------------------
# Minutes aggregation from lineup spells
# ---------------------------------------------------------------------------

def test_player_minutes_full_match() -> None:
    """Played the whole match — 0 to 95."""
    lineup = [{
        "team_name": "Test FC",
        "lineup": [
            {"player_name": "Ironman", "positions": [{"from": "00:00", "to": "95:00"}]},
        ],
    }]
    mins = _player_minutes_from_lineups(lineup)
    assert mins["Ironman"] == 95


def test_player_minutes_subbed_off_at_65() -> None:
    """Came off at 65 — 0 to 65."""
    lineup = [{
        "team_name": "Test FC",
        "lineup": [
            {"player_name": "Subbed Off", "positions": [{"from": "00:00", "to": "65:00"}]},
        ],
    }]
    assert _player_minutes_from_lineups(lineup)["Subbed Off"] == 65


def test_player_minutes_came_on_at_75() -> None:
    """Sub on at 75 — 75 to 95."""
    lineup = [{
        "team_name": "Test FC",
        "lineup": [
            {"player_name": "Late Sub", "positions": [{"from": "75:00", "to": "95:00"}]},
        ],
    }]
    assert _player_minutes_from_lineups(lineup)["Late Sub"] == 20


def test_player_minutes_unused_sub() -> None:
    """Empty positions list = on the bench, never came on = 0 minutes."""
    lineup = [{
        "team_name": "Test FC",
        "lineup": [
            {"player_name": "Bench Warmer", "positions": []},
        ],
    }]
    mins = _player_minutes_from_lineups(lineup)
    # Either 0 explicitly or missing from dict
    assert mins.get("Bench Warmer", 0) == 0


# ---------------------------------------------------------------------------
# Shot / goal extraction from events
# ---------------------------------------------------------------------------

def test_shot_outcomes_aggregation() -> None:
    events = [
        # Two shots, one goal
        {"type": {"name": "Shot"}, "player": {"name": "Mbappé"},
         "shot": {"outcome": {"name": "Goal"}}},
        {"type": {"name": "Shot"}, "player": {"name": "Mbappé"},
         "shot": {"outcome": {"name": "Saved"}}},
        # Off target
        {"type": {"name": "Shot"}, "player": {"name": "Mbappé"},
         "shot": {"outcome": {"name": "Off T"}}},
        # Different player, one missed shot
        {"type": {"name": "Shot"}, "player": {"name": "Griezmann"},
         "shot": {"outcome": {"name": "Wayward"}}},
        # Non-shot events ignored
        {"type": {"name": "Pass"}, "player": {"name": "Mbappé"}},
    ]
    out = _shot_outcomes_by_player(events)
    assert out["Mbappé"] == {"shots": 3, "sot": 2, "goals": 1}
    assert out["Griezmann"] == {"shots": 1, "sot": 0, "goals": 0}


def test_assists_via_pass_flag() -> None:
    """StatsBomb schema 1: assist encoded as pass.goal_assist=True."""
    events = [
        {"type": {"name": "Pass"}, "player": {"name": "Griezmann"},
         "pass": {"goal_assist": True}},
        {"type": {"name": "Pass"}, "player": {"name": "Pogba"},
         "pass": {"goal_assist": False}},  # regular pass
    ]
    assert _assists_by_player(events) == {"Griezmann": 1}


def test_assists_via_dedicated_event_type() -> None:
    """StatsBomb schema 2: dedicated 'Goal Assist' event type."""
    events = [
        {"type": {"name": "Goal Assist"}, "player": {"name": "Modric"}},
        {"type": {"name": "Shot Assist"}, "player": {"name": "Rakitic"}},  # key pass, not assist
    ]
    out = _assists_by_player(events)
    assert out == {"Modric": 1}


# ---------------------------------------------------------------------------
# Historical lookup
# ---------------------------------------------------------------------------

def _insert_historical(db: Path, name: str, comp: str, goals: int, minutes: int) -> None:
    init_historical_tables(db)
    conn = sqlite3.connect(db)
    conn.execute(
        """INSERT INTO wc_historical_form
           (player_name, competition, matches_played, minutes, goals, shots, shots_on_target, assists, updated_at)
           VALUES (?,?,?,?,?,?,?,?,datetime('now'))""",
        (name, comp, max(1, minutes // 80), minutes, goals, goals * 4, goals * 2, 0),
    )
    conn.commit()
    conn.close()


def test_historical_goals_per_90_aggregates_across_tournaments(db: Path) -> None:
    """Mbappé scored 4 in 6 (550 min) at WC 2018 and 8 in 7 (650 min) at WC 2022.
    Aggregate g/90 = 12 / ((550+650)/90) = 12 / 13.33 = 0.90."""
    _insert_historical(db, "Mbappé", "WC 2018", goals=4, minutes=550)
    _insert_historical(db, "Mbappé", "WC 2022", goals=8, minutes=650)
    rate = historical_goals_per_90("Mbappé", db)
    assert rate is not None
    assert rate == pytest.approx(12 / ((550 + 650) / 90.0), abs=1e-3)


def test_historical_goals_per_90_returns_none_for_low_minutes(db: Path) -> None:
    _insert_historical(db, "First Timer", "WC 2022", goals=0, minutes=60)
    assert historical_goals_per_90("First Timer", db) is None


def test_historical_goals_per_90_missing_player(db: Path) -> None:
    init_historical_tables(db)
    assert historical_goals_per_90("Nobody", db) is None


# ---------------------------------------------------------------------------
# Tournament uplift integration
# ---------------------------------------------------------------------------

def test_tournament_uplift_no_history_returns_neutral(db: Path) -> None:
    init_historical_tables(db)
    assert _tournament_uplift("Unknown Player", club_gpm=0.5, path=db) == 1.0


def test_tournament_uplift_raises_for_overperformers(db: Path) -> None:
    """Mbappé club rate ~0.7 g/90, WC rate ~0.9 g/90 → uplift > 1.0."""
    _insert_historical(db, "Mbappé", "WC 2018", goals=4, minutes=550)
    _insert_historical(db, "Mbappé", "WC 2022", goals=8, minutes=650)
    uplift = _tournament_uplift("Mbappé", club_gpm=0.7, path=db)
    assert uplift > 1.0
    # Bounded — even if intl rate were way higher, capped at 2.0
    assert uplift <= 2.0


def test_tournament_uplift_lowers_for_underperformers(db: Path) -> None:
    """Player with high club rate but low WC rate → uplift < 1.0."""
    _insert_historical(db, "Choke Artist", "WC 2018", goals=0, minutes=500)
    _insert_historical(db, "Choke Artist", "WC 2022", goals=1, minutes=400)
    uplift = _tournament_uplift("Choke Artist", club_gpm=0.8, path=db)
    assert uplift < 1.0
    # Floor enforced at 0.5
    assert uplift >= 0.5


def test_tournament_uplift_floor_prevents_zero(db: Path) -> None:
    """Even if a player scored 0 in past tournaments, the prior shouldn't
    be wiped to ~0 — Pelé's prior at 17 was 'first WC' too. Floor=0.5×."""
    _insert_historical(db, "Drought", "WC 2018", goals=0, minutes=540)
    _insert_historical(db, "Drought", "WC 2022", goals=0, minutes=540)
    uplift = _tournament_uplift("Drought", club_gpm=0.8, path=db)
    assert uplift == 0.5  # exact floor


# ---------------------------------------------------------------------------
# End-to-end: prior incorporates the uplift
# ---------------------------------------------------------------------------

def test_compute_prior_includes_intl_uplift(db: Path) -> None:
    """A player who has historical WC overperformance should get a higher
    prior than the same player without that history."""
    init_player_tables(db)
    # Same club form for both players (20 goals in 2700 min ≈ 0.667 g/90)
    conn = sqlite3.connect(db)
    conn.execute(
        """INSERT INTO wc_players
           (api_player_id, player_name, team_name, position, updated_at)
           VALUES (1, 'WC Specialist', 'France', 'Attacker', datetime('now')),
                  (2, 'Club Only',     'France', 'Attacker', datetime('now'))""")
    conn.execute(
        """INSERT INTO wc_player_form
           (api_player_id, season, club_league_id, club_name,
            appearances, minutes, goals, position, updated_at)
           VALUES (1, 2025, 61, 'PSG', 30, 2700, 20, 'Attacker', datetime('now')),
                  (2, 2025, 61, 'PSG', 30, 2700, 20, 'Attacker', datetime('now'))""")
    conn.commit()
    conn.close()
    # WC Specialist has overperformed in WC historically
    _insert_historical(db, "WC Specialist", "WC 2018", goals=4, minutes=550)
    _insert_historical(db, "WC Specialist", "WC 2022", goals=8, minutes=650)
    # Club Only has no historical international data

    specialist = compute_goalscorer_prior(1, path=db)
    club_only  = compute_goalscorer_prior(2, path=db)
    assert specialist is not None and club_only is not None
    assert specialist["intl_uplift"] > 1.0
    assert club_only["intl_uplift"] == 1.0
    # Higher uplift → higher anytime prob
    assert specialist["anytime_scorer_prob"] > club_only["anytime_scorer_prob"]
