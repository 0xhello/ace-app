#!/usr/bin/env python3
"""
players.py — World Cup player context + goalscorer priors.

The Odds API doesn't currently surface player-prop markets for WC (tested
May 18; only btts is returning). Player props will likely open ~1-2 weeks
before kickoff. To avoid going in blind, we pre-build the player-context
layer NOW so that the moment props open:

  1. We know who's on each squad
  2. We have recent club-form stats (goals, assists, minutes, position)
  3. We have a per-player goalscorer prior — our independent estimate of
     P(player scores in this match) — that we can compare against the
     soft-book price the moment it appears

Data source: API-Football (free tier 100 req/day, paid tiers from $10/mo).
We minimize quota by only pulling top-scorer endpoints from major leagues
rather than per-player full-history calls.

Tables:
  wc_players          — one row per player in a WC squad
  wc_player_form      — recent club-season stats (last season's totals)
  wc_player_priors    — computed goalscorer probabilities per upcoming match

Usage:
    python3 -m ml.world_cup.players sync_squads     # pull all 32 team rosters
    python3 -m ml.world_cup.players sync_form       # pull top-scorer stats from major leagues
    python3 -m ml.world_cup.players priors          # compute goalscorer priors
    python3 -m ml.world_cup.players status          # show player data summary
"""
from __future__ import annotations

import math
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from .signal_logger import get_db, init_db, DB_PATH
from .context import _get, normalize, WC_LEAGUE_ID, WC_SEASON, API_FOOTBALL_KEY
from .historical import _normalize_player_name

# WC 2026 qualified countries (48-team format). Used for the teams-by-country
# workaround that lets us pull squads on the API-Football free tier — the
# `/teams?league=1&season=2026` path is plan-restricted, but `/teams?country=X`
# isn't. Update as final qualifiers settle (cross-confederation playoffs
# resolve close to kickoff).
WC_2026_COUNTRIES: List[str] = [
    # Hosts
    "USA", "Canada", "Mexico",
    # UEFA (16 from European qualifying)
    "France", "England", "Germany", "Spain", "Italy", "Netherlands",
    "Portugal", "Belgium", "Croatia", "Denmark", "Switzerland", "Poland",
    "Austria", "Czech-Republic", "Norway", "Ukraine",
    # CONMEBOL (6 from South American qualifying)
    "Argentina", "Brazil", "Uruguay", "Colombia", "Ecuador", "Paraguay",
    # AFC (8 from Asian qualifying)
    "Japan", "South-Korea", "Iran", "Saudi-Arabia", "Australia",
    "Iraq", "Qatar", "Uzbekistan",
    # CAF (9 from African qualifying)
    "Morocco", "Senegal", "Tunisia", "Egypt", "Algeria",
    "Nigeria", "Ghana", "Cameroon", "Ivory-Coast",
    # CONCACAF (3 non-host qualifiers)
    "Costa-Rica", "Jamaica", "Panama",
    # OFC (1)
    "New-Zealand",
    # Inter-confederation playoff slots (likely candidates)
    "Bolivia", "Congo-DR",
]

# Manual overrides where teams-by-country returns the wrong team
# (e.g. women's team appears first in USA search). Keys are API-Football
# country names; values are the verified men's national team_id.
_TEAM_ID_OVERRIDES: Dict[str, int] = {
    "USA": 2384,   # Women's USA returns first (id=1718) — pin the men's id
}

# Major club leagues to pull top-scorer / top-assist stats from. We use
# these to backfill recent form for WC squad players — most WC players
# play in one of these leagues year-round.
#   39  = English Premier League
#   140 = Spain La Liga
#   78  = Germany Bundesliga
#   135 = Italy Serie A
#   61  = France Ligue 1
#   88  = Netherlands Eredivisie
#   71  = Brazil Serie A
#   128 = Argentina Primera
#   253 = USA MLS
#   307 = Saudi Pro League (where several stars play now)
MAJOR_CLUB_LEAGUES = [39, 140, 78, 135, 61, 88, 71, 128, 253, 307]

# Club seasons to pull form from. We keep two seasons so the recency-weighted
# prior has a current + previous datapoint:
#   2025 = 2025-26 season (current — strongest weight)
#   2024 = 2024-25 season (previous — decayed weight)
CLUB_SEASONS = [2025, 2024]

# International tournaments to pull top-scorer stats from via API-Football.
# These are the major competitions that ran in the 12-24 months leading up
# to WC 2026 — most likely to contain the players we care about. Each entry:
#   (league_id, season, display_name, weight_year)
# weight_year is used by the recency weighting (a Copa 2024 tournament
# played in 2024 weights ahead of WC 2018, behind WC 2022, etc.)
#
# IDs verified against api-football.com docs; if a season isn't published
# yet for a given tournament, the fetch returns empty and we skip silently.
INTL_TOURNAMENTS: List[tuple] = [
    (9,   2024, "Copa America 2024",        2024),
    (6,   2024, "AFCON 2024",               2024),
    (7,   2023, "Asian Cup 2023",           2024),  # held Jan 2024
    (22,  2025, "Gold Cup 2025",            2025),
    (5,   2024, "UEFA Nations League 2024", 2024),
    (24,  2024, "CONCACAF Nations League 2024", 2024),
]


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

def init_player_tables(path: Path = DB_PATH) -> None:
    """Add player-context tables. Safe to call repeatedly. Additive only —
    keeps the existing context.py / signal_logger.py schemas untouched."""
    init_db(path)
    conn = get_db(path)
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS wc_players (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            api_player_id   INTEGER UNIQUE NOT NULL,
            player_name     TEXT NOT NULL,
            team_name       TEXT NOT NULL,    -- normalized WC country name
            position        TEXT,             -- 'Attacker' | 'Midfielder' | 'Defender' | 'Goalkeeper'
            age             INTEGER,
            shirt_number    INTEGER,
            photo_url       TEXT,
            updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );

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

        CREATE TABLE IF NOT EXISTS wc_player_priors (
            id                          INTEGER PRIMARY KEY AUTOINCREMENT,
            api_player_id               INTEGER NOT NULL,
            match_game_id               TEXT,            -- Odds API game id, null = team-level (not match-specific)
            expected_goals_in_match     REAL,
            anytime_scorer_prob         REAL,            -- 0-1
            first_scorer_prob           REAL,            -- 0-1
            assists_prob                REAL,            -- 0-1
            assumed_minutes             INTEGER DEFAULT 70,
            computed_at                 TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(api_player_id, match_game_id)
        );

        CREATE INDEX IF NOT EXISTS idx_wc_players_team
            ON wc_players(team_name);
        CREATE INDEX IF NOT EXISTS idx_wc_form_player
            ON wc_player_form(api_player_id);
        CREATE INDEX IF NOT EXISTS idx_wc_priors_player
            ON wc_player_priors(api_player_id);
    """)
    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# Sync: WC team list
# ---------------------------------------------------------------------------

def get_wc_teams(path: Path = DB_PATH) -> List[Dict[str, Any]]:
    """Resolve all WC 2026 national-team IDs.

    Order of attempts (graceful fallback):
      1. League+season query (needs paid API-Football plan for season 2026)
      2. Country-by-country search (works on free tier, slower — 48 calls)

    Returns a list of {api_team_id, name, country, code} dicts.
    """
    # Path 1: try the proper league+season endpoint first. On paid plans
    # this is cheaper (1 call vs 48) and returns the authoritative qualified
    # team list. On free tier the context._get wrapper logs a plan error
    # and returns None, falling through to path 2.
    data = _get("teams", {"league": WC_LEAGUE_ID, "season": WC_SEASON})
    if data:
        out = []
        for entry in data.get("response", []):
            team = entry.get("team", {}) or {}
            tid = team.get("id")
            if not tid:
                continue
            out.append({
                "api_team_id": tid,
                "name":        normalize(team.get("name", "")),
                "country":     team.get("country"),
                "code":        team.get("code"),
            })
        if out:
            return out

    # Path 2: free-tier workaround — discover each WC country's national
    # team via /teams?country=X. ~48 calls, runs once on the daily sync.
    # Caller (sync_wc_squads) then issues 1 squads call per team.
    print("  [players] Falling back to country-by-country team discovery (free-tier workaround)")
    return _discover_teams_by_country(WC_2026_COUNTRIES)


def _discover_teams_by_country(countries: List[str]) -> List[Dict[str, Any]]:
    """For each country name, find its men's national team via teams-by-country.

    Applies _TEAM_ID_OVERRIDES first when a country has a known disambiguation
    issue (USA returns women's team first, etc.). Returns the same shape as
    the league-based path so the rest of the pipeline doesn't care which
    source was used."""
    out: List[Dict[str, Any]] = []
    for country in countries:
        # Pinned override path — skip the API call when we know the ID
        if country in _TEAM_ID_OVERRIDES:
            out.append({
                "api_team_id": _TEAM_ID_OVERRIDES[country],
                "name":        normalize(country.replace("-", " ")),
                "country":     country,
                "code":        None,
            })
            continue

        data = _get("teams", {"country": country})
        if not data:
            continue
        teams = data.get("response", []) or []
        # Pick the national=True team. Skip ones with 'W' suffix (women's).
        for t in teams:
            team = t.get("team", {}) or {}
            if not team.get("national"):
                continue
            name = team.get("name", "") or ""
            if name.endswith(" W"):
                continue
            tid = team.get("id")
            if not tid:
                continue
            out.append({
                "api_team_id": tid,
                "name":        normalize(name),
                "country":     country,
                "code":        team.get("code"),
            })
            break  # first valid national team is enough
    return out


# ---------------------------------------------------------------------------
# Sync: squads (32 calls — one per team)
# ---------------------------------------------------------------------------

def sync_wc_squads(path: Path = DB_PATH) -> int:
    """Pull current squad for each WC team. Returns total player count.

    Quota cost: ~32 calls (one per team). With API-Football free tier at
    100/day we have plenty of headroom; the daily sync includes this plus
    sync_all (fixtures, standings, cards, injuries) for ~38 calls/day total.
    """
    init_player_tables(path)
    conn = get_db(path)
    now = datetime.now(timezone.utc).isoformat()

    teams = get_wc_teams(path)
    if not teams:
        print("  [players] No WC teams returned — check API_FOOTBALL_KEY and league_id")
        conn.close()
        return 0

    total = 0
    for t in teams:
        api_team_id = t["api_team_id"]
        team_name   = t["name"]
        if not api_team_id:
            continue

        data = _get("players/squads", {"team": api_team_id})
        if not data:
            continue

        for entry in data.get("response", []):
            for p in entry.get("players", []) or []:
                pid = p.get("id")
                if not pid:
                    continue
                conn.execute(
                    """
                    INSERT INTO wc_players
                        (api_player_id, player_name, team_name, position, age,
                         shirt_number, photo_url, updated_at)
                    VALUES (?,?,?,?,?,?,?,?)
                    ON CONFLICT(api_player_id) DO UPDATE SET
                        player_name  = excluded.player_name,
                        team_name    = excluded.team_name,
                        position     = excluded.position,
                        age          = excluded.age,
                        shirt_number = excluded.shirt_number,
                        photo_url    = excluded.photo_url,
                        updated_at   = excluded.updated_at
                    """,
                    (pid, p.get("name", ""), team_name, p.get("position"),
                     p.get("age"), p.get("number"), p.get("photo"), now),
                )
                total += 1

    conn.commit()
    conn.close()
    print(f"  [players] Squads synced: {total} players across {len(teams)} teams")
    return total


# ---------------------------------------------------------------------------
# Sync: form (top scorers from major club leagues)
# ---------------------------------------------------------------------------

def sync_club_form(path: Path = DB_PATH) -> int:
    """Pull top-scorer + top-assist data from major club leagues for every
    season in CLUB_SEASONS (current + previous). ~10 calls × 2 stat types ×
    2 seasons = 40 calls. Combined with squad sync = ~72 calls/day.

    Returns the number of (player, season, league) form rows upserted.
    """
    init_player_tables(path)
    conn = get_db(path)

    # Build a set of all WC squad player IDs so we only store form for
    # players we actually care about — keeps the form table small.
    wc_player_ids: set = {
        row["api_player_id"]
        for row in conn.execute("SELECT api_player_id FROM wc_players").fetchall()
    }
    if not wc_player_ids:
        print("  [players] No WC players cached — run sync_wc_squads first")
        conn.close()
        return 0

    now = datetime.now(timezone.utc).isoformat()
    upserted = 0

    for season in CLUB_SEASONS:
        for league_id in MAJOR_CLUB_LEAGUES:
            # Top scorers gives goals + appearances + minutes for the league's
            # top 20-30 scorers, which captures most of the prop-relevant
            # players (forwards, attacking midfielders) on WC squads.
            data = _get("players/topscorers", {"league": league_id, "season": season})
            if not data:
                continue

            for entry in data.get("response", []):
                player = entry.get("player", {}) or {}
                pid = player.get("id")
                if not pid or pid not in wc_player_ids:
                    continue  # ignore non-WC players

                stats_list = entry.get("statistics", []) or []
                if not stats_list:
                    continue
                s = stats_list[0]  # one row per (player, season, club)

                games = s.get("games", {}) or {}
                goals = s.get("goals", {}) or {}
                shots = s.get("shots", {}) or {}
                cards = s.get("cards", {}) or {}

                conn.execute(
                    """
                    INSERT INTO wc_player_form
                        (api_player_id, season, club_league_id, club_name,
                         appearances, minutes, goals, assists, shots, shots_on_target,
                         yellow_cards, red_cards, position, updated_at)
                    VALUES (?,?,?,?, ?,?,?,?,?,?, ?,?,?, ?)
                    ON CONFLICT(api_player_id, season, club_league_id) DO UPDATE SET
                        club_name       = excluded.club_name,
                        appearances     = excluded.appearances,
                        minutes         = excluded.minutes,
                        goals           = excluded.goals,
                        assists         = excluded.assists,
                        shots           = excluded.shots,
                        shots_on_target = excluded.shots_on_target,
                        yellow_cards    = excluded.yellow_cards,
                        red_cards       = excluded.red_cards,
                        position        = excluded.position,
                        updated_at      = excluded.updated_at
                    """,
                    (
                        pid, season, league_id,
                        (s.get("team") or {}).get("name"),
                        games.get("appearences", 0) or 0,   # API-Football typo: "appearences"
                        games.get("minutes", 0) or 0,
                        goals.get("total", 0) or 0,
                        goals.get("assists", 0) or 0,
                        shots.get("total", 0) or 0,
                        shots.get("on", 0) or 0,
                        cards.get("yellow", 0) or 0,
                        cards.get("red", 0) or 0,
                        games.get("position"),
                        now,
                    ),
                )
                upserted += 1

        # Same pass for top assists — different endpoint, captures playmakers
        # who don't always crack the top-scorer list.
        for league_id in MAJOR_CLUB_LEAGUES:
            data = _get("players/topassists", {"league": league_id, "season": season})
            if not data:
                continue

            for entry in data.get("response", []):
                player = entry.get("player", {}) or {}
                pid = player.get("id")
                if not pid or pid not in wc_player_ids:
                    continue

                stats_list = entry.get("statistics", []) or []
                if not stats_list:
                    continue
                s = stats_list[0]
                games = s.get("games", {}) or {}
                goals = s.get("goals", {}) or {}

                # Only upsert if we don't already have this player from topscorers
                existing = conn.execute(
                    "SELECT id FROM wc_player_form WHERE api_player_id = ? AND season = ? AND club_league_id = ?",
                    (pid, season, league_id),
                ).fetchone()
                if existing:
                    continue

                conn.execute(
                    """
                    INSERT INTO wc_player_form
                        (api_player_id, season, club_league_id, club_name,
                         appearances, minutes, goals, assists, position, updated_at)
                    VALUES (?,?,?,?, ?,?,?,?, ?,?)
                    """,
                    (
                        pid, season, league_id,
                        (s.get("team") or {}).get("name"),
                        games.get("appearences", 0) or 0,
                        games.get("minutes", 0) or 0,
                        goals.get("total", 0) or 0,
                        goals.get("assists", 0) or 0,
                        games.get("position"),
                        now,
                    ),
            )
            upserted += 1

    conn.commit()
    conn.close()
    print(f"  [players] Club form synced: {upserted} player-season rows")
    return upserted


# ---------------------------------------------------------------------------
# Sync: international tournament top-scorers (API-Football fallback)
# ---------------------------------------------------------------------------

def sync_intl_tournament_form(path: Path = DB_PATH) -> int:
    """Pull top-scorer stats for the recent major international tournaments
    that are NOT in StatsBomb open data — Copa America 2024, AFCON 2024,
    Asian Cup 2023, Gold Cup, Nations League. Writes into wc_historical_form
    so the same recency-weighted prior code path handles them.

    ~12 API-Football calls (6 tournaments × 2 endpoints). Skips silently
    if a tournament's season hasn't published or isn't covered by the plan.
    """
    # Defer import so cycles can't happen; the historical module owns the
    # shared wc_historical_form schema and the canonical-name alias map.
    from .historical import init_historical_tables, _normalize_player_name

    init_historical_tables(path)
    conn = get_db(path)
    now = datetime.now(timezone.utc).isoformat()

    upserted = 0
    for league_id, season, display_name, _year in INTL_TOURNAMENTS:
        agg: Dict[str, Dict[str, Any]] = {}

        # Top scorers
        data = _get("players/topscorers", {"league": league_id, "season": season})
        if data:
            for entry in data.get("response", []):
                player = entry.get("player", {}) or {}
                name = player.get("name", "")
                if not name:
                    continue
                stats_list = entry.get("statistics", []) or []
                if not stats_list:
                    continue
                s = stats_list[0]
                games = s.get("games", {}) or {}
                goals = s.get("goals", {}) or {}
                shots = s.get("shots", {}) or {}
                d = agg.setdefault(name, {
                    "country": (s.get("team") or {}).get("name"),
                    "matches": 0, "minutes": 0,
                    "goals": 0, "shots": 0, "sot": 0, "assists": 0,
                })
                # Tournament endpoint returns aggregate stats already
                d["matches"] = max(d["matches"], games.get("appearences", 0) or 0)
                d["minutes"] = max(d["minutes"], games.get("minutes",     0) or 0)
                d["goals"]   = max(d["goals"],   goals.get("total",       0) or 0)
                d["shots"]   = max(d["shots"],   shots.get("total",       0) or 0)
                d["sot"]     = max(d["sot"],     shots.get("on",          0) or 0)
                d["assists"] = max(d["assists"], goals.get("assists",     0) or 0)

        # Top assists (fills in playmakers who didn't crack top scorers)
        data2 = _get("players/topassists", {"league": league_id, "season": season})
        if data2:
            for entry in data2.get("response", []):
                player = entry.get("player", {}) or {}
                name = player.get("name", "")
                if not name:
                    continue
                stats_list = entry.get("statistics", []) or []
                if not stats_list:
                    continue
                s = stats_list[0]
                games = s.get("games", {}) or {}
                goals = s.get("goals", {}) or {}
                d = agg.setdefault(name, {
                    "country": (s.get("team") or {}).get("name"),
                    "matches": 0, "minutes": 0,
                    "goals": 0, "shots": 0, "sot": 0, "assists": 0,
                })
                d["matches"] = max(d["matches"], games.get("appearences", 0) or 0)
                d["minutes"] = max(d["minutes"], games.get("minutes",     0) or 0)
                d["assists"] = max(d["assists"], goals.get("assists",     0) or 0)

        if not agg:
            print(f"  [players] {display_name}: no data available (season {season})")
            continue

        # Collapse name variants before writing — same logic as the
        # StatsBomb path so the two sources land under one canonical row.
        merged_agg: Dict[str, Dict[str, Any]] = {}
        for name, d in agg.items():
            canonical = _normalize_player_name(name)
            m = merged_agg.setdefault(canonical, {
                "country": d["country"],
                "matches": 0, "minutes": 0,
                "goals": 0, "shots": 0, "sot": 0, "assists": 0,
            })
            m["matches"] = max(m["matches"], d["matches"])
            m["minutes"] = max(m["minutes"], d["minutes"])
            m["goals"]   = max(m["goals"],   d["goals"])
            m["shots"]   = max(m["shots"],   d["shots"])
            m["sot"]     = max(m["sot"],     d["sot"])
            m["assists"] = max(m["assists"], d["assists"])
            m["country"] = m["country"] or d["country"]

        for canonical, d in merged_agg.items():
            conn.execute(
                """INSERT INTO wc_historical_form
                   (player_name, competition, country, matches_played, minutes,
                    goals, shots, shots_on_target, assists, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(player_name, competition) DO UPDATE SET
                     country         = COALESCE(excluded.country, country),
                     matches_played  = excluded.matches_played,
                     minutes         = excluded.minutes,
                     goals           = excluded.goals,
                     shots           = excluded.shots,
                     shots_on_target = excluded.shots_on_target,
                     assists         = excluded.assists,
                     updated_at      = excluded.updated_at""",
                (canonical, display_name, d["country"],
                 d["matches"], d["minutes"], d["goals"],
                 d["shots"], d["sot"], d["assists"], now),
            )
            upserted += 1

        print(f"  [players] {display_name}: {len(agg)} player rows")

    conn.commit()
    conn.close()
    print(f"  [players] Intl tournament form synced: {upserted} rows")
    return upserted


# ---------------------------------------------------------------------------
# Goalscorer prior — the math layer
# ---------------------------------------------------------------------------

def _player_goals_per_90(form_rows: List[Dict[str, Any]]) -> Optional[float]:
    """Aggregate goals-per-90 across a player's reported form rows
    (unweighted — used as a fallback when we have no season context)."""
    total_min, total_goals = 0, 0
    for r in form_rows:
        total_min   += r.get("minutes",  0) or 0
        total_goals += r.get("goals",    0) or 0
    if total_min < 270:  # less than ~3 full matches → not enough sample
        return None
    return total_goals / (total_min / 90.0)


# Recency weight table. Heavier = more influence on the weighted average.
# These are deliberately spread so a recent club season dominates a stale
# international tournament, but a recent tournament still moves the needle.
_RECENCY_WEIGHTS = {
    "current_club":     1.00,   # 2025-26 club season
    "previous_club":    0.55,   # 2024-25 club season
    "recent_intl":      0.40,   # tournament within last ~12 months
    "midrange_intl":    0.20,   # tournament 1-3 years ago
    "old_intl":         0.10,   # 4+ years ago
}

def _current_year() -> int:
    """Derive the current calendar year at call time so the recency
    bucketing stays accurate without requiring an annual code edit.
    Was previously a hardcoded constant — that's the kind of value that
    rots silently past the WC and starts misclassifying tournament data
    months/years later when nobody notices."""
    from datetime import datetime
    return datetime.now().year


def _classify_club_season(season_year: int) -> str:
    if season_year >= max(CLUB_SEASONS):
        return "current_club"
    return "previous_club"


def _classify_intl_year(tournament_year: Optional[int]) -> str:
    """
    Bucketing (gap = current calendar year minus tournament year):
      gap 0-1 → recent_intl (current cycle: Gold Cup, Nations League finals
                immediately preceding WC; weight 0.40)
      gap 2-4 → midrange_intl (Euro/Copa/AFCON/Asian Cup of the cycle prior;
                also the last WC played 4y ago; weight 0.20)
      gap 5+  → old_intl (older tournaments; weight 0.10)
    """
    if tournament_year is None:
        return "old_intl"
    gap = _current_year() - tournament_year
    if gap <= 1:
        return "recent_intl"
    if gap <= 4:
        return "midrange_intl"
    return "old_intl"


def _extract_year_from_competition(comp: str) -> Optional[int]:
    """'WC 2022' → 2022. 'Asian Cup 2023' → 2023. Returns None on no match."""
    import re
    m = re.search(r"(20\d{2})", comp or "")
    return int(m.group(1)) if m else None


def _weighted_goals_per_90(
    club_form_rows: List[Dict[str, Any]],
    historical_rows: List[Dict[str, Any]],
) -> Optional[float]:
    """Recency-weighted aggregate goals-per-90.

    Combines:
      - current club season (weight 1.00)
      - previous club season (weight 0.55)
      - most recent intl tournament (weight 0.40)
      - mid-range intl tournaments  (weight 0.20)
      - old intl tournaments        (weight 0.10)

    Each bucket's goals and minutes are weighted by its bucket multiplier,
    then summed. Final rate = sum(weighted_goals) / (sum(weighted_min) / 90).

    Returns None if total weighted minutes < 270 (insufficient sample).
    """
    weighted_min, weighted_goals = 0.0, 0.0

    for r in club_form_rows:
        season = r.get("season")
        if season is None:
            continue
        bucket = _classify_club_season(int(season))
        w = _RECENCY_WEIGHTS[bucket]
        weighted_min   += (r.get("minutes",  0) or 0) * w
        weighted_goals += (r.get("goals",    0) or 0) * w

    for r in historical_rows:
        comp = r.get("competition", "")
        year = _extract_year_from_competition(comp)
        bucket = _classify_intl_year(year)
        w = _RECENCY_WEIGHTS[bucket]
        weighted_min   += (r.get("minutes", 0) or 0) * w
        weighted_goals += (r.get("goals",   0) or 0) * w

    if weighted_min < 270:
        return None
    return weighted_goals / (weighted_min / 90.0)


def _position_factor(position: Optional[str]) -> float:
    """Multiplier reflecting position-adjusted scoring rate. Defenders score
    much less than forwards even within their own minute counts."""
    if not position:
        return 0.55
    p = position.lower()
    if "attack" in p or "forward" in p or "striker" in p:
        return 1.00
    if "mid" in p:
        return 0.65
    if "defend" in p or "back" in p:
        return 0.25
    return 0.10  # goalkeeper or unknown


def _tournament_uplift(player_name: str, club_gpm: float, path: Path = DB_PATH) -> float:
    """Return a multiplier reflecting how this player has performed in
    past WC / Euro tournaments vs their club rate.

    >1.0 = player elevates in major tournaments (Mbappé at WC 2018/2022,
    Müller, etc.)
    <1.0 = player underperforms vs club (rare but happens — pressure,
    role change)
    1.0  = no historical data, or historical rate matches club rate

    Only fires if we have historical data; otherwise returns a neutral 1.0.
    """
    try:
        from .historical import historical_goals_per_90
    except Exception:
        return 1.0
    intl = historical_goals_per_90(player_name, path)
    if intl is None or club_gpm <= 0:
        return 1.0
    # Bound the uplift so a tiny tournament sample doesn't dominate.
    # 0.50× floor / 2.00× ceiling — keeps the prior sane.
    raw = intl / club_gpm
    return max(0.50, min(2.00, raw))


def compute_goalscorer_prior(
    api_player_id: int,
    expected_match_goals_for_team: float = 1.40,
    assumed_minutes: int = 70,
    path: Optional[Path] = None,
) -> Optional[Dict[str, Any]]:
    """
    Estimate P(player scores at least once) for an upcoming match.

    Inputs:
      expected_match_goals_for_team:
        Our best estimate of how many goals the player's team scores in
        this match. Default 1.40 is the international-tournament average.
        When Pinnacle posts a totals line for the match, fetch_signals can
        derive a sharper estimate (~total_line/2) and pass it in.
      assumed_minutes:
        Likely minutes the player plays. Defaults to 70 (starter average
        across substitutions). Set to 30 for likely-subs, 90 for ironmen.

    Math:
      goals_per_90    = aggregated across player's form rows
      pos_factor      = position-adjusted multiplier (1.0 striker, 0.25 def)
      lambda          = goals_per_90 * pos_factor * (minutes/90)
                        * (team_expected_goals / league_team_avg)
      P(scores >=1)   = 1 - exp(-lambda)   (Poisson approximation)

    Returns None if the player is unknown or has no form data.
    """
    # Resolve DB_PATH at call time (not definition) so tests can monkeypatch.
    if path is None:
        path = DB_PATH
    init_player_tables(path)
    conn = get_db(path)
    player = conn.execute(
        "SELECT * FROM wc_players WHERE api_player_id = ?", (api_player_id,)
    ).fetchone()
    if not player:
        conn.close()
        return None

    form_rows = [
        dict(r) for r in conn.execute(
            "SELECT * FROM wc_player_form WHERE api_player_id = ?", (api_player_id,)
        ).fetchall()
    ]
    # Pull historical rows by player name (StatsBomb + API-Football tournament
    # data are name-keyed since they don't share API-Football's player IDs).
    # Normalize the wc_players.player_name through the alias map so the
    # lookup matches the canonical row written by historical.download_competition
    # — without this, "Kylian Mbappé" in wc_players misses the canonical
    # "Kylian Mbappe" row in wc_historical_form and the recency-weighted
    # base rate silently drops the intl contribution.
    canonical_name = _normalize_player_name(player["player_name"])
    historical_rows: List[Dict[str, Any]] = []
    try:
        historical_rows = [
            dict(r) for r in conn.execute(
                "SELECT * FROM wc_historical_form WHERE player_name = ?",
                (canonical_name,),
            ).fetchall()
        ]
    except Exception:
        pass  # wc_historical_form may not exist yet on older DBs
    conn.close()

    # Recency-weighted: current club dominates, previous club + recent intl
    # tournaments contribute decayed, older tournaments minimal. Falls back
    # to the unweighted aggregate if the weighted total minutes is too thin.
    goals_per_90 = _weighted_goals_per_90(form_rows, historical_rows)
    if goals_per_90 is None:
        goals_per_90 = _player_goals_per_90(form_rows)
    if goals_per_90 is None:
        return None

    pos_factor = _position_factor(player["position"])
    # League team average ~1.35 gpg; if our team expected > that, scale up
    team_strength = max(0.5, min(2.0, expected_match_goals_for_team / 1.35))
    minute_factor = max(0.0, min(1.0, assumed_minutes / 90.0))

    # Tournament uplift: layer in past WC / Euro performance if we have it.
    # Returns 1.0 when there's no historical data (neutral — won't distort
    # priors for first-time tournament players). Uses the canonical name so
    # the alias map collapses multi-source variants identically to the
    # base-rate lookup above.
    intl_uplift = _tournament_uplift(canonical_name, goals_per_90, path)

    lambda_ = goals_per_90 * pos_factor * minute_factor * team_strength * intl_uplift
    anytime = 1.0 - math.exp(-lambda_)
    # First scorer is roughly anytime * (1 / (team_expected_goals + 1))
    first = anytime / max(1.0, expected_match_goals_for_team + 1.0)

    return {
        "api_player_id":         api_player_id,
        "player_name":           player["player_name"],
        "team_name":             player["team_name"],
        "position":              player["position"],
        "expected_goals_lambda": round(lambda_, 4),
        "anytime_scorer_prob":   round(anytime, 4),
        "first_scorer_prob":     round(first, 4),
        "assumed_minutes":       assumed_minutes,
        "intl_uplift":           round(intl_uplift, 3),
    }


def find_wc_player(name: str, path: Optional[Path] = None) -> Optional[Dict[str, Any]]:
    """Resolve a player name (from Odds API or anywhere) to a wc_players row.

    Odds API names vary by market — sometimes "Kylian Mbappe", sometimes
    "K. Mbappe", sometimes a different transliteration. We canonicalize
    both sides via the alias map and try exact match first, then a case-
    insensitive surname-tail fallback for the abbreviated-first-name case.

    Returns the wc_players row dict or None.

    `path` defaults to None so tests can monkeypatch DB_PATH at module level
    and have it resolved at call time (default args bind at definition).
    """
    if not name:
        return None
    if path is None:
        path = DB_PATH
    init_player_tables(path)
    canonical = _normalize_player_name(name)
    conn = get_db(path)
    try:
        # 1) Exact canonical match
        row = conn.execute(
            "SELECT * FROM wc_players WHERE player_name = ?", (canonical,),
        ).fetchone()
        if row:
            return dict(row)
        # 2) "K. Mbappe" → match by surname when there's only one candidate
        # for that surname. Picks the most likely full-name row for the
        # abbreviated form.
        tokens = canonical.split()
        if len(tokens) >= 2 and tokens[0].endswith("."):
            surname = tokens[-1]
            candidates = conn.execute(
                "SELECT * FROM wc_players WHERE player_name LIKE ?",
                (f"%{surname}",),
            ).fetchall()
            if len(candidates) == 1:
                return dict(candidates[0])
        return None
    finally:
        conn.close()


def get_team_top_scorers(team_name: str, n: int = 5, path: Path = DB_PATH) -> List[Dict[str, Any]]:
    """Return the top N players on a team by aggregate goals_per_90.

    Useful for the user-facing dashboard ("top WC scorers to watch") and
    for our own prior verification (do the priors match intuition?)."""
    init_player_tables(path)
    conn = get_db(path)
    rows = conn.execute(
        """
        SELECT p.api_player_id, p.player_name, p.position, p.age,
               COALESCE(SUM(f.goals),    0) AS total_goals,
               COALESCE(SUM(f.minutes),  0) AS total_minutes,
               COALESCE(SUM(f.assists),  0) AS total_assists,
               COALESCE(SUM(f.shots),    0) AS total_shots
          FROM wc_players p
          LEFT JOIN wc_player_form f ON f.api_player_id = p.api_player_id
         WHERE p.team_name = ?
         GROUP BY p.api_player_id
         HAVING total_minutes >= 270
         ORDER BY (CAST(total_goals AS FLOAT) / NULLIF(total_minutes, 0)) DESC
         LIMIT ?
        """,
        (team_name, n),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Sync orchestrator
# ---------------------------------------------------------------------------

def sync_all_players(path: Path = DB_PATH) -> Dict[str, int]:
    """Full player-context refresh. Called once daily from the worker.

    Total quota cost (API-Football):
      32 calls (squads) +
      40 calls (club form: 10 leagues × 2 endpoints × 2 seasons) +
      12 calls (6 intl tournaments × 2 endpoints) = ~84 calls/day
    Within free-tier 100/day; comfortably within paid-tier budgets.
    """
    print("  [players] Syncing WC squads...")
    squads = sync_wc_squads(path)
    print("  [players] Syncing club form (top scorers + assists, 2 seasons)...")
    form = sync_club_form(path)
    print("  [players] Syncing international tournament top scorers...")
    intl = sync_intl_tournament_form(path)
    return {"squads": squads, "form": form, "intl_tournaments": intl}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="World Cup player context")
    parser.add_argument(
        "command",
        choices=["sync_squads", "sync_form", "sync_intl", "sync_all", "priors", "status", "top"],
        help=(
            "sync_squads = pull all 32 team rosters | "
            "sync_form = pull club top-scorer stats (2 seasons) | "
            "sync_intl = pull intl tournament top-scorers (Copa Am, AFCON, Asian Cup, Nations League) | "
            "sync_all = all three | "
            "priors = compute goalscorer priors for all players | "
            "status = show summary | "
            "top = show top 5 scorers per WC team"
        ),
    )
    parser.add_argument("--team", help="(top only) limit to one team name")
    args = parser.parse_args()

    if not API_FOOTBALL_KEY:
        print("ERROR: API_FOOTBALL_KEY not set in .env.local", file=sys.stderr)
        sys.exit(1)

    if args.command == "sync_squads":
        sync_wc_squads()
    elif args.command == "sync_form":
        sync_club_form()
    elif args.command == "sync_intl":
        sync_intl_tournament_form()
    elif args.command == "sync_all":
        sync_all_players()
    elif args.command == "status":
        init_player_tables()
        conn = get_db()
        n_players = conn.execute("SELECT COUNT(*) FROM wc_players").fetchone()[0]
        n_teams   = conn.execute("SELECT COUNT(DISTINCT team_name) FROM wc_players").fetchone()[0]
        n_form    = conn.execute("SELECT COUNT(*) FROM wc_player_form").fetchone()[0]
        n_priors  = conn.execute("SELECT COUNT(*) FROM wc_player_priors").fetchone()[0]
        print(f"  Players  cached  : {n_players}  ({n_teams} teams)")
        print(f"  Form rows        : {n_form}")
        print(f"  Priors cached    : {n_priors}")
        conn.close()
    elif args.command == "top":
        init_player_tables()
        conn = get_db()
        teams = (
            [args.team]
            if args.team
            else [r[0] for r in conn.execute("SELECT DISTINCT team_name FROM wc_players ORDER BY team_name").fetchall()]
        )
        conn.close()
        for team in teams:
            scorers = get_team_top_scorers(team, n=5)
            if not scorers:
                continue
            print(f"\n  {team}:")
            for s in scorers:
                g, m = s["total_goals"], s["total_minutes"]
                rate = (g / max(m, 1) * 90) if m else 0
                print(f"    {s['player_name']:30s}  {s['position'] or '?':12s}  "
                      f"{g:3d}g / {m:4d}min ({rate:.2f}/90)")
    elif args.command == "priors":
        init_player_tables()
        conn = get_db()
        pids = [r[0] for r in conn.execute("SELECT api_player_id FROM wc_players").fetchall()]
        conn.close()
        computed = 0
        for pid in pids:
            prior = compute_goalscorer_prior(pid)
            if prior is None:
                continue
            conn2 = get_db()
            conn2.execute(
                """INSERT INTO wc_player_priors
                   (api_player_id, expected_goals_in_match, anytime_scorer_prob,
                    first_scorer_prob, assumed_minutes)
                   VALUES (?,?,?,?,?)
                   ON CONFLICT(api_player_id, match_game_id) DO UPDATE SET
                     expected_goals_in_match = excluded.expected_goals_in_match,
                     anytime_scorer_prob     = excluded.anytime_scorer_prob,
                     first_scorer_prob       = excluded.first_scorer_prob,
                     assumed_minutes         = excluded.assumed_minutes,
                     computed_at             = datetime('now')""",
                (pid, prior["expected_goals_lambda"], prior["anytime_scorer_prob"],
                 prior["first_scorer_prob"], prior["assumed_minutes"]),
            )
            conn2.commit()
            conn2.close()
            computed += 1
        print(f"  Priors computed: {computed} player(s)")
