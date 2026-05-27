#!/usr/bin/env python3
"""Cache Understat/soccerdata rows into ACE SQLite.

This is the "get it done today" version: pull the useful free/internal xG and
player shooting data from soccerdata's Understat adapter, persist it, and make
it available to the player-prop layer without depending on API-Football.

`soccerdata` is optional at import time. Install/provide it only for ingest:
    python3 -m pip install soccerdata
    python3 -m ml.soccer.understat_cache ingest --big-five
"""
from __future__ import annotations

import argparse
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DB_PATH = _REPO_ROOT / "ml" / "nba_spread" / "data" / "wc_signal_log.db"

BIG_FIVE_UNDERSTAT: List[str] = [
    "ENG-Premier League",
    "ESP-La Liga",
    "GER-Bundesliga",
    "ITA-Serie A",
    "FRA-Ligue 1",
]
DEFAULT_SEASON = "2024/2025"
PROVIDER = "soccerdata:understat"


def get_db(path: Optional[Path] = None) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path or DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def init_tables(path: Optional[Path] = None) -> None:
    conn = get_db(path)
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS soccer_source_player_stats (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            provider        TEXT NOT NULL,
            league          TEXT NOT NULL,
            season          TEXT NOT NULL,
            player_name     TEXT NOT NULL,
            team            TEXT,
            position        TEXT,
            appearances     INTEGER,
            minutes         REAL,
            goals           REAL,
            assists         REAL,
            shots           REAL,
            shots_on_target REAL,
            xg              REAL,
            np_xg           REAL,
            xa              REAL,
            key_passes      REAL,
            yellow_cards    REAL,
            red_cards       REAL,
            raw_json        TEXT,
            updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(provider, league, season, player_name, team)
        );
        CREATE INDEX IF NOT EXISTS idx_source_player_team
            ON soccer_source_player_stats(provider, league, season, team);
        CREATE INDEX IF NOT EXISTS idx_source_player_name
            ON soccer_source_player_stats(player_name);

        CREATE TABLE IF NOT EXISTS soccer_source_team_match_stats (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            provider         TEXT NOT NULL,
            league           TEXT NOT NULL,
            season           TEXT NOT NULL,
            game_id          TEXT NOT NULL,
            match_date       TEXT,
            team             TEXT NOT NULL,
            opponent         TEXT,
            venue            TEXT,
            goals_for        REAL,
            goals_against    REAL,
            xg_for           REAL,
            xg_against       REAL,
            np_xg_for        REAL,
            ppda             REAL,
            deep_completions REAL,
            raw_json         TEXT,
            updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(provider, game_id, team)
        );
        CREATE INDEX IF NOT EXISTS idx_source_team_match_team
            ON soccer_source_team_match_stats(provider, league, season, team, match_date);
        """
    )
    conn.commit()
    conn.close()


def _json_safe(value: Any) -> Any:
    if value is None:
        return None
    # pandas/numpy scalars and timestamps usually expose item()/isoformat().
    try:
        if hasattr(value, "item"):
            return value.item()
    except Exception:
        pass
    try:
        if hasattr(value, "isoformat"):
            return value.isoformat()
    except Exception:
        pass
    if isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def _raw_json(raw: Dict[str, Any]) -> str:
    return json.dumps({k: _json_safe(v) for k, v in raw.items()}, ensure_ascii=False, sort_keys=True)


def _val(raw: Dict[str, Any], key: str) -> Any:
    v = raw.get(key)
    if v != v:  # NaN
        return None
    return _json_safe(v)


def _load_understat(league: str, season: str):
    try:
        import soccerdata as sd  # type: ignore
    except Exception as e:
        raise RuntimeError("soccerdata not installed. Install with: python3 -m pip install soccerdata") from e
    return sd.Understat(leagues=[league], seasons=[season])


def ingest_league(league: str, season: str = DEFAULT_SEASON, path: Optional[Path] = None) -> Dict[str, Any]:
    init_tables(path)
    reader = _load_understat(league, season)
    now = datetime.now(timezone.utc).isoformat()

    player_rows = 0
    team_match_rows = 0
    conn = get_db(path)
    try:
        player_df = reader.read_player_season_stats().reset_index()
        for raw in player_df.to_dict(orient="records"):
            conn.execute(
                """
                INSERT INTO soccer_source_player_stats
                    (provider, league, season, player_name, team, position, appearances,
                     minutes, goals, assists, shots, shots_on_target, xg, np_xg, xa,
                     key_passes, yellow_cards, red_cards, raw_json, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(provider, league, season, player_name, team) DO UPDATE SET
                    position=excluded.position,
                    appearances=excluded.appearances,
                    minutes=excluded.minutes,
                    goals=excluded.goals,
                    assists=excluded.assists,
                    shots=excluded.shots,
                    shots_on_target=excluded.shots_on_target,
                    xg=excluded.xg,
                    np_xg=excluded.np_xg,
                    xa=excluded.xa,
                    key_passes=excluded.key_passes,
                    yellow_cards=excluded.yellow_cards,
                    red_cards=excluded.red_cards,
                    raw_json=excluded.raw_json,
                    updated_at=excluded.updated_at
                """,
                (
                    PROVIDER,
                    str(_val(raw, "league") or league),
                    str(_val(raw, "season") or season),
                    str(_val(raw, "player") or _val(raw, "player_name") or ""),
                    _val(raw, "team"),
                    _val(raw, "position"),
                    _val(raw, "matches"),
                    _val(raw, "minutes"),
                    _val(raw, "goals"),
                    _val(raw, "assists"),
                    _val(raw, "shots"),
                    _val(raw, "shots_on_target"),
                    _val(raw, "xg"),
                    _val(raw, "np_xg"),
                    _val(raw, "xa"),
                    _val(raw, "key_passes"),
                    _val(raw, "yellow_cards"),
                    _val(raw, "red_cards"),
                    _raw_json(raw),
                    now,
                ),
            )
            player_rows += 1

        team_df = reader.read_team_match_stats().reset_index()
        for raw in team_df.to_dict(orient="records"):
            game_id = str(_val(raw, "game_id") or _val(raw, "game") or "")
            common = {
                "league": str(_val(raw, "league") or league),
                "season": str(_val(raw, "season") or season),
                "game_id": game_id,
                "date": _val(raw, "date"),
                "raw_json": _raw_json(raw),
            }
            sides = [
                ("home", _val(raw, "home_team"), _val(raw, "away_team"), "home"),
                ("away", _val(raw, "away_team"), _val(raw, "home_team"), "away"),
            ]
            for prefix, team, opponent, venue in sides:
                if not team:
                    continue
                opp_prefix = "away" if prefix == "home" else "home"
                conn.execute(
                    """
                    INSERT INTO soccer_source_team_match_stats
                        (provider, league, season, game_id, match_date, team, opponent, venue,
                         goals_for, goals_against, xg_for, xg_against, np_xg_for,
                         ppda, deep_completions, raw_json, updated_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(provider, game_id, team) DO UPDATE SET
                        match_date=excluded.match_date,
                        opponent=excluded.opponent,
                        venue=excluded.venue,
                        goals_for=excluded.goals_for,
                        goals_against=excluded.goals_against,
                        xg_for=excluded.xg_for,
                        xg_against=excluded.xg_against,
                        np_xg_for=excluded.np_xg_for,
                        ppda=excluded.ppda,
                        deep_completions=excluded.deep_completions,
                        raw_json=excluded.raw_json,
                        updated_at=excluded.updated_at
                    """,
                    (
                        PROVIDER,
                        common["league"],
                        common["season"],
                        common["game_id"],
                        common["date"],
                        team,
                        opponent,
                        venue,
                        _val(raw, f"{prefix}_goals"),
                        _val(raw, f"{opp_prefix}_goals"),
                        _val(raw, f"{prefix}_xg"),
                        _val(raw, f"{opp_prefix}_xg"),
                        _val(raw, f"{prefix}_np_xg"),
                        _val(raw, f"{prefix}_ppda"),
                        _val(raw, f"{prefix}_deep_completions"),
                        common["raw_json"],
                        now,
                    ),
                )
                team_match_rows += 1
        conn.commit()
    finally:
        conn.close()
    return {"league": league, "season": season, "player_rows": player_rows, "team_match_rows": team_match_rows}


def ingest(leagues: Iterable[str], season: str = DEFAULT_SEASON, path: Optional[Path] = None) -> Dict[str, Any]:
    results = []
    for league in leagues:
        results.append(ingest_league(league, season, path))
    return {"provider": PROVIDER, "season": season, "results": results, "stats": stats(path)}


def stats(path: Optional[Path] = None) -> Dict[str, Any]:
    init_tables(path)
    conn = get_db(path)
    try:
        def scalar(sql: str, params: Tuple[Any, ...] = ()) -> int:
            return int(conn.execute(sql, params).fetchone()[0])
        leagues = [dict(r) for r in conn.execute(
            """
            SELECT league, season, COUNT(*) AS players
            FROM soccer_source_player_stats
            WHERE provider = ?
            GROUP BY league, season
            ORDER BY league, season
            """,
            (PROVIDER,),
        ).fetchall()]
        return {
            "provider": PROVIDER,
            "player_rows": scalar("SELECT COUNT(*) FROM soccer_source_player_stats WHERE provider = ?", (PROVIDER,)),
            "team_match_rows": scalar("SELECT COUNT(*) FROM soccer_source_team_match_stats WHERE provider = ?", (PROVIDER,)),
            "leagues": leagues,
        }
    finally:
        conn.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Cache soccerdata/Understat rows into ACE SQLite")
    parser.add_argument("cmd", choices=["init", "ingest", "stats"])
    parser.add_argument("--league", action="append", help="Understat league, e.g. ENG-Premier League")
    parser.add_argument("--season", default=DEFAULT_SEASON)
    parser.add_argument("--big-five", action="store_true")
    args = parser.parse_args()

    if args.cmd == "init":
        init_tables()
        print(json.dumps(stats(), indent=2))
    elif args.cmd == "stats":
        print(json.dumps(stats(), indent=2))
    elif args.cmd == "ingest":
        leagues = BIG_FIVE_UNDERSTAT if args.big_five else (args.league or ["ENG-Premier League"])
        print(json.dumps(ingest(leagues, args.season), indent=2, default=str))


if __name__ == "__main__":
    main()
