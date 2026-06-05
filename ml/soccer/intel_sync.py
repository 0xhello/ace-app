#!/usr/bin/env python3
"""intel_sync.py — soccer fixture intelligence mapping/sync service.

Service layer for targeted WC/board game → Sportmonks fixture intelligence.
Next.js ops routes should parse requests and delegate here; provider mapping,
DB snapshots, and fixture sync logic live in this module.
"""
from __future__ import annotations

import json
import sqlite3
from typing import Any, Dict, Iterable, List, Optional

from ml.world_cup.signal_logger import DB_PATH
from ml.soccer.live_state import (
    init_db,
    fixture_mappings,
    find_sportmonks_fixture_for_game,
    upsert_fixture_mapping,
    sync_sportmonks_fixture,
)
from ml.soccer.sportmonks_fixture import get_cached_bundle_by_teams

CREDITS_NOTE = "status-only uses local cache; map/sync may call Sportmonks"


def public_mapping(m: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not m:
        return None
    return {
        "id": m.get("id"),
        "game_id": m.get("game_id"),
        "sport_key": m.get("sport_key"),
        "provider": m.get("provider"),
        "provider_fixture_id": str(m.get("provider_fixture_id")) if m.get("provider_fixture_id") is not None else None,
        "home_team": m.get("home_team"),
        "away_team": m.get("away_team"),
        "commence_time": m.get("commence_time"),
        "confidence": m.get("confidence"),
        "detected_at": m.get("detected_at"),
        "updated_at": m.get("updated_at"),
    }


def bundle_summary(game: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    bundle = get_cached_bundle_by_teams(
        game.get("home_team") or "",
        game.get("away_team") or "",
        commence_time_iso=game.get("commence_time"),
        window_hours=72,
    ) or get_cached_bundle_by_teams(
        game.get("away_team") or "",
        game.get("home_team") or "",
        commence_time_iso=game.get("commence_time"),
        window_hours=72,
    )
    if not bundle:
        return None
    return {
        "fixture_id": str(bundle.get("fixture_id")),
        "league_name": bundle.get("league_name"),
        "starting_at": bundle.get("starting_at"),
        "home_team_name": bundle.get("home_team_name"),
        "away_team_name": bundle.get("away_team_name"),
        "lineups": len(bundle.get("lineups") or []),
        "predictions": len(bundle.get("predictions") or {}),
        "events": len(bundle.get("events") or []),
        "fetched_at": bundle.get("fetched_at"),
        "settled_at": bundle.get("settled_at"),
    }


def fixture_snapshot(conn: sqlite3.Connection, game_id: str, *, include_unavailable: bool = False) -> Optional[Dict[str, Any]]:
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
    out: Dict[str, Any] = {
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
    }
    if include_unavailable:
        out["unavailable"] = unavailable_players(conn, game_id)
    return out


def unavailable_players(conn: sqlite3.Connection, game_id: str, limit: int = 12) -> List[Dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT player_name, team, unavailable_reason
          FROM soccer_player_feature_snapshot
         WHERE game_id = ?
           AND provider = 'sportmonks'
           AND (availability = 'out' OR lineup_status = 'out')
         ORDER BY team, player_name
         LIMIT ?
        """,
        (game_id, limit),
    ).fetchall()
    return [
        {"playerName": r["player_name"], "teamName": r["team"], "reason": r["unavailable_reason"]}
        for r in rows
    ]


def mapping_by_game_id() -> Dict[str, Dict[str, Any]]:
    return {m.get("game_id"): public_mapping(m) for m in fixture_mappings(provider="sportmonks")}


def map_game_if_needed(game: Dict[str, Any], existing_mapping: Optional[Dict[str, Any]]) -> tuple[Optional[Dict[str, Any]], bool, Optional[str]]:
    if existing_mapping:
        return existing_mapping, False, None
    match = find_sportmonks_fixture_for_game(game)
    if not match:
        return None, False, "no Sportmonks fixture match found"
    upsert_fixture_mapping(
        {
            "game_id": game["id"],
            "sport_key": game.get("sport"),
            "provider": "sportmonks",
            "provider_fixture_id": str(match["id"]),
            "home_team": game.get("home_team"),
            "away_team": game.get("away_team"),
            "commence_time": game.get("commence_time"),
            "confidence": "auto_team_time",
            "raw_json": match,
        }
    )
    return {
        "game_id": game.get("id"),
        "sport_key": game.get("sport"),
        "provider": "sportmonks",
        "provider_fixture_id": str(match["id"]),
        "confidence": "auto_team_time",
        "home_team": game.get("home_team"),
        "away_team": game.get("away_team"),
        "commence_time": game.get("commence_time"),
    }, True, None


def sync_game_intel(game: Dict[str, Any], *, game_source: str = "unknown", map: bool = False, sync: bool = False) -> Dict[str, Any]:
    init_db()
    out: Dict[str, Any] = {
        "ok": True,
        "game_id": game.get("id"),
        "sport": game.get("sport"),
        "home_team": game.get("home_team"),
        "away_team": game.get("away_team"),
        "mode": {"map": map, "sync": sync},
        "game_source": game_source,
        "mapping": None,
        "mapped_now": False,
        "sync_result": None,
        "bundle": None,
        "feature_snapshot": None,
        "credits_note": CREDITS_NOTE,
    }

    maps = mapping_by_game_id()
    out["mapping"] = maps.get(game.get("id"))

    if map and not out["mapping"]:
        mapping, mapped_now, error = map_game_if_needed(game, out["mapping"])
        out["mapping"] = mapping
        out["mapped_now"] = mapped_now
        if error:
            out["mapping_error"] = error

    fixture_id = (out.get("mapping") or {}).get("provider_fixture_id")
    if sync and fixture_id:
        out["sync_result"] = sync_sportmonks_fixture(game["id"], fixture_id)
    elif sync and not fixture_id:
        out["sync_error"] = "no fixture mapping; call with map=true first"

    out["bundle"] = bundle_summary(game)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        out["feature_snapshot"] = fixture_snapshot(conn, game.get("id"), include_unavailable=False)
        unavailable = unavailable_players(conn, game.get("id"))
        if unavailable:
            out["unavailable"] = unavailable
    finally:
        conn.close()
    return out


def sync_board_intel(games: Iterable[Dict[str, Any]], *, map: bool = False, sync: bool = False) -> Dict[str, Any]:
    init_db()
    game_list = list(games)
    out: Dict[str, Any] = {
        "ok": True,
        "mode": {"map": map, "sync": sync},
        "checked": len(game_list),
        "mapped_now": 0,
        "synced": 0,
        "games": [],
        "errors": [],
    }
    maps = mapping_by_game_id()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        for game in game_list:
            item: Dict[str, Any] = {
                "game_id": game.get("id"),
                "sport": game.get("sport"),
                "home_team": game.get("home_team"),
                "away_team": game.get("away_team"),
                "commence_time": game.get("commence_time"),
                "mapping": maps.get(game.get("id")),
                "feature_snapshot": fixture_snapshot(conn, game.get("id"), include_unavailable=False),
                "mapped_now": False,
                "synced": False,
            }
            try:
                if map and not item["mapping"]:
                    mapping, mapped_now, error = map_game_if_needed(game, item["mapping"])
                    item["mapping"] = mapping
                    item["mapped_now"] = mapped_now
                    out["mapped_now"] += 1 if mapped_now else 0
                    if error:
                        item["mapping_error"] = "no match" if error.startswith("no Sportmonks") else error
                fixture_id = (item.get("mapping") or {}).get("provider_fixture_id")
                if sync and fixture_id:
                    item["sync_result"] = sync_sportmonks_fixture(game["id"], fixture_id)
                    item["synced"] = bool(item["sync_result"].get("ok"))
                    item["feature_snapshot"] = fixture_snapshot(conn, game.get("id"), include_unavailable=False)
                    out["synced"] += 1 if item["synced"] else 0
                elif sync and not fixture_id:
                    item["sync_error"] = "no mapping"
            except Exception as exc:  # noqa: BLE001
                item["error"] = str(exc)[:240]
                out["errors"].append({"game_id": game.get("id"), "error": item["error"]})
            out["games"].append(item)
    finally:
        conn.close()
    return out


if __name__ == "__main__":
    import argparse
    import sys

    parser = argparse.ArgumentParser(description="Soccer fixture intelligence mapping/sync service")
    sub = parser.add_subparsers(dest="cmd", required=True)
    game_cmd = sub.add_parser("game")
    game_cmd.add_argument("--game-json", required=True)
    game_cmd.add_argument("--game-source", default="cli")
    game_cmd.add_argument("--map", action="store_true")
    game_cmd.add_argument("--sync", action="store_true")
    board_cmd = sub.add_parser("board")
    board_cmd.add_argument("--games-json", required=True)
    board_cmd.add_argument("--map", action="store_true")
    board_cmd.add_argument("--sync", action="store_true")
    args = parser.parse_args()

    try:
        if args.cmd == "game":
            print(json.dumps(sync_game_intel(json.loads(args.game_json), game_source=args.game_source, map=args.map, sync=args.sync), ensure_ascii=False, default=str))
        elif args.cmd == "board":
            print(json.dumps(sync_board_intel(json.loads(args.games_json), map=args.map, sync=args.sync), ensure_ascii=False, default=str))
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(exc)[:400]}))
        sys.exit(1)
