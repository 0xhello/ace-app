#!/usr/bin/env python3
"""
context.py — World Cup game context via API-Football (api-sports.io / RapidAPI).

Provides three things that make divergence signals smarter:
  1. Group standings → detect dead rubber games (teams resting starters)
  2. Lineup confirmations → flag missing key players 1hr before kickoff
  3. Yellow card counts → flag suspension risks in knockout rounds

Data is cached in the same signal_log.db to avoid burning free-tier quota
on repeat calls. Sync functions are designed to be called once per poll tick.

Setup:
  Sign up free at https://dashboard.api-football.com/ (100 req/day)
  OR via RapidAPI: https://rapidapi.com/api-sports/api/api-football
  Add to .env.local:
    API_FOOTBALL_KEY=your_key_here
    # If using RapidAPI instead of direct:
    API_FOOTBALL_VIA_RAPIDAPI=true

Usage:
    python3 -m ml.world_cup.context sync       # pull fixtures + standings
    python3 -m ml.world_cup.context lineups    # pull today's lineups
    python3 -m ml.world_cup.context status     # show cached context summary
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

import httpx
from dotenv import load_dotenv

from .signal_logger import get_db, init_db, DB_PATH

_ENV_PATH = Path(__file__).resolve().parents[2] / ".env.local"
load_dotenv(_ENV_PATH)

API_FOOTBALL_KEY     = os.getenv("API_FOOTBALL_KEY", "")
VIA_RAPIDAPI         = os.getenv("API_FOOTBALL_VIA_RAPIDAPI", "").lower() in ("1", "true", "yes")

_DIRECT_BASE  = "https://v3.football.api-sports.io"
_RAPID_BASE   = "https://api-football-v3.p.rapidapi.com"
BASE_URL      = _RAPID_BASE if VIA_RAPIDAPI else _DIRECT_BASE

# FIFA World Cup league ID on API-Football.
# 2022 WC = 1. Run `python3 -m ml.world_cup.context discover` to confirm 2026 ID.
WC_LEAGUE_ID  = 1
WC_SEASON     = 2026

_TZ_ET = ZoneInfo("America/New_York")

# ---------------------------------------------------------------------------
# Team name normalization (Odds API ↔ API-Football name differences)
# ---------------------------------------------------------------------------

_NORMALIZE: Dict[str, str] = {
    # API-Football name → canonical name used in our signals DB
    "Korea Republic":    "South Korea",
    "IR Iran":           "Iran",
    "USA":               "United States",
    "Côte d'Ivoire":     "Ivory Coast",
    "Cote d'Ivoire":     "Ivory Coast",
    "Bosnia":            "Bosnia and Herzegovina",
    "Trinidad Tobago":   "Trinidad and Tobago",
    "Cape Verde":        "Cape Verde Islands",
}

def normalize(name: str) -> str:
    return _NORMALIZE.get(name, name)


# ---------------------------------------------------------------------------
# HTTP client
# ---------------------------------------------------------------------------

def _headers() -> Dict[str, str]:
    if VIA_RAPIDAPI:
        return {
            "X-RapidAPI-Key":  API_FOOTBALL_KEY,
            "X-RapidAPI-Host": "api-football-v3.p.rapidapi.com",
        }
    return {"x-apisports-key": API_FOOTBALL_KEY}


def _get(endpoint: str, params: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Single GET call. Returns parsed JSON or None on error."""
    if not API_FOOTBALL_KEY:
        print("  [context] API_FOOTBALL_KEY not set — skipping", file=sys.stderr)
        return None
    try:
        resp = httpx.get(
            f"{BASE_URL}/{endpoint}",
            headers=_headers(),
            params=params,
            timeout=10,
        )
        remaining = resp.headers.get("x-ratelimit-requests-remaining")
        if remaining and int(remaining) < 10:
            print(f"  [context] API-Football quota low: {remaining} remaining", file=sys.stderr)
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        print(f"  [context] API error ({endpoint}): {e}", file=sys.stderr)
        return None


# ---------------------------------------------------------------------------
# DB schema extension (called from init_db in signal_logger)
# ---------------------------------------------------------------------------

def init_context_tables(path: Path = DB_PATH) -> None:
    """Add World Cup context tables. Safe to call repeatedly."""
    init_db(path)
    conn = get_db(path)
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS wc_fixtures (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            api_id          INTEGER UNIQUE NOT NULL,
            home_team       TEXT NOT NULL,
            away_team       TEXT NOT NULL,
            game_date       DATE NOT NULL,
            commence_time   TEXT NOT NULL,
            group_name      TEXT,
            round           TEXT,
            status          TEXT DEFAULT 'NS',  -- NS/1H/HT/2H/FT
            home_score      INTEGER,
            away_score      INTEGER,
            updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS wc_standings (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            group_name  TEXT NOT NULL,
            team_name   TEXT NOT NULL,
            played      INTEGER DEFAULT 0,
            won         INTEGER DEFAULT 0,
            drawn       INTEGER DEFAULT 0,
            lost        INTEGER DEFAULT 0,
            points      INTEGER DEFAULT 0,
            goals_for   INTEGER DEFAULT 0,
            goals_against INTEGER DEFAULT 0,
            updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(group_name, team_name)
        );

        CREATE TABLE IF NOT EXISTS wc_lineups (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            api_fixture_id  INTEGER NOT NULL,
            team_name       TEXT NOT NULL,
            player_name     TEXT NOT NULL,
            shirt_number    INTEGER,
            position        TEXT,
            is_starting     INTEGER NOT NULL DEFAULT 1,  -- 1=starting, 0=sub
            fetched_at      TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(api_fixture_id, team_name, player_name)
        );

        CREATE TABLE IF NOT EXISTS wc_player_cards (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            team_name   TEXT NOT NULL,
            player_name TEXT NOT NULL,
            yellow_total INTEGER DEFAULT 0,
            red_total    INTEGER DEFAULT 0,
            updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(team_name, player_name)
        );

        -- Player injuries / unavailability from API-Football. One row per
        -- (team, player). Status reflects the most recent feed entry.
        CREATE TABLE IF NOT EXISTS wc_injuries (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            team_name    TEXT NOT NULL,
            player_name  TEXT NOT NULL,
            status       TEXT NOT NULL,     -- 'out' | 'questionable' | 'suspended'
            reason       TEXT,              -- 'Knee Injury' / 'Yellow Card Accumulation' / etc.
            updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(team_name, player_name)
        );

        CREATE INDEX IF NOT EXISTS idx_wc_fix_teams
            ON wc_fixtures(home_team, away_team, game_date);
        CREATE INDEX IF NOT EXISTS idx_wc_fix_api_id
            ON wc_fixtures(api_id);
        CREATE INDEX IF NOT EXISTS idx_wc_stand_group
            ON wc_standings(group_name);
        CREATE INDEX IF NOT EXISTS idx_wc_injuries_team
            ON wc_injuries(team_name);
    """)
    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# Sync: fixtures
# ---------------------------------------------------------------------------

def sync_fixtures(path: Path = DB_PATH) -> int:
    """Pull all WC fixtures and cache them. Returns count upserted."""
    data = _get("fixtures", {"league": WC_LEAGUE_ID, "season": WC_SEASON})
    if not data:
        return 0

    init_context_tables(path)
    conn = get_db(path)
    now  = datetime.now(timezone.utc).isoformat()
    upserted = 0

    for f in data.get("response", []):
        fix   = f.get("fixture", {})
        teams = f.get("teams", {})
        goals = f.get("goals", {})
        league_info = f.get("league", {})

        api_id      = fix.get("id")
        home_team   = normalize(teams.get("home", {}).get("name", ""))
        away_team   = normalize(teams.get("away", {}).get("name", ""))
        ts          = fix.get("date", "")
        game_date   = ts[:10] if ts else ""
        status      = fix.get("status", {}).get("short", "NS")
        home_score  = goals.get("home")
        away_score  = goals.get("away")
        group_name  = league_info.get("round", "")  # API-Football puts group in round field
        round_name  = league_info.get("round", "")

        if not api_id or not home_team:
            continue

        conn.execute(
            """
            INSERT INTO wc_fixtures
                (api_id, home_team, away_team, game_date, commence_time,
                 group_name, round, status, home_score, away_score, updated_at)
            VALUES (?,?,?,?,?, ?,?,?,?,?, ?)
            ON CONFLICT(api_id) DO UPDATE SET
                status      = excluded.status,
                home_score  = excluded.home_score,
                away_score  = excluded.away_score,
                updated_at  = excluded.updated_at
            """,
            (api_id, home_team, away_team, game_date, ts,
             group_name, round_name, status, home_score, away_score, now),
        )
        upserted += 1

    conn.commit()
    conn.close()
    print(f"  [context] Fixtures synced: {upserted}")
    return upserted


# ---------------------------------------------------------------------------
# Sync: standings
# ---------------------------------------------------------------------------

def sync_standings(path: Path = DB_PATH) -> int:
    """Pull current group standings. Returns count upserted."""
    data = _get("standings", {"league": WC_LEAGUE_ID, "season": WC_SEASON})
    if not data:
        return 0

    init_context_tables(path)
    conn = get_db(path)
    now  = datetime.now(timezone.utc).isoformat()
    upserted = 0

    for league_block in data.get("response", []):
        for group in league_block.get("league", {}).get("standings", []):
            for entry in group:
                team_name  = normalize(entry.get("team", {}).get("name", ""))
                group_name = entry.get("group", "")
                all_stats  = entry.get("all", {})
                goals      = all_stats.get("goals", {})

                conn.execute(
                    """
                    INSERT INTO wc_standings
                        (group_name, team_name, played, won, drawn, lost,
                         points, goals_for, goals_against, updated_at)
                    VALUES (?,?,?,?,?,?, ?,?,?,?)
                    ON CONFLICT(group_name, team_name) DO UPDATE SET
                        played        = excluded.played,
                        won           = excluded.won,
                        drawn         = excluded.drawn,
                        lost          = excluded.lost,
                        points        = excluded.points,
                        goals_for     = excluded.goals_for,
                        goals_against = excluded.goals_against,
                        updated_at    = excluded.updated_at
                    """,
                    (
                        group_name, team_name,
                        all_stats.get("played", 0),
                        all_stats.get("win", 0),
                        all_stats.get("draw", 0),
                        all_stats.get("lose", 0),
                        entry.get("points", 0),
                        goals.get("for", 0),
                        goals.get("against", 0),
                        now,
                    ),
                )
                upserted += 1

    conn.commit()
    conn.close()
    print(f"  [context] Standings synced: {upserted} team rows")
    return upserted


# ---------------------------------------------------------------------------
# Sync: lineups (call only for games within 2 hours of kickoff)
# ---------------------------------------------------------------------------

def sync_lineups(api_fixture_id: int, path: Path = DB_PATH) -> int:
    """Pull confirmed lineups for a single fixture. Returns player count."""
    data = _get("fixtures/lineups", {"fixture": api_fixture_id})
    if not data:
        return 0

    init_context_tables(path)
    conn = get_db(path)
    now  = datetime.now(timezone.utc).isoformat()
    count = 0

    for team_block in data.get("response", []):
        team_name   = normalize(team_block.get("team", {}).get("name", ""))
        start_xi    = team_block.get("startXI", [])
        substitutes = team_block.get("substitutes", [])

        for entry in start_xi:
            p = entry.get("player", {})
            conn.execute(
                """
                INSERT OR REPLACE INTO wc_lineups
                    (api_fixture_id, team_name, player_name, shirt_number,
                     position, is_starting, fetched_at)
                VALUES (?,?,?,?,?,1,?)
                """,
                (api_fixture_id, team_name, p.get("name", ""),
                 p.get("number"), p.get("pos"), now),
            )
            count += 1

        for entry in substitutes:
            p = entry.get("player", {})
            conn.execute(
                """
                INSERT OR REPLACE INTO wc_lineups
                    (api_fixture_id, team_name, player_name, shirt_number,
                     position, is_starting, fetched_at)
                VALUES (?,?,?,?,?,0,?)
                """,
                (api_fixture_id, team_name, p.get("name", ""),
                 p.get("number"), p.get("pos"), now),
            )

    conn.commit()
    conn.close()
    return count


# ---------------------------------------------------------------------------
# Sync: player yellow cards (call daily during tournament)
# ---------------------------------------------------------------------------

def sync_player_cards(path: Path = DB_PATH) -> int:
    """Pull yellow/red card totals for all WC squads. Returns player count."""
    data = _get("players/squads", {"league": WC_LEAGUE_ID, "season": WC_SEASON})
    if not data:
        # Fallback: try top-cards endpoint
        data = _get("players/topredcards",
                    {"league": WC_LEAGUE_ID, "season": WC_SEASON})
    if not data:
        return 0

    init_context_tables(path)
    conn = get_db(path)
    now  = datetime.now(timezone.utc).isoformat()
    count = 0

    for entry in data.get("response", []):
        team_name = normalize(entry.get("team", {}).get("name", ""))
        for p in entry.get("players", []):
            cards = p.get("statistics", [{}])[0].get("cards", {}) if p.get("statistics") else {}
            yellow = cards.get("yellow", 0) or 0
            red    = cards.get("red", 0) or 0
            conn.execute(
                """
                INSERT INTO wc_player_cards
                    (team_name, player_name, yellow_total, red_total, updated_at)
                VALUES (?,?,?,?,?)
                ON CONFLICT(team_name, player_name) DO UPDATE SET
                    yellow_total = excluded.yellow_total,
                    red_total    = excluded.red_total,
                    updated_at   = excluded.updated_at
                """,
                (team_name, p.get("name", ""), yellow, red, now),
            )
            count += 1

    conn.commit()
    conn.close()
    print(f"  [context] Player cards synced: {count} players")
    return count


# ---------------------------------------------------------------------------
# Sync: injuries
# ---------------------------------------------------------------------------

def _normalize_injury_status(api_type: Optional[str], reason: Optional[str]) -> str:
    """
    Map API-Football injury 'type' + 'reason' to our internal status.
      API examples:
        type='Missing Fixture' + reason='Knee Injury'        → 'out'
        type='Missing Fixture' + reason='Suspended'          → 'suspended'
        type='Questionable'   + reason='Hamstring'           → 'questionable'
        type='Missing Fixture' + reason='Yellow Card'        → 'suspended'
    """
    t = (api_type or "").lower()
    r = (reason or "").lower()
    if "suspend" in r or "yellow card" in r or "red card" in r:
        return "suspended"
    if t == "questionable" or "doubt" in r or "doubtful" in r:
        return "questionable"
    return "out"  # default for Missing Fixture / Banned / etc.


def sync_injuries(path: Path = DB_PATH) -> int:
    """Pull current WC injury / unavailability report. Returns row count.

    API-Football /injuries returns one record per (player, fixture-they-miss).
    We collapse to the most recent (team, player) row — i.e. their current
    availability status.
    """
    data = _get("injuries", {"league": WC_LEAGUE_ID, "season": WC_SEASON})
    if not data:
        return 0

    init_context_tables(path)
    conn = get_db(path)
    now = datetime.now(timezone.utc).isoformat()

    # Clear stale rows — injuries resolve and shouldn't linger as 'out' forever.
    # Easiest: wipe and re-insert. With ~32 teams × maybe 5-10 unavailable
    # players per squad, this is at most a few hundred rows.
    conn.execute("DELETE FROM wc_injuries")

    count = 0
    seen: set = set()
    for entry in data.get("response", []):
        team_name = normalize(entry.get("team", {}).get("name", ""))
        player = entry.get("player", {}) or {}
        player_name = player.get("name", "")
        if not player_name or not team_name:
            continue
        # Skip dupes within the same response (API may list per-fixture)
        key = (team_name, player_name)
        if key in seen:
            continue
        seen.add(key)

        status = _normalize_injury_status(player.get("type"), player.get("reason"))
        conn.execute(
            """INSERT INTO wc_injuries
               (team_name, player_name, status, reason, updated_at)
               VALUES (?,?,?,?,?)""",
            (team_name, player_name, status, player.get("reason"), now),
        )
        count += 1

    conn.commit()
    conn.close()
    print(f"  [context] Injuries synced: {count} unavailable player(s)")
    return count


# ---------------------------------------------------------------------------
# Context lookup — called by fetch_signals.py before logging a signal
# ---------------------------------------------------------------------------

def find_fixture_id(
    home_team: str, away_team: str, game_date: str, path: Path = DB_PATH
) -> Optional[int]:
    """Return the API-Football fixture ID for this game, or None."""
    try:
        conn = get_db(path)
        row  = conn.execute(
            """
            SELECT api_id FROM wc_fixtures
            WHERE home_team = ? AND away_team = ? AND game_date = ?
            LIMIT 1
            """,
            (home_team, away_team, game_date),
        ).fetchone()
        conn.close()
        return int(row["api_id"]) if row else None
    except Exception:
        return None


def get_game_context(
    home_team: str,
    away_team: str,
    game_date: str,
    path: Path = DB_PATH,
) -> Dict[str, Any]:
    """
    Returns a context dict for a signal:
      lineup_confirmed: bool | None    (None = not yet available)
      dead_rubber: bool                (one/both teams already through, math resolved)
      suspension_risk: List[str]       (players with 4 yellows — one more = ban)
      unavailable_players: List[dict]  (currently out / suspended / questionable)
        each: {team, player, status, reason}
      notes: List[str]                 (human-readable flags for the signal notes field)
    """
    ctx: Dict[str, Any] = {
        "lineup_confirmed":    None,
        "dead_rubber":         False,
        "suspension_risk":     [],
        "unavailable_players": [],
        "notes":               [],
    }

    try:
        init_context_tables(path)
        conn = get_db(path)

        # Dead rubber check — is either team already mathematically through?
        group_rows = conn.execute(
            """
            SELECT team_name, points, played FROM wc_standings
            WHERE group_name = (
                SELECT group_name FROM wc_standings
                WHERE team_name = ? OR team_name = ?
                LIMIT 1
            )
            ORDER BY points DESC
            """,
            (home_team, away_team),
        ).fetchall()

        if group_rows:
            group_teams = [dict(r) for r in group_rows]
            for team in (home_team, away_team):
                standing = next((t for t in group_teams if t["team_name"] == team), None)
                if standing and standing["played"] >= 2:
                    # Simple heuristic: if top 2 on points with 1 game left, likely through
                    rank = next(
                        (i + 1 for i, t in enumerate(group_teams) if t["team_name"] == team), 99
                    )
                    if rank <= 2 and standing["points"] >= 6:
                        ctx["dead_rubber"] = True
                        ctx["notes"].append(f"DEAD RUBBER: {team} likely already qualified")

        # Suspension risk — 4 yellows in knockout phase = next yellow is ban
        for team in (home_team, away_team):
            at_risk = conn.execute(
                """
                SELECT player_name, yellow_total FROM wc_player_cards
                WHERE team_name = ? AND yellow_total >= 4
                ORDER BY yellow_total DESC
                """,
                (team,),
            ).fetchall()
            for r in at_risk:
                ctx["suspension_risk"].append(f"{r['player_name']} ({team}, {r['yellow_total']}Y)")
                ctx["notes"].append(
                    f"CARD RISK: {r['player_name']} ({team}) has {r['yellow_total']} yellows"
                )

        # Injury / suspension feed — currently unavailable players for both teams
        for team in (home_team, away_team):
            unavail = conn.execute(
                """SELECT player_name, status, reason FROM wc_injuries
                   WHERE team_name = ?
                   ORDER BY CASE status
                       WHEN 'out' THEN 0
                       WHEN 'suspended' THEN 1
                       WHEN 'questionable' THEN 2
                       ELSE 3 END""",
                (team,),
            ).fetchall()
            for r in unavail:
                ctx["unavailable_players"].append({
                    "team":   team,
                    "player": r["player_name"],
                    "status": r["status"],
                    "reason": r["reason"],
                })
                label = r["status"].upper()
                reason_str = f" — {r['reason']}" if r["reason"] else ""
                ctx["notes"].append(f"{label}: {r['player_name']} ({team}){reason_str}")

        # Lineup check — are confirmed lineups available for this game?
        api_id = find_fixture_id(home_team, away_team, game_date, path)
        if api_id:
            lineup_count = conn.execute(
                "SELECT COUNT(*) as n FROM wc_lineups WHERE api_fixture_id = ? AND is_starting = 1",
                (api_id,),
            ).fetchone()
            if lineup_count and lineup_count["n"] >= 20:  # both teams (11 each)
                ctx["lineup_confirmed"] = True
            elif lineup_count and lineup_count["n"] > 0:
                ctx["lineup_confirmed"] = False
                ctx["notes"].append("LINEUP: only partial lineup data available")

        conn.close()

    except Exception as e:
        print(f"  [context] get_game_context error: {e}", file=sys.stderr)

    return ctx


# ---------------------------------------------------------------------------
# Discover league ID (run once to confirm WC 2026 ID)
# ---------------------------------------------------------------------------

def discover_wc_league() -> None:
    """Print World Cup league IDs from API-Football."""
    data = _get("leagues", {"name": "World Cup", "type": "cup"})
    if not data:
        return
    for entry in data.get("response", []):
        league  = entry.get("league", {})
        country = entry.get("country", {})
        seasons = [s["year"] for s in entry.get("seasons", [])[-3:]]
        print(
            f"  ID={league.get('id'):5d}  {league.get('name')}  "
            f"({country.get('name')})  seasons={seasons}"
        )


# ---------------------------------------------------------------------------
# Scheduled sync — called by worker on each poll tick during tournament
# ---------------------------------------------------------------------------

def sync_all(path: Path = DB_PATH) -> None:
    """Full context refresh. Call once per hour during the tournament."""
    print("  [context] Syncing fixtures...")
    sync_fixtures(path)
    print("  [context] Syncing standings...")
    sync_standings(path)
    print("  [context] Syncing player cards...")
    sync_player_cards(path)
    print("  [context] Syncing injuries...")
    sync_injuries(path)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="World Cup context sync")
    parser.add_argument(
        "command",
        choices=["sync", "lineups", "status", "discover"],
        help="sync=full refresh, lineups=today's lineups, status=show cache, discover=find league ID",
    )
    args = parser.parse_args()

    if not API_FOOTBALL_KEY:
        print("ERROR: API_FOOTBALL_KEY not set in .env.local", file=sys.stderr)
        sys.exit(1)

    if args.command == "sync":
        sync_all()
    elif args.command == "discover":
        discover_wc_league()
    elif args.command == "status":
        init_context_tables()
        conn = get_db()
        fix_count  = conn.execute("SELECT COUNT(*) FROM wc_fixtures").fetchone()[0]
        team_count = conn.execute("SELECT COUNT(*) FROM wc_standings").fetchone()[0]
        card_count = conn.execute("SELECT COUNT(*) FROM wc_player_cards").fetchone()[0]
        inj_count  = conn.execute("SELECT COUNT(*) FROM wc_injuries").fetchone()[0]
        out_count  = conn.execute("SELECT COUNT(*) FROM wc_injuries WHERE status='out'").fetchone()[0]
        susp_count = conn.execute("SELECT COUNT(*) FROM wc_injuries WHERE status='suspended'").fetchone()[0]
        print(f"  Fixtures cached : {fix_count}")
        print(f"  Standings rows  : {team_count}")
        print(f"  Player cards    : {card_count}")
        print(f"  Unavailable     : {inj_count}  ({out_count} out · {susp_count} suspended)")
        # Dead rubber candidates
        risk = conn.execute(
            "SELECT player_name, team_name, yellow_total FROM wc_player_cards WHERE yellow_total >= 3 ORDER BY yellow_total DESC LIMIT 10"
        ).fetchall()
        if risk:
            print("\n  Players with 3+ yellows:")
            for r in risk:
                print(f"    {r['player_name']} ({r['team_name']}) — {r['yellow_total']}Y")
        conn.close()
    elif args.command == "lineups":
        init_context_tables()
        conn = get_db()
        today = datetime.now(_TZ_ET).strftime("%Y-%m-%d")
        games = conn.execute(
            "SELECT api_id, home_team, away_team FROM wc_fixtures WHERE game_date = ?",
            (today,),
        ).fetchall()
        conn.close()
        if not games:
            print(f"  No fixtures found for {today}")
        for g in games:
            print(f"  Fetching lineups: {g['away_team']} @ {g['home_team']}...")
            n = sync_lineups(g["api_id"])
            print(f"    → {n} players cached")
