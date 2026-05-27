"""Tests for sportmonks_form helpers (no network).

Covers:
  - rank-based minute estimate (the conservative heuristic)
  - topscorer_to_form_row translation (player_id, season, goals, etc.)
  - upsert_form_row with idempotency + cross-league updates
"""
from __future__ import annotations

import sqlite3

import pytest

from unittest.mock import patch

from ml.world_cup.sportmonks_form import (
    GOAL_TOPSCORER_TYPE_ID,
    LEAGUES,
    STAT_TYPE_APPEARANCES,
    STAT_TYPE_ASSISTS,
    STAT_TYPE_GOALS,
    STAT_TYPE_MINUTES_PLAYED,
    STAT_TYPE_SHOTS_OFF_TARGET,
    STAT_TYPE_SHOTS_ON_TARGET,
    STAT_TYPE_SHOTS_TOTAL,
    _estimate_minutes_from_rank,
    _ensure_table,
    enrich_form_rows_with_real_stats,
    fetch_player_season_stats,
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


# ── Per-player season stats (M14 enrichment) ────────────────────────────────

def test_stat_type_ids_pinned():
    """Pin Sportmonks type_ids — if they rotate, downstream silently drops
    to 0 for every player. Lock with explicit values."""
    assert STAT_TYPE_GOALS == 52
    assert STAT_TYPE_ASSISTS == 79
    assert STAT_TYPE_SHOTS_TOTAL == 42
    assert STAT_TYPE_SHOTS_OFF_TARGET == 41
    assert STAT_TYPE_SHOTS_ON_TARGET == 86
    assert STAT_TYPE_MINUTES_PLAYED == 119
    assert STAT_TYPE_APPEARANCES == 321


def _fake_player_response(player_id=154421, seasons=None):
    """Mimic the live /players/{id}?include=statistics.details.type shape."""
    if seasons is None:
        seasons = [
            {
                "season_id": 25583,  # PL 25/26
                "details": [
                    {"type_id": 52,  "value": {"total": 27}},  # goals
                    {"type_id": 119, "value": {"total": 2750}},  # minutes
                    {"type_id": 321, "value": {"total": 34}},  # appearances
                    {"type_id": 42,  "value": {"total": 126}},  # shots total
                    {"type_id": 86,  "value": {"total": 73}},   # shots on target
                    {"type_id": 41,  "value": {"total": 43}},   # shots off target
                ],
            },
            {
                "season_id": 23614,  # PL 24/25
                "details": [
                    {"type_id": 52,  "value": {"total": 24}},
                    {"type_id": 119, "value": {"total": 2680}},
                    {"type_id": 321, "value": {"total": 33}},
                ],
            },
        ]
    return {"data": {"id": player_id, "statistics": seasons}}


def test_fetch_player_season_stats_parses_real_shape():
    """End-to-end parse of a realistic Sportmonks response."""
    with patch(
        "ml.world_cup.sportmonks_form._sportmonks_get",
        return_value=_fake_player_response(),
    ):
        out = fetch_player_season_stats(154421)
    assert 25583 in out and 23614 in out
    cur = out[25583]
    assert cur["goals"] == 27
    assert cur["minutes"] == 2750
    assert cur["appearances"] == 34
    assert cur["shots_total"] == 126
    assert cur["shots_on_target"] == 73
    assert cur["shots_off_target"] == 43


def test_fetch_player_season_stats_handles_empty():
    """Player with no statistics rows yet → empty dict, no crash."""
    with patch(
        "ml.world_cup.sportmonks_form._sportmonks_get",
        return_value={"data": {"id": 1, "statistics": []}},
    ):
        assert fetch_player_season_stats(1) == {}


def test_fetch_player_season_stats_handles_missing_total():
    """Detail rows without a 'total' field (e.g. card stats with breakdowns)
    must not crash — they're just skipped."""
    response = {
        "data": {
            "id": 1,
            "statistics": [{
                "season_id": 25583,
                "details": [
                    {"type_id": 52,  "value": {"total": 5}},
                    {"type_id": 47,  "value": {"won": 0, "scored": 3}},  # no total
                    {"type_id": 119, "value": {"total": 1800}},
                ],
            }],
        }
    }
    with patch(
        "ml.world_cup.sportmonks_form._sportmonks_get",
        return_value=response,
    ):
        out = fetch_player_season_stats(1)
    assert out[25583]["goals"] == 5
    assert out[25583]["minutes"] == 1800
    # Penalty row was skipped (no total key in its value dict)


def test_enrich_updates_minutes_to_real_value(in_memory_db):
    """Seed wc_player_form with estimated minutes, then enrich, and verify
    the real Sportmonks numbers overwrote them."""
    conn = in_memory_db
    # Seed: Haaland in PL 25/26 with rank-based 2700 estimate
    row = topscorer_to_form_row(
        _sample_topscorer(player_id=154421, total=27, position=1),
        league_id=8, league_name="Premier League", season_id=25583,
    )
    upsert_form_row(conn, row)
    assert conn.execute(
        "SELECT minutes FROM wc_player_form WHERE api_player_id=154421"
    ).fetchone()[0] == 2700

    with patch(
        "ml.world_cup.sportmonks_form._sportmonks_get",
        return_value=_fake_player_response(),
    ):
        summary = enrich_form_rows_with_real_stats(conn, sleep_between_calls=0)

    real_minutes = conn.execute(
        "SELECT minutes FROM wc_player_form WHERE api_player_id=154421 AND season=25583"
    ).fetchone()[0]
    assert real_minutes == 2750  # the API-reported value, not the estimate
    assert summary["players_checked"] == 1
    assert summary["rows_enriched"] == 1


def test_enrich_skips_seasons_without_stats(in_memory_db):
    """When the player stats response has no entry for the season_id our
    form row is keyed to, we leave the row alone instead of zeroing it."""
    conn = in_memory_db
    # Seed Haaland in a season the fake response doesn't cover (Bundesliga 22/23)
    row = topscorer_to_form_row(
        _sample_topscorer(player_id=154421, total=22, position=2),
        league_id=82, league_name="Bundesliga", season_id=99999,
    )
    upsert_form_row(conn, row)
    seeded_minutes = conn.execute(
        "SELECT minutes FROM wc_player_form WHERE season=99999"
    ).fetchone()[0]

    with patch(
        "ml.world_cup.sportmonks_form._sportmonks_get",
        return_value=_fake_player_response(),  # only has 25583, 23614
    ):
        summary = enrich_form_rows_with_real_stats(conn, sleep_between_calls=0)

    # Row is untouched
    after = conn.execute(
        "SELECT minutes FROM wc_player_form WHERE season=99999"
    ).fetchone()[0]
    assert after == seeded_minutes
    assert summary["rows_enriched"] == 0


def test_enrich_handles_api_error_gracefully(in_memory_db):
    """If the stats endpoint blows up for a player, we count it as an
    api_error and move on — the rest of the enrichment still runs."""
    conn = in_memory_db
    row = topscorer_to_form_row(
        _sample_topscorer(player_id=154421, total=27),
        league_id=8, league_name="Premier League", season_id=25583,
    )
    upsert_form_row(conn, row)

    def boom(*_args, **_kwargs):
        raise RuntimeError("simulated network failure")

    with patch("ml.world_cup.sportmonks_form._sportmonks_get", side_effect=boom):
        summary = enrich_form_rows_with_real_stats(conn, sleep_between_calls=0)

    assert summary["api_errors"] == 1
    # Rank-based estimate survives the failure
    assert conn.execute(
        "SELECT minutes FROM wc_player_form WHERE api_player_id=154421"
    ).fetchone()[0] == 2700
