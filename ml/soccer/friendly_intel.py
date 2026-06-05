#!/usr/bin/env python3
"""friendly_intel.py — data-only friendly fixture rehearsal sync.

This is the service layer behind /api/ops/soccer/sync-friendly-intel.
It deliberately does NOT generate picks. Friendlies are used as a live
World Cup rehearsal lane for fixture mapping, lineups, events, stats,
availability, and Match Read state changes.
"""
from __future__ import annotations

import json
import sqlite3
from typing import Any, Dict, List

from ml.world_cup.signal_logger import DB_PATH
from ml.soccer.friendlies import discover_friendlies
from ml.soccer.live_state import init_db, upsert_fixture_mapping, sync_sportmonks_fixture

SCOPE = "friendlies_rehearsal_data_only"
SPORT_KEY = "soccer_international_friendly"
SPORT_TITLE = "International Friendly"
NOTE = "Friendlies are live rehearsal fixtures only; no ACE-validated picks implied."


def friendly_game_id(fixture_id: Any) -> str:
    return f"friendly_{fixture_id}"


def fixture_snapshot(conn: sqlite3.Connection, game_id: str) -> Dict[str, Any] | None:
    row = conn.execute(
        "SELECT * FROM soccer_fixture_feature_snapshot WHERE game_id = ? AND provider = 'sportmonks'",
        (game_id,),
    ).fetchone()
    if not row:
        return None

    hist = conn.execute(
        """
        SELECT COUNT(*) AS c, MAX(created_at) AS latest_at
          FROM soccer_fixture_feature_history
         WHERE game_id = ? AND provider = 'sportmonks'
        """,
        (game_id,),
    ).fetchone()
    unavailable = conn.execute(
        """
        SELECT player_name, team, unavailable_reason
          FROM soccer_player_feature_snapshot
         WHERE game_id = ?
           AND provider = 'sportmonks'
           AND (availability = 'out' OR lineup_status = 'out')
         ORDER BY team, player_name
         LIMIT 12
        """,
        (game_id,),
    ).fetchall()

    return {
        "provider_fixture_id": row["provider_fixture_id"],
        "state_name": row["state_name"],
        "lineup_count": row["lineup_count"],
        "starters_count": row["starters_count"],
        "bench_count": row["bench_count"],
        "sidelined_count": row["sidelined_count"],
        "event_count": row["event_count"],
        "statistic_count": row["statistic_count"],
        "updated_at": row["updated_at"],
        "history_count": hist["c"] if hist else 0,
        "latest_history_at": hist["latest_at"] if hist else None,
        "unavailable": [
            {"playerName": r["player_name"], "teamName": r["team"], "reason": r["unavailable_reason"]}
            for r in unavailable
        ],
    }


def friendly_fixture_item(fx: Dict[str, Any], conn: sqlite3.Connection) -> Dict[str, Any]:
    fid = fx.get("fixture_id")
    gid = friendly_game_id(fid)
    return {
        "game_id": gid,
        "sport": SPORT_KEY,
        "sport_title": SPORT_TITLE,
        "provider_fixture_id": str(fid),
        "home_team": fx.get("home"),
        "away_team": fx.get("away"),
        "name": fx.get("name"),
        "commence_time": fx.get("starting_at"),
        "mapped": False,
        "synced": False,
        "feature_snapshot": fixture_snapshot(conn, gid),
    }


def upsert_friendly_mapping(fx: Dict[str, Any]) -> None:
    fid = fx.get("fixture_id")
    upsert_fixture_mapping(
        {
            "game_id": friendly_game_id(fid),
            "sport_key": SPORT_KEY,
            "provider": "sportmonks",
            "provider_fixture_id": str(fid),
            "home_team": fx.get("home"),
            "away_team": fx.get("away"),
            "commence_time": fx.get("starting_at"),
            "confidence": "sportmonks_friendly_fixture",
            "raw_json": fx,
        }
    )


def sync_friendly_intel(*, days: int = 7, limit: int = 8, sync: bool = False) -> Dict[str, Any]:
    """Discover/map optional friendly live-state data.

    Defaults to map/discover only. ``sync=True`` explicitly fetches fixture
    state for the limited discovered fixtures.
    """
    safe_days = max(1, min(21, int(days)))
    safe_limit = max(1, min(24, int(limit)))

    init_db()
    fixtures = discover_friendlies(days=safe_days)[:safe_limit]
    out: Dict[str, Any] = {
        "ok": True,
        "mode": {"sync": sync},
        "scope": SCOPE,
        "note": NOTE,
        "days": safe_days,
        "limit": safe_limit,
        "discovered": len(fixtures),
        "mapped": 0,
        "synced": 0,
        "fixtures": [],
        "errors": [],
    }

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        for fx in fixtures:
            fid = fx.get("fixture_id")
            item = friendly_fixture_item(fx, conn)
            try:
                upsert_friendly_mapping(fx)
                item["mapped"] = True
                out["mapped"] += 1
                if sync:
                    item["sync_result"] = sync_sportmonks_fixture(friendly_game_id(fid), str(fid))
                    item["synced"] = bool(item["sync_result"].get("ok"))
                    item["feature_snapshot"] = fixture_snapshot(conn, friendly_game_id(fid))
                    out["synced"] += 1 if item["synced"] else 0
            except Exception as exc:  # noqa: BLE001
                item["error"] = str(exc)[:240]
                out["errors"].append({"fixture_id": fid, "error": item["error"]})
            out["fixtures"].append(item)
    finally:
        conn.close()

    return out


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Data-only friendly fixture rehearsal sync")
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--limit", type=int, default=8)
    parser.add_argument("--sync", action="store_true")
    args = parser.parse_args()
    print(json.dumps(sync_friendly_intel(days=args.days, limit=args.limit, sync=args.sync), ensure_ascii=False, indent=2, default=str))
