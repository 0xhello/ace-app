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

# Club season we pull form from — 2025 = the season ending May 2026
CLUB_SEASON = 2025


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
    """List WC teams from API-Football — needs the league + season set."""
    data = _get("teams", {"league": WC_LEAGUE_ID, "season": WC_SEASON})
    if not data:
        return []
    out = []
    for entry in data.get("response", []):
        team = entry.get("team", {}) or {}
        out.append({
            "api_team_id": team.get("id"),
            "name":        normalize(team.get("name", "")),
            "country":     team.get("country"),
            "code":        team.get("code"),
        })
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
    """Pull top-scorer + top-assist data from major club leagues, store
    for any player that's on a WC squad. ~10 calls per stat type × 2 stat
    types = 20 calls. Combined with squad sync = ~52 calls/day.

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

    for league_id in MAJOR_CLUB_LEAGUES:
        # Top scorers gives goals + appearances + minutes for the league's
        # top 20-30 scorers, which captures most of the prop-relevant
        # players (forwards, attacking midfielders) on WC squads.
        data = _get("players/topscorers", {"league": league_id, "season": CLUB_SEASON})
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
                    pid, CLUB_SEASON, league_id,
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
        data = _get("players/topassists", {"league": league_id, "season": CLUB_SEASON})
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
                (pid, CLUB_SEASON, league_id),
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
                    pid, CLUB_SEASON, league_id,
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
# Goalscorer prior — the math layer
# ---------------------------------------------------------------------------

def _player_goals_per_90(form_rows: List[Dict[str, Any]]) -> Optional[float]:
    """Aggregate goals-per-90 across a player's reported form rows."""
    total_min, total_goals = 0, 0
    for r in form_rows:
        total_min   += r.get("minutes",  0) or 0
        total_goals += r.get("goals",    0) or 0
    if total_min < 270:  # less than ~3 full matches → not enough sample
        return None
    return total_goals / (total_min / 90.0)


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
    path: Path = DB_PATH,
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
    conn.close()

    goals_per_90 = _player_goals_per_90(form_rows)
    if goals_per_90 is None:
        return None

    pos_factor = _position_factor(player["position"])
    # League team average ~1.35 gpg; if our team expected > that, scale up
    team_strength = max(0.5, min(2.0, expected_match_goals_for_team / 1.35))
    minute_factor = max(0.0, min(1.0, assumed_minutes / 90.0))

    # Tournament uplift: layer in past WC / Euro performance if we have it.
    # Returns 1.0 when there's no historical data (neutral — won't distort
    # priors for first-time tournament players).
    intl_uplift = _tournament_uplift(player["player_name"], goals_per_90, path)

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
    """Full player-context refresh. Called once daily from the worker."""
    print("  [players] Syncing WC squads...")
    squads = sync_wc_squads(path)
    print("  [players] Syncing club form (top scorers + assists)...")
    form = sync_club_form(path)
    return {"squads": squads, "form": form}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="World Cup player context")
    parser.add_argument(
        "command",
        choices=["sync_squads", "sync_form", "sync_all", "priors", "status", "top"],
        help=(
            "sync_squads = pull all 32 team rosters | "
            "sync_form = pull club top-scorer stats | "
            "sync_all = both | "
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
