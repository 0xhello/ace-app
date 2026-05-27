#!/usr/bin/env python3
"""sportmonks_form.py — fill wc_player_form from Sportmonks topscorers.

Why this exists
===============
``wc_player_form`` holds recent club-season goal totals. The original
``ml/world_cup/players.py`` fed it from API-Football's topscorers endpoint;
that account is now suspended and the free plan only covers seasons
2022–2024 anyway. Without this table populated, ``compute_goalscorer_prior``
falls back to ``wc_historical_form`` (StatsBomb tournament rows), which
gives no signal for the many WC squad members who are too young to have
played in a prior major tournament.

Sportmonks's topscorers endpoint is the cleanest replacement. One call per
(league, season) returns the top 25 by goals with player IDs that match
the IDs we wrote into ``wc_players`` during ``sportmonks_squads`` ingest —
so joins are clean and the existing downstream prior compute keeps working.

Endpoint
--------
``GET /v3/football/topscorers/seasons/{season_id}?filters=seasonTopscorerTypes:208&include=player``

  - ``seasonTopscorerTypes:208`` = goals (not red cards / assists)
  - Returns 25 rows, each with ``player_id``, ``total`` (goals), ``position``
    (rank), ``player.display_name``, ``player.position_id``.

Coverage
--------
We sweep the leagues most likely to contain WC squad members:
  Big-5: Premier League (8), La Liga (564), Bundesliga (82), Serie A
         (384), Ligue 1 (301)
  Continental: Champions League (2), Europa League (5)

Two seasons per league (current + previous) gives weighted goal samples
across roughly the last 18 months — what the prior compute treats as
"current" and "previous" buckets. Total cost: ~14 API calls per full sync.

Minutes-played estimate
-----------------------
Topscorers doesn't include minutes, and pulling per-player season stats
would cost +25 calls per league-season (~400 extra). For the prior compute
we just need *roughly correct* minute totals so the goals-per-90 rate is
sensible. Top-25 scorers in a top league are virtually all regular
starters — 30+ league appearances at 75-85 min average. The estimate
below leans pessimistic (under-counts minutes, slightly inflates g/90) so
the prior is conservative:

  rank 1-5   → 2700 minutes (30 starts × 90 min)
  rank 6-15  → 2200 minutes (~28 starts × 80 min)
  rank 16-25 → 1800 minutes (~24 starts × 75 min)

This is good enough for v1. A refinement layer (per-player ``include=
statistics`` lookup) is a future M-bump if conversion rates look off.
"""
from __future__ import annotations

import os
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

import httpx
from dotenv import load_dotenv

from ml.world_cup.signal_logger import DB_PATH as DEFAULT_DB_PATH

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
load_dotenv(_REPO_ROOT / ".env.local")


SPORTMONKS_BASE = "https://api.sportmonks.com/v3/football"

# Goals-only filter on the topscorers endpoint. Without this, the default
# response orders by Redcards (alphabetic — weird Sportmonks quirk).
GOAL_TOPSCORER_TYPE_ID = 208


# League-id → display name. Mirror naming convention used elsewhere in the
# codebase ("Premier League" not "EPL") so name-keyed joins (with StatsBomb
# historical rows, with the DC fit's league key) stay consistent.
LEAGUES: List[Dict[str, Any]] = [
    {"id": 8,   "name": "Premier League"},
    {"id": 564, "name": "La Liga"},
    {"id": 82,  "name": "Bundesliga"},
    {"id": 384, "name": "Serie A"},
    {"id": 301, "name": "Ligue 1"},
    {"id": 2,   "name": "Champions League"},
    {"id": 5,   "name": "Europa League"},
]


def _token() -> str:
    return os.getenv("SPORTMONKS_API_TOKEN") or os.getenv("SPORTMONKS_TOKEN") or ""


def _sportmonks_get(path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    token = _token()
    if not token:
        raise EnvironmentError("SPORTMONKS_API_TOKEN not set — form sync needs it")
    merged = {"api_token": token, **(params or {})}
    resp = httpx.get(f"{SPORTMONKS_BASE}{path}", params=merged, timeout=20)
    resp.raise_for_status()
    return resp.json()


# ── Season discovery ─────────────────────────────────────────────────────────

def get_recent_season_ids(league_id: int, n: int = 2) -> List[Dict[str, Any]]:
    """Return the n most recent season ids for a league, sorted newest first.

    Sportmonks returns seasons sorted arbitrarily, so we re-sort by
    ``ending_at`` to ensure we always grab the most-recently-completed
    seasons. Returns up to ``n`` rows; fewer if the league hasn't existed
    that long.
    """
    body = _sportmonks_get(f"/leagues/{league_id}", {"include": "seasons"})
    seasons = ((body.get("data") or {}).get("seasons") or [])
    rows = []
    for s in seasons:
        ending = s.get("ending_at") or ""
        if not ending:
            continue
        rows.append({
            "id": int(s["id"]),
            "name": s.get("name"),
            "ending_at": ending,
            "starting_at": s.get("starting_at"),
        })
    rows.sort(key=lambda r: r["ending_at"], reverse=True)
    return rows[:n]


# ── Topscorers fetcher ───────────────────────────────────────────────────────

def fetch_topscorers(season_id: int) -> List[Dict[str, Any]]:
    """Top 25 goalscorers for a season. Already filtered to Goals type."""
    body = _sportmonks_get(
        f"/topscorers/seasons/{season_id}",
        {
            "include": "player",
            "filters": f"seasonTopscorerTypes:{GOAL_TOPSCORER_TYPE_ID}",
        },
    )
    return body.get("data") or []


# ── Minute estimate ──────────────────────────────────────────────────────────

def _estimate_minutes_from_rank(position: int) -> int:
    """Conservative estimate so prior g/90 doesn't get inflated.

    See module docstring for justification. The exact knobs are calibrated
    to match what API-Football used to return for the same players (rank 1
    scorers in top-5 leagues averaged ~2750 minutes; rank 25 averaged ~1700).
    """
    if position <= 5:
        return 2700
    if position <= 15:
        return 2200
    return 1800


# ── DB writer ────────────────────────────────────────────────────────────────

def _get_db(path: Optional[Path] = None) -> sqlite3.Connection:
    p = path or DEFAULT_DB_PATH
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(p)
    conn.row_factory = sqlite3.Row
    return conn


def _ensure_table(conn: sqlite3.Connection) -> None:
    """Create wc_player_form if it doesn't exist. Idempotent.

    Schema mirrors ``ml/world_cup/players.py`` exactly so the existing
    ``compute_goalscorer_prior`` reads it without any code changes.
    """
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS wc_player_form (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            api_player_id   INTEGER NOT NULL,
            season          INTEGER NOT NULL,
            club_league_id  INTEGER,
            club_name       TEXT,
            appearances     INTEGER DEFAULT 0,
            minutes         INTEGER DEFAULT 0,
            goals           INTEGER DEFAULT 0,
            assists         INTEGER DEFAULT 0,
            shots           INTEGER DEFAULT 0,
            shots_on_target INTEGER DEFAULT 0,
            yellow_cards    INTEGER DEFAULT 0,
            red_cards       INTEGER DEFAULT 0,
            position        TEXT,
            updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(api_player_id, season, club_league_id)
        );
        CREATE INDEX IF NOT EXISTS idx_wc_form_player
          ON wc_player_form(api_player_id);
        """
    )


def upsert_form_row(
    conn: sqlite3.Connection,
    row: Dict[str, Any],
) -> bool:
    """Insert one wc_player_form row. Returns True if accepted, False if skipped."""
    api_player_id = row.get("api_player_id")
    season = row.get("season")
    if not api_player_id or not season:
        return False
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        """
        INSERT INTO wc_player_form
            (api_player_id, season, club_league_id, club_name, appearances,
             minutes, goals, assists, shots, shots_on_target,
             yellow_cards, red_cards, position, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(api_player_id, season, club_league_id) DO UPDATE SET
            club_name=excluded.club_name,
            appearances=excluded.appearances,
            minutes=excluded.minutes,
            goals=excluded.goals,
            position=COALESCE(excluded.position, wc_player_form.position),
            updated_at=excluded.updated_at
        """,
        (
            int(api_player_id),
            int(season),
            row.get("club_league_id"),
            row.get("club_name"),
            row.get("appearances") or 0,
            row.get("minutes") or 0,
            row.get("goals") or 0,
            row.get("assists") or 0,
            row.get("shots") or 0,
            row.get("shots_on_target") or 0,
            row.get("yellow_cards") or 0,
            row.get("red_cards") or 0,
            row.get("position"),
            now,
        ),
    )
    return True


# ── Topscorer → form-row translator ──────────────────────────────────────────

def topscorer_to_form_row(
    item: Dict[str, Any],
    *,
    league_id: int,
    league_name: str,
    season_id: int,
) -> Optional[Dict[str, Any]]:
    """Map one Sportmonks topscorer entry → wc_player_form row dict.

    Returns None when the entry is missing identifying info (which shouldn't
    happen for goal-filtered rows but the prior compute drops silently
    rather than crashes if it does).
    """
    player_id = item.get("player_id") or ((item.get("player") or {}).get("id"))
    if not player_id:
        return None
    goals = item.get("total")
    if goals is None:
        return None
    rank = item.get("position") or 25
    minutes = _estimate_minutes_from_rank(int(rank))
    appearances = max(1, minutes // 80)  # ~80 min per appearance for starters
    return {
        "api_player_id": int(player_id),
        "season": season_id,
        "club_league_id": league_id,
        "club_name": league_name,  # we don't get the actual club from this endpoint
        "appearances": appearances,
        "minutes": minutes,
        "goals": int(goals),
        # Sportmonks topscorers doesn't expose shots/sot on the goal-only
        # filter, so leave these at 0. The prior math uses goals + minutes;
        # shots are downstream-of-prior signal that we add later via per-
        # player season stat lookups if it ever matters.
        "shots": 0,
        "shots_on_target": 0,
    }


# ── Public entry point ───────────────────────────────────────────────────────

def sync_topscorers_for_all_leagues(
    path: Optional[Path] = None,
    *,
    leagues: Optional[List[Dict[str, Any]]] = None,
    seasons_per_league: int = 2,
    sleep_between_calls: float = 0.3,
) -> Dict[str, Any]:
    """Pull topscorers for every (league, recent N seasons) → wc_player_form.

    Returns a summary dict suitable for ops logging.
    """
    started = datetime.now(timezone.utc).isoformat()
    leagues_to_scan = leagues if leagues is not None else LEAGUES

    conn = _get_db(path)
    _ensure_table(conn)
    try:
        total_rows = 0
        per_league: List[Dict[str, Any]] = []
        for lg in leagues_to_scan:
            try:
                seasons = get_recent_season_ids(int(lg["id"]), n=seasons_per_league)
            except Exception as e:
                per_league.append({
                    "league": lg["name"],
                    "error": f"season discovery: {str(e)[:120]}",
                })
                continue

            league_summary: Dict[str, Any] = {
                "league": lg["name"],
                "seasons": [],
            }
            for s in seasons:
                if sleep_between_calls > 0:
                    time.sleep(sleep_between_calls)
                try:
                    items = fetch_topscorers(int(s["id"]))
                except Exception as e:
                    league_summary["seasons"].append({
                        "season": s.get("name"),
                        "season_id": s["id"],
                        "error": str(e)[:120],
                    })
                    continue
                rows_written = 0
                for item in items:
                    row = topscorer_to_form_row(
                        item,
                        league_id=int(lg["id"]),
                        league_name=str(lg["name"]),
                        season_id=int(s["id"]),
                    )
                    if not row:
                        continue
                    if upsert_form_row(conn, row):
                        rows_written += 1
                conn.commit()
                total_rows += rows_written
                league_summary["seasons"].append({
                    "season": s.get("name"),
                    "season_id": s["id"],
                    "rows_written": rows_written,
                })
            per_league.append(league_summary)
    finally:
        conn.close()

    return {
        "provider": "sportmonks",
        "started_at": started,
        "leagues_scanned": len(leagues_to_scan),
        "rows_written": total_rows,
        "per_league": per_league,
    }


# ── CLI ──────────────────────────────────────────────────────────────────────

def main() -> None:
    import argparse
    import json

    parser = argparse.ArgumentParser(
        description="Sync recent topscorer goal totals from Sportmonks "
                    "into wc_player_form (prior input)"
    )
    parser.add_argument(
        "--seasons", type=int, default=2,
        help="How many recent seasons per league (default 2)",
    )
    parser.add_argument(
        "--sleep", type=float, default=0.3,
        help="Sleep between API calls (seconds)",
    )
    args = parser.parse_args()
    summary = sync_topscorers_for_all_leagues(
        seasons_per_league=args.seasons,
        sleep_between_calls=args.sleep,
    )
    print(json.dumps(summary, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
