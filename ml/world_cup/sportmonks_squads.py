#!/usr/bin/env python3
"""sportmonks_squads.py — fill wc_players from Sportmonks (WC 2026).

Why this module exists
======================
The original WC squad ingest in ``ml/world_cup/players.py`` hits API-Football.
On prod, our API-Football account is suspended ("Your account is suspended,
check on https://dashboard.api-football.com.") and the free plan only allows
seasons 2022–2024, so even unsuspended we couldn't read 2026 data.

Sportmonks is already paid and integrated for club football (lineups, prop
cards, live state). Their World Cup 2026 dataset is included: season_id 26618
under league_id 732 ("World Cup"). The same SPORTMONKS_API_TOKEN that powers
the club pipeline reads national-team squads.

Endpoints we use
----------------
``GET /v3/football/teams/seasons/26618``
    Returns ~112 entries — 48 actual national teams + ~64 placeholder bracket
    entries ("Winner Quarter-final 1", "1st Group L", etc.). We filter
    placeholders out by ``country_id`` (real countries get small IDs; placeholder
    entries get a synthetic country_id of 190324 or similar).

``GET /v3/football/squads/seasons/26618/teams/{team_id}?include=player;position``
    Returns 26 player rows per team with player metadata + position lookup.
    Sportmonks position IDs:
        24 = Goalkeeper
        25 = Defender
        26 = Midfielder
        27 = Attacker

Total API cost
--------------
1 call for the team list + 48 calls for squads = ~49 calls per full sync.
Sportmonks paid plan headroom is comfortably large; this is a one-time ingest
(refreshed weekly).

Writes to ``wc_players`` using the same schema that ``ml/world_cup/players.py``
defined. ``api_player_id`` carries the Sportmonks player_id (positive ints
in the 10^4–10^7 range — no collision with API-Football's IDs because that
provider is offline).
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
WC_2026_SEASON_ID = 26618
WC_LEAGUE_ID = 732

# Sportmonks position_id → wc_players.position string.
# (Mirrors what API-Football used to write so downstream code keeps working.)
POSITION_BY_ID: Dict[int, str] = {
    24: "Goalkeeper",
    25: "Defender",
    26: "Midfielder",
    27: "Attacker",
}

# country_id values for placeholder bracket entries (observed in API response).
# These are synthetic "country" rows Sportmonks creates so the bracket has
# something to anchor to before draws resolve. Real countries have country_ids
# in the few-thousand range (Brazil=5, England=462, etc.).
_PLACEHOLDER_COUNTRY_IDS = {190324, 99474}


# ── HTTP ─────────────────────────────────────────────────────────────────────

def _token() -> str:
    return os.getenv("SPORTMONKS_API_TOKEN") or os.getenv("SPORTMONKS_TOKEN") or ""


def _sportmonks_get(path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Thin GET helper. Raises on HTTP error; returns parsed JSON body."""
    token = _token()
    if not token:
        raise EnvironmentError("SPORTMONKS_API_TOKEN not set — squad sync needs it")
    merged = {"api_token": token, **(params or {})}
    resp = httpx.get(f"{SPORTMONKS_BASE}{path}", params=merged, timeout=20)
    resp.raise_for_status()
    return resp.json()


# ── Data fetchers ────────────────────────────────────────────────────────────

def fetch_wc_2026_teams() -> List[Dict[str, Any]]:
    """All teams attached to season 26618. Filters placeholder bracket entries.

    A "real" national team has a non-placeholder ``country_id`` AND a name that
    doesn't look like a bracket marker ("Winner Quarter-final 1", "1st Group L",
    "3rd-placed team Group X", etc.). Belt-and-braces because Sportmonks
    occasionally reuses placeholder IDs across seasons.
    """
    body = _sportmonks_get(f"/teams/seasons/{WC_2026_SEASON_ID}")
    rows = body.get("data") or []
    teams: List[Dict[str, Any]] = []
    for r in rows:
        name = str(r.get("name") or "").strip()
        country_id = r.get("country_id")
        if not name or not r.get("id"):
            continue
        if country_id in _PLACEHOLDER_COUNTRY_IDS:
            continue
        nl = name.lower()
        if any(tok in nl for tok in (
            "winner", "loser",
            "1st group", "2nd group", "3rd group",
            "3rd-placed", "best 3rd", "best-3rd",
            "round of", "quarter-final", "semi-final", "final ",
        )):
            continue
        teams.append({
            "id": int(r["id"]),
            "name": name,
            "country_id": country_id,
        })
    return teams


def fetch_team_squad(team_id: int) -> List[Dict[str, Any]]:
    """Player rows for a team's WC 2026 squad. ~26 entries per team."""
    body = _sportmonks_get(
        f"/squads/seasons/{WC_2026_SEASON_ID}/teams/{team_id}",
        {"include": "player;position"},
    )
    return body.get("data") or []


# ── DB writer ────────────────────────────────────────────────────────────────

def _get_db(path: Optional[Path] = None) -> sqlite3.Connection:
    p = path or DEFAULT_DB_PATH
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(p)
    conn.row_factory = sqlite3.Row
    return conn


def _ensure_table(conn: sqlite3.Connection) -> None:
    """Create wc_players if it doesn't exist. Idempotent.

    Schema mirrors the one in ml/world_cup/players.py so existing downstream
    code (priors compute, ops UI, etc.) keeps working.
    """
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS wc_players (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            api_player_id   INTEGER UNIQUE NOT NULL,
            player_name     TEXT NOT NULL,
            team_name       TEXT NOT NULL,
            position        TEXT,
            age             INTEGER,
            shirt_number    INTEGER,
            photo_url       TEXT,
            updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_wc_players_team ON wc_players(team_name);
        """
    )


def _age_from_dob(dob_str: Optional[str]) -> Optional[int]:
    if not dob_str:
        return None
    try:
        born = datetime.strptime(dob_str[:10], "%Y-%m-%d")
        now = datetime.now()
        years = now.year - born.year - (
            (now.month, now.day) < (born.month, born.day)
        )
        return max(0, years)
    except Exception:
        return None


def _normalize_squad_row(item: Dict[str, Any], team_name: str) -> Optional[Dict[str, Any]]:
    """Turn a Sportmonks squad item into the wc_players row shape."""
    player = item.get("player") or {}
    player_id = item.get("player_id") or player.get("id")
    if not player_id:
        return None
    name = player.get("display_name") or player.get("name") or player.get("common_name")
    if not name:
        return None
    position_id = item.get("position_id") or player.get("position_id")
    position_str = POSITION_BY_ID.get(int(position_id)) if position_id else None
    return {
        "api_player_id": int(player_id),
        "player_name": str(name).strip(),
        "team_name": team_name,
        "position": position_str,
        "age": _age_from_dob(player.get("date_of_birth")),
        "shirt_number": item.get("jersey_number"),
        "photo_url": player.get("image_path"),
    }


def upsert_squad(
    conn: sqlite3.Connection,
    team_name: str,
    rows: Iterable[Dict[str, Any]],
) -> int:
    """Insert / refresh wc_players rows for one national team. Returns count."""
    now = datetime.now(timezone.utc).isoformat()
    n = 0
    for item in rows:
        norm = _normalize_squad_row(item, team_name)
        if not norm:
            continue
        conn.execute(
            """
            INSERT INTO wc_players
                (api_player_id, player_name, team_name, position, age,
                 shirt_number, photo_url, updated_at)
            VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(api_player_id) DO UPDATE SET
                player_name=excluded.player_name,
                team_name=excluded.team_name,
                position=COALESCE(excluded.position, wc_players.position),
                age=COALESCE(excluded.age, wc_players.age),
                shirt_number=COALESCE(excluded.shirt_number, wc_players.shirt_number),
                photo_url=COALESCE(excluded.photo_url, wc_players.photo_url),
                updated_at=excluded.updated_at
            """,
            (
                norm["api_player_id"],
                norm["player_name"],
                norm["team_name"],
                norm["position"],
                norm["age"],
                norm["shirt_number"],
                norm["photo_url"],
                now,
            ),
        )
        n += 1
    conn.commit()
    return n


# ── Public entry point ───────────────────────────────────────────────────────

def sync_wc_2026_squads(
    path: Optional[Path] = None,
    *,
    sleep_between_calls: float = 0.3,
    max_teams: Optional[int] = None,
) -> Dict[str, Any]:
    """Pull every WC 2026 team squad from Sportmonks → wc_players.

    Parameters
    ----------
    path
        Override DB path (tests use this).
    sleep_between_calls
        Polite pause between squad fetches. Sportmonks doesn't publish a hard
        per-second cap but their pages mention treating the API kindly. 0.3s
        between 48 calls = 14s total delay, negligible against the run time.
    max_teams
        Cap how many teams to sync. Useful for smoke-testing (max_teams=2).

    Returns a summary dict suitable for logging into the job-meta table.
    """
    started = datetime.now(timezone.utc).isoformat()
    teams = fetch_wc_2026_teams()
    if max_teams is not None:
        teams = teams[:max_teams]

    conn = _get_db(path)
    _ensure_table(conn)
    try:
        total_players = 0
        team_summaries: List[Dict[str, Any]] = []
        for i, t in enumerate(teams):
            try:
                squad = fetch_team_squad(t["id"])
                inserted = upsert_squad(conn, t["name"], squad)
                total_players += inserted
                team_summaries.append({"team": t["name"], "players": inserted})
            except Exception as e:
                team_summaries.append({"team": t["name"], "error": str(e)[:120]})
            if i < len(teams) - 1 and sleep_between_calls > 0:
                time.sleep(sleep_between_calls)
    finally:
        conn.close()

    return {
        "provider": "sportmonks",
        "started_at": started,
        "season_id": WC_2026_SEASON_ID,
        "teams_seen": len(teams),
        "players_synced": total_players,
        "team_summaries": team_summaries,
    }


# ── CLI for manual runs ──────────────────────────────────────────────────────

def main() -> None:
    import argparse
    import json

    parser = argparse.ArgumentParser(
        description="Sync World Cup 2026 squads from Sportmonks into wc_players"
    )
    parser.add_argument(
        "--max-teams", type=int, default=None,
        help="Cap the number of teams to sync (smoke-test)",
    )
    parser.add_argument(
        "--sleep", type=float, default=0.3,
        help="Sleep between team-squad calls (seconds)",
    )
    args = parser.parse_args()
    summary = sync_wc_2026_squads(
        max_teams=args.max_teams,
        sleep_between_calls=args.sleep,
    )
    print(json.dumps(summary, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
