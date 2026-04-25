#!/usr/bin/env python3
"""
update_team_state.py

Fetches the full current NBA season from ESPN's public API and rebuilds
latest_team_state.json with fresh rest days, margins, and scoring averages.

Cover rates (cover_rate_5, cover_rate_10) cannot be updated from ESPN
because ESPN doesn't provide historical spread lines. They are carried
forward from the last training run as neutral priors.

Usage:
    python3 -m ml.nba_spread.update_team_state [--season 2026]
"""
from __future__ import annotations

import json
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx

from .train_spread_model import TEAM_NAME_TO_CODE, TEAM_STATE_PATH

ESPN_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard"

# ESPN team abbreviation → our 3-letter code
ESPN_ABV_TO_CODE: Dict[str, str] = {
    "ATL": "atl", "BOS": "bos", "BKN": "bkn", "NJN": "bkn",
    "CHA": "cha", "CHO": "cha", "CHI": "chi", "CLE": "cle",
    "DAL": "dal", "DEN": "den", "DET": "det", "GS": "gs", "GSW": "gs",
    "HOU": "hou", "IND": "ind", "LAC": "lac", "LAL": "lal",
    "MEM": "mem", "MIA": "mia", "MIL": "mil", "MIN": "min",
    "NO": "no", "NOP": "no", "NY": "ny", "NYK": "ny",
    "OKC": "okc", "ORL": "orl", "PHI": "phi", "PHX": "phx",
    "POR": "por", "SAC": "sac", "SA": "sa", "SAS": "sa",
    "TOR": "tor", "UTA": "utah", "UTAH": "utah", "WAS": "wsh", "WSH": "wsh",
}


def _resolve_team(display_name: str, abbreviation: str) -> Optional[str]:
    if display_name in TEAM_NAME_TO_CODE:
        return TEAM_NAME_TO_CODE[display_name]
    code = ESPN_ABV_TO_CODE.get(abbreviation.upper())
    if code:
        return code
    # Partial match on last word (e.g. "Clippers" → lac)
    last = display_name.split()[-1].lower()
    for full_name, c in TEAM_NAME_TO_CODE.items():
        if full_name.lower().endswith(last):
            return c
    return None


def fetch_week(start: date, end: date) -> List[Dict[str, Any]]:
    date_str = f"{start.strftime('%Y%m%d')}-{end.strftime('%Y%m%d')}"
    try:
        resp = httpx.get(ESPN_SCOREBOARD, params={"dates": date_str, "limit": 100}, timeout=15)
        if resp.status_code != 200:
            return []
    except Exception:
        return []

    games = []
    for event in resp.json().get("events", []):
        competitions = event.get("competitions", [])
        if not competitions:
            continue
        comp = competitions[0]
        if not comp.get("status", {}).get("type", {}).get("completed"):
            continue

        competitors = comp.get("competitors", [])
        home = next((c for c in competitors if c["homeAway"] == "home"), None)
        away = next((c for c in competitors if c["homeAway"] == "away"), None)
        if not home or not away:
            continue

        try:
            home_score = int(home["score"])
            away_score = int(away["score"])
        except (KeyError, ValueError, TypeError):
            continue

        home_code = _resolve_team(home["team"]["displayName"], home["team"].get("abbreviation", ""))
        away_code = _resolve_team(away["team"]["displayName"], away["team"].get("abbreviation", ""))
        if not home_code or not away_code:
            continue

        games.append({
            "date": event["date"][:10],
            "home": home_code,
            "away": away_code,
            "score_home": home_score,
            "score_away": away_score,
        })
    return games


def fetch_season(season_start: date, today: date) -> List[Dict[str, Any]]:
    all_games: List[Dict[str, Any]] = []
    current = season_start
    week_num = 0

    while current <= today:
        end = min(current + timedelta(days=6), today)
        week_games = fetch_week(current, end)
        all_games.extend(week_games)
        week_num += 1

        if week_num % 4 == 0:
            print(f"    through {current.strftime('%b %d')} — {len(all_games)} games")

        current += timedelta(days=7)
        time.sleep(0.08)

    return all_games


def build_state(games: List[Dict[str, Any]], existing: Dict[str, Any]) -> Dict[str, Any]:
    sorted_games = sorted(games, key=lambda g: g["date"])

    # Build per-team game log
    team_log: Dict[str, List[Dict[str, Any]]] = {}
    for g in sorted_games:
        for role in ("home", "away"):
            team = g[role]
            pts_for = g["score_home"] if role == "home" else g["score_away"]
            pts_against = g["score_away"] if role == "home" else g["score_home"]
            team_log.setdefault(team, []).append({
                "date": g["date"],
                "margin": pts_for - pts_against,
                "pts_for": pts_for,
                "pts_against": pts_against,
            })

    state: Dict[str, Any] = {}
    for team, log in team_log.items():
        log.sort(key=lambda x: x["date"])
        last = log[-1]
        margins = [g["margin"] for g in log]
        pts_for = [g["pts_for"] for g in log]
        pts_against = [g["pts_against"] for g in log]

        # Rest days = gap between last two games
        if len(log) >= 2:
            d1 = datetime.strptime(log[-2]["date"], "%Y-%m-%d")
            d2 = datetime.strptime(last["date"], "%Y-%m-%d")
            rest = max(min((d2 - d1).days - 1, 7), 0)
        else:
            rest = 5

        month = int(last["date"][5:7])
        season = int(last["date"][:4]) + (1 if month >= 10 else 0)

        old = existing.get(team, {})
        state[team] = {
            "season": season,
            "last_game_date": last["date"],
            "rest_days": float(rest),
            "margin_last1": float(margins[-1]),
            "margin_avg_3": float(sum(margins[-3:]) / len(margins[-3:])),
            "margin_avg_5": float(sum(margins[-5:]) / len(margins[-5:])),
            "points_for_avg_5": float(sum(pts_for[-5:]) / len(pts_for[-5:])),
            "points_against_avg_5": float(sum(pts_against[-5:]) / len(pts_against[-5:])),
            # ESPN has no spread data — carry forward training-era cover rates
            "cover_rate_5": float(old.get("cover_rate_5", 0.5)),
            "cover_rate_10": float(old.get("cover_rate_10", 0.5)),
            "games_played": len(log),
        }

    # Teams with no games in new data keep old state
    for team, s in existing.items():
        if team not in state:
            state[team] = s

    return state


def run(season_year: int) -> None:
    today = date.today()
    season_start = date(season_year - 1, 10, 1)

    print("=" * 55)
    print(f"  ACE — Update Team State ({season_year - 1}-{str(season_year)[2:]} season)")
    print("=" * 55)
    print(f"  Fetching {season_start} → {today}  (~{((today - season_start).days // 7) + 1} weeks)")
    print()

    existing: Dict[str, Any] = {}
    if TEAM_STATE_PATH.exists():
        existing = json.loads(TEAM_STATE_PATH.read_text())
        print(f"  Loaded existing state ({len(existing)} teams — will carry forward cover rates)")

    print("  Fetching from ESPN...")
    games = fetch_season(season_start, today)
    print(f"\n  Total completed games: {len(games)}")

    if not games:
        print("  No games found. State unchanged.")
        return

    new_state = build_state(games, existing)
    TEAM_STATE_PATH.write_text(json.dumps(new_state, indent=2))

    print(f"  Saved {len(new_state)} teams → {TEAM_STATE_PATH}")
    print()
    print("  Most recent game dates:")
    by_date = sorted(new_state.items(), key=lambda x: x[1]["last_game_date"], reverse=True)
    for team, s in by_date[:10]:
        print(
            f"    {team:<6}  last={s['last_game_date']}  "
            f"margin_avg5={s['margin_avg_5']:+.1f}  "
            f"games={s['games_played']}"
        )


if __name__ == "__main__":
    import argparse
    today = date.today()
    default_season = today.year + 1 if today.month >= 10 else today.year

    parser = argparse.ArgumentParser()
    parser.add_argument("--season", type=int, default=default_season,
                        help="Season end year (2026 = 2025-26 season)")
    args = parser.parse_args()

    try:
        run(season_year=args.season)
    except Exception as e:
        print(f"\n  ERROR: {e}", file=sys.stderr)
        sys.exit(1)
