"""Tests for sportmonks_squads helpers (no network).

Covers the pure data-transformation surface:
  - position_id → position string mapping
  - _age_from_dob handles valid / missing / malformed input
  - _normalize_squad_row picks the right player_name / id / position
  - upsert_squad inserts cleanly + survives a second pass (idempotent)
"""
from __future__ import annotations

import sqlite3
from datetime import datetime

import pytest

from ml.world_cup.sportmonks_squads import (
    POSITION_BY_ID,
    WC_2026_SEASON_ID,
    _age_from_dob,
    _ensure_table,
    _normalize_squad_row,
    upsert_squad,
)


# ── Position mapping ─────────────────────────────────────────────────────────

def test_position_mapping_covers_all_four_buckets():
    assert POSITION_BY_ID[24] == "Goalkeeper"
    assert POSITION_BY_ID[25] == "Defender"
    assert POSITION_BY_ID[26] == "Midfielder"
    assert POSITION_BY_ID[27] == "Attacker"


def test_season_id_pinned_to_26618():
    """Hard-coded — if Sportmonks renumbers, ingest breaks loudly here first."""
    assert WC_2026_SEASON_ID == 26618


# ── Age extraction ───────────────────────────────────────────────────────────

def test_age_from_known_dob():
    # Marquinhos: born 1994-05-14. With today = 2026-05-27, age = 32.
    age = _age_from_dob("1994-05-14")
    assert age is not None
    # Allow ±1 because the test could run pre/post-birthday in real wall time.
    expected = datetime.now().year - 1994
    if (datetime.now().month, datetime.now().day) < (5, 14):
        expected -= 1
    assert age == expected


def test_age_handles_none_and_malformed():
    assert _age_from_dob(None) is None
    assert _age_from_dob("") is None
    assert _age_from_dob("junk") is None
    assert _age_from_dob("not-a-date") is None


# ── Row normalization ────────────────────────────────────────────────────────

def _sample_player(player_id=96208, position_id=25, jersey=4):
    return {
        "player_id": player_id,
        "position_id": position_id,
        "jersey_number": jersey,
        "player": {
            "id": player_id,
            "display_name": "Marquinhos",
            "name": "Marcos Aoás Corrêa",
            "date_of_birth": "1994-05-14",
            "image_path": "https://cdn.sportmonks.com/players/96208.png",
        },
    }


def test_normalize_picks_display_name_over_full_name():
    row = _normalize_squad_row(_sample_player(), "Brazil")
    assert row is not None
    assert row["player_name"] == "Marquinhos"
    assert row["team_name"] == "Brazil"


def test_normalize_maps_position_id_to_string():
    row = _normalize_squad_row(_sample_player(position_id=27), "Brazil")
    assert row["position"] == "Attacker"


def test_normalize_unknown_position_id_yields_none():
    row = _normalize_squad_row(_sample_player(position_id=999), "Brazil")
    # Unknown position_id → position field is None (we don't invent a label).
    assert row["position"] is None


def test_normalize_skips_when_player_id_missing():
    item = _sample_player()
    item["player_id"] = None
    item["player"]["id"] = None
    assert _normalize_squad_row(item, "Brazil") is None


def test_normalize_skips_when_name_missing():
    item = _sample_player()
    item["player"]["display_name"] = None
    item["player"]["name"] = None
    item["player"]["common_name"] = None
    assert _normalize_squad_row(item, "Brazil") is None


def test_normalize_falls_back_to_common_name():
    item = _sample_player()
    item["player"]["display_name"] = None
    item["player"]["name"] = None
    item["player"]["common_name"] = "M. Corrêa"
    row = _normalize_squad_row(item, "Brazil")
    assert row["player_name"] == "M. Corrêa"


# ── Upsert ───────────────────────────────────────────────────────────────────

@pytest.fixture
def in_memory_db():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    _ensure_table(conn)
    yield conn
    conn.close()


def test_upsert_inserts_full_squad(in_memory_db):
    conn = in_memory_db
    squad = [
        _sample_player(player_id=1, position_id=24),  # GK
        _sample_player(player_id=2, position_id=25),  # Def
        _sample_player(player_id=3, position_id=26),  # Mid
        _sample_player(player_id=4, position_id=27),  # Att
    ]
    n = upsert_squad(conn, "Brazil", squad)
    assert n == 4
    rows = conn.execute(
        "SELECT api_player_id, team_name, position FROM wc_players ORDER BY api_player_id"
    ).fetchall()
    assert len(rows) == 4
    assert [r["position"] for r in rows] == ["Goalkeeper", "Defender", "Midfielder", "Attacker"]


def test_upsert_idempotent_on_second_pass(in_memory_db):
    """Re-running the same sync must NOT create duplicate rows."""
    conn = in_memory_db
    squad = [_sample_player(player_id=1)]
    upsert_squad(conn, "Brazil", squad)
    upsert_squad(conn, "Brazil", squad)
    n = conn.execute("SELECT COUNT(*) FROM wc_players").fetchone()[0]
    assert n == 1


def test_upsert_refreshes_team_when_player_changes_squad(in_memory_db):
    """If a player moves teams mid-cycle, the row updates to the new team."""
    conn = in_memory_db
    sq1 = [_sample_player(player_id=1)]
    upsert_squad(conn, "Brazil", sq1)
    upsert_squad(conn, "Portugal", sq1)
    row = conn.execute("SELECT team_name FROM wc_players WHERE api_player_id=1").fetchone()
    assert row["team_name"] == "Portugal"


def test_upsert_skips_unnormalizable_rows(in_memory_db):
    conn = in_memory_db
    squad = [
        _sample_player(player_id=1),
        {"player_id": None, "player": {}},   # invalid, should be skipped
        _sample_player(player_id=2),
    ]
    n = upsert_squad(conn, "Brazil", squad)
    assert n == 2
    rows = conn.execute("SELECT api_player_id FROM wc_players ORDER BY api_player_id").fetchall()
    assert [r["api_player_id"] for r in rows] == [1, 2]
