"""Tests for sportmonks_form helpers (no network).

Covers:
  - rank-based minute estimate (the conservative heuristic)
  - topscorer_to_form_row translation (player_id, season, goals, etc.)
  - upsert_form_row with idempotency + cross-league updates
"""
from __future__ import annotations

import sqlite3

import pytest

from ml.world_cup.sportmonks_form import (
    GOAL_TOPSCORER_TYPE_ID,
    LEAGUES,
    _estimate_minutes_from_rank,
    _ensure_table,
    topscorer_to_form_row,
    upsert_form_row,
)


# ── Constants ────────────────────────────────────────────────────────────────

def test_goal_type_id_pinned():
    """If Sportmonks rotates type IDs, this test screams first."""
    assert GOAL_TOPSCORER_TYPE_ID == 208


def test_leagues_cover_big5_and_continental():
    names = {lg["name"] for lg in LEAGUES}
    assert {"Premier League", "La Liga", "Bundesliga", "Serie A", "Ligue 1"} <= names
    assert "Champions League" in names
    # Sportmonks IDs we observed live — locking them so a typo breaks loud
    ids = {lg["name"]: lg["id"] for lg in LEAGUES}
    assert ids["Premier League"] == 8
    assert ids["La Liga"] == 564
    assert ids["Bundesliga"] == 82
    assert ids["Serie A"] == 384
    assert ids["Ligue 1"] == 301


# ── Minutes estimate ─────────────────────────────────────────────────────────

def test_estimate_minutes_monotonic_by_rank():
    """Higher rank = fewer minutes assumed (conservative for unknown depth)."""
    assert _estimate_minutes_from_rank(1) > _estimate_minutes_from_rank(10) > _estimate_minutes_from_rank(25)


def test_estimate_minutes_concrete_values():
    """Snapshot the exact buckets so changes are explicit."""
    assert _estimate_minutes_from_rank(1)  == 2700
    assert _estimate_minutes_from_rank(5)  == 2700
    assert _estimate_minutes_from_rank(6)  == 2200
    assert _estimate_minutes_from_rank(15) == 2200
    assert _estimate_minutes_from_rank(16) == 1800
    assert _estimate_minutes_from_rank(25) == 1800


# ── Row translation ──────────────────────────────────────────────────────────

def _sample_topscorer(player_id=154421, total=27, position=1, name="Erling Haaland"):
    return {
        "player_id": player_id,
        "total": total,
        "position": position,
        "player": {"id": player_id, "display_name": name},
    }


def test_topscorer_to_form_row_happy_path():
    row = topscorer_to_form_row(
        _sample_topscorer(),
        league_id=8,
        league_name="Premier League",
        season_id=25583,
    )
    assert row is not None
    assert row["api_player_id"] == 154421
    assert row["season"] == 25583
    assert row["club_league_id"] == 8
    assert row["club_name"] == "Premier League"
    assert row["goals"] == 27
    assert row["minutes"] == 2700  # rank 1
    # appearances derived from minutes / 80 = 33.75 → 33 (int floor)
    assert 30 <= row["appearances"] <= 35


def test_topscorer_to_form_row_picks_player_id_from_nested():
    """When top-level player_id is missing, fall back to player.id."""
    item = _sample_topscorer()
    item["player_id"] = None
    row = topscorer_to_form_row(
        item, league_id=8, league_name="Premier League", season_id=25583,
    )
    assert row is not None
    assert row["api_player_id"] == 154421


def test_topscorer_to_form_row_skips_when_no_player_id():
    item = _sample_topscorer()
    item["player_id"] = None
    item["player"]["id"] = None
    assert topscorer_to_form_row(
        item, league_id=8, league_name="Premier League", season_id=25583,
    ) is None


def test_topscorer_to_form_row_skips_when_no_goals():
    item = _sample_topscorer()
    item["total"] = None
    assert topscorer_to_form_row(
        item, league_id=8, league_name="Premier League", season_id=25583,
    ) is None


def test_topscorer_to_form_row_minutes_by_rank():
    """Bottom of top-25 gets lower estimated minutes."""
    row = topscorer_to_form_row(
        _sample_topscorer(position=25, total=8),
        league_id=8, league_name="Premier League", season_id=25583,
    )
    assert row["minutes"] == 1800


# ── Upsert ───────────────────────────────────────────────────────────────────

@pytest.fixture
def in_memory_db():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    _ensure_table(conn)
    yield conn
    conn.close()


def test_upsert_inserts_clean_row(in_memory_db):
    conn = in_memory_db
    row = topscorer_to_form_row(
        _sample_topscorer(),
        league_id=8, league_name="Premier League", season_id=25583,
    )
    assert upsert_form_row(conn, row) is True
    n = conn.execute("SELECT COUNT(*) FROM wc_player_form").fetchone()[0]
    assert n == 1


def test_upsert_idempotent_same_league_season(in_memory_db):
    """Re-running with same (player, season, league) updates not duplicates."""
    conn = in_memory_db
    row = topscorer_to_form_row(
        _sample_topscorer(total=27),
        league_id=8, league_name="Premier League", season_id=25583,
    )
    upsert_form_row(conn, row)
    # Second pass with updated goal total — should refresh in place
    row2 = topscorer_to_form_row(
        _sample_topscorer(total=30),
        league_id=8, league_name="Premier League", season_id=25583,
    )
    upsert_form_row(conn, row2)
    rows = conn.execute("SELECT goals FROM wc_player_form").fetchall()
    assert len(rows) == 1
    assert rows[0]["goals"] == 30


def test_upsert_keeps_separate_rows_per_league(in_memory_db):
    """Player plays in both Premier League and Champions League — both rows
    survive because (player, season, league) is the uniqueness key."""
    conn = in_memory_db
    pl = topscorer_to_form_row(
        _sample_topscorer(player_id=154421, total=27),
        league_id=8, league_name="Premier League", season_id=25583,
    )
    ucl = topscorer_to_form_row(
        _sample_topscorer(player_id=154421, total=8),
        league_id=2, league_name="Champions League", season_id=25583,
    )
    upsert_form_row(conn, pl)
    upsert_form_row(conn, ucl)
    rows = conn.execute(
        "SELECT club_league_id, goals FROM wc_player_form ORDER BY club_league_id"
    ).fetchall()
    assert len(rows) == 2
    assert {r["club_league_id"]: r["goals"] for r in rows} == {2: 8, 8: 27}


def test_upsert_skips_invalid_payload(in_memory_db):
    conn = in_memory_db
    assert upsert_form_row(conn, {}) is False
    assert upsert_form_row(conn, {"api_player_id": 1}) is False  # no season
    assert upsert_form_row(conn, {"season": 2025}) is False     # no player_id
