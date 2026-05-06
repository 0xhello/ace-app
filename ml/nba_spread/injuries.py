#!/usr/bin/env python3
"""
injuries.py

Fetches current NBA injury reports from ESPN's public API and computes
per-team injury impact scores used as a post-hoc probability adjustment.

This is NOT a trained feature. The training dataset (2008-2025) has no
historical injury records, so XGBoost learns nothing from them. Instead,
we apply a logit-space adjustment after prediction:

    adjusted_logit = logit(raw_prob) - home_impact * LOGIT_SCALE
                                     + away_impact * LOGIT_SCALE
    adjusted_prob  = sigmoid(adjusted_logit)

LOGIT_SCALE = 0.35 → a franchise player (impact=1.0) out shifts probability
by ~8-9% at p=0.50 (less at extremes — sigmoid naturally attenuates).

Player impact weights come from artifacts/player_values.json (BPM-based,
scraped from Basketball Reference). Run player_values.py to refresh.
"""
from __future__ import annotations

import json
import unicodedata
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx
import numpy as np

ESPN_INJURIES_URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries"
PLAYER_VALUES_PATH = Path(__file__).resolve().parent / "artifacts" / "player_values.json"

# Logit-space adjustment per 1.0 impact unit.
# 0.35 ≈ 8.7% prob shift when raw_prob = 0.50; attenuates naturally near 0/1.
LOGIT_SCALE = 0.35

# Status → fraction of impact to apply.
STATUS_WEIGHTS: Dict[str, float] = {
    "out": 1.0,
    "doubtful": 0.70,
    "questionable": 0.25,
    "probable": 0.0,
    "day-to-day": 0.20,
}

# ESPN team full name → our 3-letter code.
_TEAM_NAME_TO_CODE: Dict[str, str] = {
    "Atlanta Hawks": "atl", "Boston Celtics": "bos",
    "Brooklyn Nets": "bkn", "Charlotte Hornets": "cha",
    "Chicago Bulls": "chi", "Cleveland Cavaliers": "cle",
    "Dallas Mavericks": "dal", "Denver Nuggets": "den",
    "Detroit Pistons": "det", "Golden State Warriors": "gs",
    "Houston Rockets": "hou", "Indiana Pacers": "ind",
    "LA Clippers": "lac", "Los Angeles Clippers": "lac",
    "Los Angeles Lakers": "lal", "Memphis Grizzlies": "mem",
    "Miami Heat": "mia", "Milwaukee Bucks": "mil",
    "Minnesota Timberwolves": "min", "New Orleans Pelicans": "no",
    "New York Knicks": "ny", "Oklahoma City Thunder": "okc",
    "Orlando Magic": "orl", "Philadelphia 76ers": "phi",
    "Phoenix Suns": "phx", "Portland Trail Blazers": "por",
    "Sacramento Kings": "sac", "San Antonio Spurs": "sa",
    "Toronto Raptors": "tor", "Utah Jazz": "utah",
    "Washington Wizards": "wsh",
}


_GENERATIONAL_SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}


def _normalize(name: str) -> str:
    """Lowercase ASCII representation for fuzzy name matching."""
    nfd = unicodedata.normalize("NFD", name)
    ascii_str = nfd.encode("ascii", "ignore").decode("ascii")
    return ascii_str.lower().replace(".", "").replace("-", " ").strip()


def _last_name(normalized: str) -> str:
    """Last word of normalized name, skipping generational suffixes like Jr/II/III."""
    parts = normalized.split()
    while parts and parts[-1] in _GENERATIONAL_SUFFIXES:
        parts = parts[:-1]
    return parts[-1] if parts else ""


def _load_player_values() -> Dict[str, Any]:
    """
    Load BPM-based player impact values from the artifact.

    Returns dict of {normalized_name: {team, bpm, mpg, g, impact}}.
    Falls back to empty dict if artifact is missing — impact will be 0 for all.
    """
    if not PLAYER_VALUES_PATH.exists():
        return {}
    try:
        data = json.loads(PLAYER_VALUES_PATH.read_text())
        return data.get("players", {})
    except Exception:
        return {}


def fetch_injuries() -> Dict[str, List[Dict[str, Any]]]:
    """
    Fetch ESPN injury report.

    ESPN's endpoint returns team objects, each containing a nested injuries list:
      {"injuries": [{"displayName": "Atlanta Hawks", "injuries": [{athlete, status}, ...]}, ...]}

    Returns:
        {team_code: [{"name": str, "status": str, "weight": float}, ...]}
    """
    result: Dict[str, List[Dict[str, Any]]] = {}
    try:
        resp = httpx.get(ESPN_INJURIES_URL, timeout=10)
        if resp.status_code != 200:
            return result
        data = resp.json()
    except Exception:
        return result

    for team_item in data.get("injuries", []):
        team_name = team_item.get("displayName", "")
        team_code = _TEAM_NAME_TO_CODE.get(team_name)
        if not team_code:
            continue

        for inj in team_item.get("injuries", []):
            athlete = inj.get("athlete", {})
            full_name = (
                athlete.get("displayName")
                or f"{athlete.get('firstName', '')} {athlete.get('lastName', '')}".strip()
            )
            if not full_name:
                continue

            status_raw = inj.get("status", "").lower()

            weight = 0.0
            for key, w in STATUS_WEIGHTS.items():
                if key in status_raw:
                    weight = w
                    break
            if weight == 0.0:
                continue

            result.setdefault(team_code, []).append({
                "name": full_name,
                "status": status_raw,
                "weight": weight,
            })

    return result


def compute_team_impact(
    team_code: str,
    injuries: Dict[str, List[Dict[str, Any]]],
    player_values: Optional[Dict[str, Any]] = None,
) -> float:
    """
    Compute cumulative injury impact for one team using BPM-based weights.

    Player impact values come from the artifact (player_values.py output).
    Stars are additive up to a cap of 1.5 (prevents extreme adjustments
    when multiple key players are out simultaneously).
    """
    team_injuries = injuries.get(team_code, [])
    if not team_injuries:
        return 0.0

    if player_values is None:
        player_values = _load_player_values()

    total_impact = 0.0
    for inj in team_injuries:
        key = _normalize(inj["name"])
        player = player_values.get(key)

        # Fallback: last-name match within same team (strips Jr/II/III before comparing)
        if player is None:
            last = _last_name(key)
            if last:
                for pkey, pval in player_values.items():
                    if pval.get("team") == team_code and _last_name(pkey) == last:
                        player = pval
                        break

        if player is not None:
            total_impact += player["impact"] * inj["weight"]

    return min(total_impact, 1.5)  # cap prevents over-adjustment


def adjust_home_cover_prob(raw_prob: float, home_impact: float, away_impact: float) -> float:
    """
    Shift raw_prob in logit space to account for injury context.

    home_impact > 0  → home team has injured stars → reduce home cover prob
    away_impact > 0  → away team has injured stars → increase home cover prob
    """
    p = float(np.clip(raw_prob, 0.001, 0.999))
    logit = np.log(p / (1.0 - p))
    logit -= home_impact * LOGIT_SCALE
    logit += away_impact * LOGIT_SCALE
    return float(1.0 / (1.0 + np.exp(-logit)))


def get_game_impacts(
    home_team: str,
    away_team: str,
    injuries: Optional[Dict[str, List[Dict[str, Any]]]] = None,
    player_values: Optional[Dict[str, Any]] = None,
) -> Tuple[float, float]:
    """
    Convenience wrapper: fetch injuries once and compute impacts for a game.

    Returns (home_impact, away_impact).
    """
    if injuries is None:
        injuries = fetch_injuries()
    if player_values is None:
        player_values = _load_player_values()
    return (
        compute_team_impact(home_team, injuries, player_values),
        compute_team_impact(away_team, injuries, player_values),
    )


def print_injury_report(injuries: Optional[Dict[str, List[Dict[str, Any]]]] = None) -> None:
    """Print a human-readable injury report for all teams with impactful absences."""
    if injuries is None:
        injuries = fetch_injuries()

    player_values = _load_player_values()

    impactful = {
        team: players
        for team, players in injuries.items()
        if any(p["weight"] >= 0.25 for p in players)
    }

    if not impactful:
        print("  No impactful injuries found.")
        return

    for team in sorted(impactful):
        for p in impactful[team]:
            if p["weight"] < 0.25:
                continue
            key = _normalize(p["name"])
            player = player_values.get(key)
            if player is None:
                last = _last_name(key)
                if last:
                    for pkey, pval in player_values.items():
                        if pval.get("team") == team and _last_name(pkey) == last:
                            player = pval
                            break
            if player is not None:
                tag = f"  impact={player['impact']:.3f}  bpm={player['bpm']:+.1f}"
            else:
                tag = "  (not in player values)"
            print(f"  {team.upper():<6}  {p['name']:<30}  {p['status']:<14}  weight={p['weight']:.2f}{tag}")


if __name__ == "__main__":
    from datetime import datetime
    print("=" * 60)
    print("  ACE — NBA Injury Report")
    print(f"  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 60)
    inj = fetch_injuries()
    pv = _load_player_values()
    print(f"  Teams with injury data: {len(inj)}")
    print(f"  Player values loaded: {len(pv)} players")
    print()
    print_injury_report(inj)
