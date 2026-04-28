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
"""
from __future__ import annotations

import unicodedata
from typing import Any, Dict, List, Optional, Tuple

import httpx
import numpy as np

ESPN_INJURIES_URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries"

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

# ESPN team abbreviation → our 3-letter code (same mapping as update_team_state.py)
_ESPN_ABV_TO_CODE: Dict[str, str] = {
    "ATL": "atl", "BOS": "bos", "BKN": "bkn", "NJN": "bkn",
    "CHA": "cha", "CHO": "cha", "CHI": "chi", "CLE": "cle",
    "DAL": "dal", "DEN": "den", "DET": "det",
    "GS": "gs", "GSW": "gs",
    "HOU": "hou", "IND": "ind", "LAC": "lac", "LAL": "lal",
    "MEM": "mem", "MIA": "mia", "MIL": "mil", "MIN": "min",
    "NO": "no", "NOP": "no", "NY": "ny", "NYK": "ny",
    "OKC": "okc", "ORL": "orl", "PHI": "phi", "PHX": "phx",
    "POR": "por", "SAC": "sac", "SA": "sa", "SAS": "sa",
    "TOR": "tor", "UTA": "utah", "UTAH": "utah",
    "WAS": "wsh", "WSH": "wsh",
}

# Franchise / star players per team for 2025-26 season.
# impact = fraction of LOGIT_SCALE applied when this player is out.
# 1.0 = generational franchise anchor (Jokic, Wembanyama, etc.)
# 0.7 = clear #2 star / All-Star level
# 0.5 = important starter whose absence is meaningful but survivable
STAR_PLAYERS: Dict[str, List[Dict[str, Any]]] = {
    "atl": [{"name": "Trae Young", "impact": 1.0}, {"name": "Dejounte Murray", "impact": 0.6}],
    "bos": [{"name": "Jayson Tatum", "impact": 1.0}, {"name": "Jaylen Brown", "impact": 0.7}],
    "bkn": [{"name": "Cameron Johnson", "impact": 0.6}, {"name": "Nic Claxton", "impact": 0.5}],
    "cha": [{"name": "LaMelo Ball", "impact": 1.0}, {"name": "Miles Bridges", "impact": 0.5}],
    "chi": [{"name": "Zach LaVine", "impact": 0.8}, {"name": "Nikola Vucevic", "impact": 0.5}],
    "cle": [{"name": "Donovan Mitchell", "impact": 1.0}, {"name": "Evan Mobley", "impact": 0.6}, {"name": "Darius Garland", "impact": 0.6}],
    "dal": [{"name": "Kyrie Irving", "impact": 0.8}, {"name": "Klay Thompson", "impact": 0.5}],
    "den": [{"name": "Nikola Jokic", "impact": 1.0}, {"name": "Jamal Murray", "impact": 0.7}],
    "det": [{"name": "Cade Cunningham", "impact": 1.0}, {"name": "Jaden Ivey", "impact": 0.5}],
    "gs":  [{"name": "Stephen Curry", "impact": 1.0}, {"name": "Draymond Green", "impact": 0.5}],
    "hou": [{"name": "Alperen Sengun", "impact": 0.8}, {"name": "Jalen Green", "impact": 0.8}],
    "ind": [{"name": "Tyrese Haliburton", "impact": 1.0}, {"name": "Pascal Siakam", "impact": 0.7}],
    "lac": [{"name": "Kawhi Leonard", "impact": 0.9}, {"name": "James Harden", "impact": 0.7}],
    "lal": [{"name": "Anthony Davis", "impact": 1.0}, {"name": "LeBron James", "impact": 0.9}, {"name": "Luka Doncic", "impact": 1.0}],
    "mem": [{"name": "Ja Morant", "impact": 1.0}, {"name": "Desmond Bane", "impact": 0.5}],
    "mia": [{"name": "Bam Adebayo", "impact": 0.8}, {"name": "Tyler Herro", "impact": 0.6}],
    "mil": [{"name": "Giannis Antetokounmpo", "impact": 1.0}, {"name": "Damian Lillard", "impact": 0.7}],
    "min": [{"name": "Anthony Edwards", "impact": 1.0}, {"name": "Rudy Gobert", "impact": 0.5}],
    "no":  [{"name": "Zion Williamson", "impact": 1.0}, {"name": "Brandon Ingram", "impact": 0.8}],
    "ny":  [{"name": "Jalen Brunson", "impact": 1.0}, {"name": "Karl-Anthony Towns", "impact": 0.8}, {"name": "OG Anunoby", "impact": 0.6}],
    "okc": [{"name": "Shai Gilgeous-Alexander", "impact": 1.0}, {"name": "Jalen Williams", "impact": 0.7}, {"name": "Chet Holmgren", "impact": 0.6}],
    "orl": [{"name": "Paolo Banchero", "impact": 1.0}, {"name": "Franz Wagner", "impact": 0.8}],
    "phi": [{"name": "Joel Embiid", "impact": 1.0}, {"name": "Paul George", "impact": 0.7}],
    "phx": [{"name": "Kevin Durant", "impact": 1.0}, {"name": "Devin Booker", "impact": 0.9}],
    "por": [{"name": "Scoot Henderson", "impact": 0.8}, {"name": "Anfernee Simons", "impact": 0.7}],
    "sa":  [{"name": "Victor Wembanyama", "impact": 1.0}, {"name": "De'Aaron Fox", "impact": 0.7}],
    "sac": [{"name": "Domantas Sabonis", "impact": 0.9}, {"name": "DeMar DeRozan", "impact": 0.7}],
    "tor": [{"name": "Scottie Barnes", "impact": 1.0}, {"name": "RJ Barrett", "impact": 0.6}],
    "utah":[{"name": "Lauri Markkanen", "impact": 1.0}, {"name": "Jordan Clarkson", "impact": 0.5}],
    "wsh": [{"name": "Kyle Kuzma", "impact": 0.7}, {"name": "Jordan Poole", "impact": 0.6}],
}


def _normalize(name: str) -> str:
    """Lowercase ASCII representation for fuzzy name matching."""
    nfd = unicodedata.normalize("NFD", name)
    ascii_str = nfd.encode("ascii", "ignore").decode("ascii")
    return ascii_str.lower().replace(".", "").replace("-", " ").strip()


def _resolve_team_code(abv: str) -> Optional[str]:
    return _ESPN_ABV_TO_CODE.get(abv.upper())


def fetch_injuries() -> Dict[str, List[Dict[str, Any]]]:
    """
    Fetch ESPN injury report.

    Returns:
        {team_code: [{"name": str, "status": str}, ...]}
    """
    result: Dict[str, List[Dict[str, Any]]] = {}
    try:
        resp = httpx.get(ESPN_INJURIES_URL, timeout=10)
        if resp.status_code != 200:
            return result
        data = resp.json()
    except Exception:
        return result

    # ESPN injuries endpoint returns {"items": [...]} or {"injuries": [...]}
    items = data.get("items") or data.get("injuries") or []

    for item in items:
        athlete = item.get("athlete") or item.get("player") or {}
        full_name = (
            athlete.get("fullName")
            or athlete.get("displayName")
            or f"{athlete.get('firstName', '')} {athlete.get('lastName', '')}".strip()
        )
        if not full_name:
            continue

        # Status can be at top level or nested under "type"
        status_raw = (
            item.get("status")
            or (item.get("type") or {}).get("name")
            or (item.get("type") or {}).get("description")
            or ""
        ).lower()

        # Map to our weight keys
        weight = 0.0
        for key, w in STATUS_WEIGHTS.items():
            if key in status_raw:
                weight = w
                break
        if weight == 0.0:
            continue  # Probable / unknown — no adjustment

        # Team code
        team_data = athlete.get("team") or item.get("team") or {}
        abv = team_data.get("abbreviation", "")
        team_code = _resolve_team_code(abv)
        if not team_code:
            continue

        result.setdefault(team_code, []).append({
            "name": full_name,
            "status": status_raw,
            "weight": weight,
        })

    return result


def compute_team_impact(team_code: str, injuries: Dict[str, List[Dict[str, Any]]]) -> float:
    """
    Compute cumulative injury impact for one team.

    Stars are additive up to a cap of 1.5 (prevents extreme adjustments
    when multiple key players are out simultaneously).
    """
    team_injuries = injuries.get(team_code, [])
    if not team_injuries:
        return 0.0

    stars = STAR_PLAYERS.get(team_code, [])
    star_lookup = {_normalize(s["name"]): s["impact"] for s in stars}

    total_impact = 0.0
    for inj in team_injuries:
        key = _normalize(inj["name"])
        # Direct match
        star_impact = star_lookup.get(key)
        # Fallback: last-name match
        if star_impact is None:
            last = key.split()[-1]
            for star_key, imp in star_lookup.items():
                if star_key.split()[-1] == last:
                    star_impact = imp
                    break
        if star_impact is not None:
            total_impact += star_impact * inj["weight"]

    return min(total_impact, 1.5)  # cap prevents over-adjustment


def adjust_home_cover_prob(raw_prob: float, home_impact: float, away_impact: float) -> float:
    """
    Shift raw_prob in logit space to account for injury context.

    home_impact > 0  → home team has injured stars → reduce home cover prob
    away_impact > 0  → away team has injured stars → increase home cover prob
    """
    # Clamp to avoid log(0) / log(inf)
    p = float(np.clip(raw_prob, 0.001, 0.999))
    logit = np.log(p / (1.0 - p))
    logit -= home_impact * LOGIT_SCALE
    logit += away_impact * LOGIT_SCALE
    return float(1.0 / (1.0 + np.exp(-logit)))


def get_game_impacts(
    home_team: str,
    away_team: str,
    injuries: Optional[Dict[str, List[Dict[str, Any]]]] = None,
) -> Tuple[float, float]:
    """
    Convenience wrapper: fetch injuries once and compute impacts for a game.

    Returns (home_impact, away_impact).
    """
    if injuries is None:
        injuries = fetch_injuries()
    return (
        compute_team_impact(home_team, injuries),
        compute_team_impact(away_team, injuries),
    )


def print_injury_report(injuries: Optional[Dict[str, List[Dict[str, Any]]]] = None) -> None:
    """Print a human-readable injury report for all teams with impactful absences."""
    if injuries is None:
        injuries = fetch_injuries()

    impactful = {
        team: players
        for team, players in injuries.items()
        if any(p["weight"] >= 0.25 for p in players)
    }

    if not impactful:
        print("  No impactful injuries found.")
        return

    for team in sorted(impactful):
        stars = {_normalize(s["name"]): s for s in STAR_PLAYERS.get(team, [])}
        for p in impactful[team]:
            key = _normalize(p["name"])
            is_star = key in stars or any(
                stars[k]["impact"] for k in stars if k.split()[-1] == key.split()[-1]
            )
            if p["weight"] >= 0.25:
                tag = "  *** STAR" if is_star else ""
                print(f"  {team.upper():<6}  {p['name']:<30}  {p['status']:<14}  weight={p['weight']:.2f}{tag}")


if __name__ == "__main__":
    from datetime import datetime
    print("=" * 55)
    print("  ACE — NBA Injury Report")
    print(f"  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 55)
    inj = fetch_injuries()
    print(f"  Teams with injury data: {len(inj)}")
    print()
    print_injury_report(inj)
