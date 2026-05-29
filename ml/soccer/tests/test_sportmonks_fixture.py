"""Tests for ml/soccer/sportmonks_fixture.py (M38).

No live API calls — everything runs against the in-test SQLite DB and
hand-built fixture payloads. The live-fetch path is exercised separately
by the CLI / manual probe.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict

import pytest


# ---------- Helpers ----------------------------------------------------------

def _fake_bundle(**overrides: Any) -> Dict[str, Any]:
    """Build a Sportmonks-shaped fixture payload mirroring what
    fetch_fixture_bundle() returns. Matches the live UCL-final probe."""
    base = {
        "id": 19683241,
        "league_id": 2,
        "starting_at": "2026-05-30 16:00:00",
        "name": "Paris Saint Germain vs Arsenal",
        "participants": [
            {"id": 591, "name": "Paris Saint Germain",
             "meta": {"location": "home"}},
            {"id": 19,  "name": "Arsenal",
             "meta": {"location": "away"}},
        ],
        "lineups": [
            # PSG starters — 4 of them, one forward, one midfielder, two
            # defenders. Enough to test starter detection + side filtering.
            {"player_id": 100, "player_name": "Gonçalo Ramos",
             "team_id": 591, "position_id": 27, "type_id": 11,
             "jersey_number": 9, "formation_field": "4:2",
             "player": {"display_name": "Gonçalo Ramos"}},
            {"player_id": 101, "player_name": "Vitinha",
             "team_id": 591, "position_id": 26, "type_id": 11,
             "jersey_number": 17, "formation_field": "3:2",
             "player": {"display_name": "Vitinha"}},
            {"player_id": 102, "player_name": "Marquinhos",
             "team_id": 591, "position_id": 25, "type_id": 11,
             "jersey_number": 5, "formation_field": "2:2",
             "player": {"display_name": "Marquinhos"}},
            # A bench rider so we can test the non-starter path.
            {"player_id": 103, "player_name": "Lucas Beraldo",
             "team_id": 591, "position_id": 25, "type_id": 12,
             "jersey_number": 4, "formation_field": None,
             "player": {"display_name": "Lucas Beraldo"}},
            # Arsenal starter — for side-filter test
            {"player_id": 200, "player_name": "Bukayo Saka",
             "team_id": 19, "position_id": 27, "type_id": 11,
             "jersey_number": 7, "formation_field": "4:3",
             "player": {"display_name": "Bukayo Saka"}},
        ],
        "predictions": [
            {"type": {"name": "Fulltime Result Probability"},
             "predictions": {"home": 34.95, "away": 41.5, "draw": 23.5}},
            {"type": {"name": "Over/Under 2.5 Probability"},
             "predictions": {"yes": 65.37, "no": 34.63}},
            {"type": {"name": "Both Teams To Score Probability"},
             "predictions": {"yes": 65.89, "no": 34.11}},
        ],
        "xgfixture": [],  # pre-match — empty
    }
    base.update(overrides)
    return base


# ---------- Schema + normalization ------------------------------------------

def test_init_table_idempotent(tmp_path: Path) -> None:
    """init_table is the first call on every operation — must be safely
    callable multiple times on the same DB."""
    from ml.soccer.sportmonks_fixture import init_table
    db = tmp_path / "smfx.db"
    init_table(db); init_table(db); init_table(db)
    # If it didn't raise, we're good. Also confirm the table exists.
    import sqlite3
    with sqlite3.connect(str(db)) as conn:
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name='soccer_sportmonks_fixture_cache'"
        ).fetchall()
    assert len(rows) == 1


def test_cache_fixture_bundle_roundtrip(tmp_path: Path) -> None:
    """Persist a fake bundle, read it back via the by-id accessor, confirm
    every column hydrates correctly."""
    from ml.soccer.sportmonks_fixture import (
        cache_fixture_bundle, get_cached_bundle_by_fixture_id,
    )
    db = tmp_path / "smfx.db"
    bundle = _fake_bundle()
    summary = cache_fixture_bundle(19683241, path=db, bundle=bundle)
    assert summary["fixture_id"] == 19683241
    assert summary["lineups"] == 5
    assert summary["predictions"] == 3
    assert summary["xg_metrics"] == 0
    assert summary["settled"] is False

    cached = get_cached_bundle_by_fixture_id(19683241, path=db)
    assert cached is not None
    assert cached["home_team_id"] == 591
    assert cached["away_team_id"] == 19
    assert cached["home_team_name"] == "Paris Saint Germain"
    assert cached["away_team_name"] == "Arsenal"
    assert len(cached["lineups"]) == 5
    assert cached["predictions"]["Fulltime Result Probability"]["home"] == 34.95
    assert cached["xgfixture"] == {}
    assert cached["settled_at"] is None


def test_team_name_fuzzy_match(tmp_path: Path) -> None:
    """Odds API spells team names differently (PSG with hyphen, 'Paris SG',
    etc.). Lookup must be tolerant or every prop card silently misses."""
    from ml.soccer.sportmonks_fixture import (
        cache_fixture_bundle, get_cached_bundle_by_teams,
    )
    db = tmp_path / "smfx.db"
    cache_fixture_bundle(19683241, path=db, bundle=_fake_bundle())
    for home_query, away_query in [
        ("Paris Saint-Germain", "Arsenal"),  # hyphenated
        ("PARIS SAINT GERMAIN", "arsenal"),  # case
        ("Paris Saint Germain", "Arsenal"),  # exact
    ]:
        hit = get_cached_bundle_by_teams(home_query, away_query, path=db)
        assert hit is not None, f"missed: {home_query} vs {away_query}"
        assert hit["fixture_id"] == 19683241


def test_lookup_player_in_lineup_starter_vs_bench(tmp_path: Path) -> None:
    """A starter (type_id=11) must come back with is_starter=True; a bench
    entry (type_id=12) with is_starter=False."""
    from ml.soccer.sportmonks_fixture import (
        cache_fixture_bundle, get_cached_bundle_by_fixture_id,
        lookup_player_in_lineup,
    )
    db = tmp_path / "smfx.db"
    cache_fixture_bundle(19683241, path=db, bundle=_fake_bundle())
    b = get_cached_bundle_by_fixture_id(19683241, path=db)

    ramos = lookup_player_in_lineup(b, "Goncalo Ramos", team_side="home")
    assert ramos is not None
    assert ramos["is_starter"] is True
    assert ramos["jersey_number"] == 9

    beraldo = lookup_player_in_lineup(b, "Beraldo", team_side="home")
    assert beraldo is not None
    assert beraldo["is_starter"] is False

    # Side filter — Saka is Arsenal; querying with team_side='home' must miss
    assert lookup_player_in_lineup(b, "Saka", team_side="home") is None
    assert lookup_player_in_lineup(b, "Saka", team_side="away") is not None


# ---------- Wire-in: player_props integration -------------------------------

def test_minutes_from_lineup_starter_path(tmp_path: Path) -> None:
    """With a bundle present and a starter match: minutes envelope from
    the starter table, lineup_status='projected_starting',
    source='sportmonks'."""
    from ml.soccer.sportmonks_fixture import (
        cache_fixture_bundle, get_cached_bundle_by_fixture_id,
    )
    from ml.soccer.player_props import _minutes_from_lineup
    db = tmp_path / "smfx.db"
    cache_fixture_bundle(19683241, path=db, bundle=_fake_bundle())
    b = get_cached_bundle_by_fixture_id(19683241, path=db)

    out = _minutes_from_lineup(
        bundle=b, team_name="Paris Saint Germain",
        player_name="Goncalo Ramos",
        position_bucket="forward", sample_confidence="high",
    )
    assert out["source"] == "sportmonks"
    assert out["lineup_status"] == "projected_starting"
    assert out["minutes"] == 78
    assert out["in_lineup"] is True


def test_minutes_from_lineup_bench_path(tmp_path: Path) -> None:
    """Bench player gets short envelope but still surfaces (in_lineup=True)."""
    from ml.soccer.sportmonks_fixture import (
        cache_fixture_bundle, get_cached_bundle_by_fixture_id,
    )
    from ml.soccer.player_props import _minutes_from_lineup
    db = tmp_path / "smfx.db"
    cache_fixture_bundle(19683241, path=db, bundle=_fake_bundle())
    b = get_cached_bundle_by_fixture_id(19683241, path=db)
    out = _minutes_from_lineup(
        bundle=b, team_name="Paris Saint Germain",
        player_name="Beraldo",
        position_bucket="defender", sample_confidence="medium",
    )
    assert out["lineup_status"] == "projected_bench"
    assert out["minutes"] == 20
    assert out["in_lineup"] is True


def test_minutes_from_lineup_not_in_xi_signals_skip(tmp_path: Path) -> None:
    """Player not in the projected XI must return in_lineup=False so the
    caller drops the card. This is the M37 false-positive killer."""
    from ml.soccer.sportmonks_fixture import (
        cache_fixture_bundle, get_cached_bundle_by_fixture_id,
    )
    from ml.soccer.player_props import _minutes_from_lineup
    db = tmp_path / "smfx.db"
    cache_fixture_bundle(19683241, path=db, bundle=_fake_bundle())
    b = get_cached_bundle_by_fixture_id(19683241, path=db)
    out = _minutes_from_lineup(
        bundle=b, team_name="Paris Saint Germain",
        player_name="Kylian Mbappe",  # not in our fake XI
        position_bucket="forward", sample_confidence="high",
    )
    assert out["in_lineup"] is False
    assert out["minutes"] is None
    assert out["lineup_status"] == "not_in_xi"


def test_minutes_from_lineup_no_bundle_falls_back_to_heuristic() -> None:
    """When no bundle is provided (Sportmonks down, cache miss), the
    legacy _assumed_minutes heuristic is the source. Zero regression."""
    from ml.soccer.player_props import _minutes_from_lineup, _assumed_minutes
    out = _minutes_from_lineup(
        bundle=None, team_name="Paris Saint Germain",
        player_name="anyone",
        position_bucket="forward", sample_confidence="high",
    )
    assert out["source"] == "heuristic"
    assert out["lineup_status"] == "projected_unknown"
    assert out["minutes"] == _assumed_minutes("forward", "high")


def test_refresh_policy_skips_settled(tmp_path: Path) -> None:
    """Once xGFixture is populated (post-match), don't re-fetch — the
    realized stats are stable. _needs_refresh must return False."""
    from ml.soccer.sportmonks_fixture import _needs_refresh
    import sqlite3
    class _R(dict):
        def __getitem__(self, k): return super().get(k)
    row = _R(
        fetched_at="2026-05-30T10:00:00+00:00",
        settled_at="2026-05-30T19:00:00+00:00",
        starting_at="2026-05-30 16:00:00",
    )
    assert _needs_refresh(row) is False
