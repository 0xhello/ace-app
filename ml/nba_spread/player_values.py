#!/usr/bin/env python3
"""
player_values.py

Scrapes per-player BPM from Basketball Reference's current-season advanced stats
and writes a lookup artifact used by injuries.py for data-driven impact weights.

Two tiers of coverage:

  Tier 1 — BPM-scaled impact (positive BPM only):
    impact = min(1.0, max(0, bpm / 8.0) * min(1.0, mpg / 28.0))
    Jokic (~14 BPM, 35 mpg) = 1.0.  Solid starter (~4 BPM) = 0.5.

  Tier 2 — Starter floor (negative BPM rotation players):
    Any player with G >= MIN_GAMES_FLOOR and MPG >= MIN_MPG_FLOOR gets
    impact = STARTER_FLOOR_IMPACT (0.10) regardless of BPM.
    Captures rotation anchors like Ja Morant (-1.5 BPM, 28 mpg) whose
    absence still disrupts the lineup even though their net stats are negative.

Limitation: players who missed most of the season (Kyrie Irving, Haliburton,
Lillard) won't appear in the BRef table at all and cannot be recovered here.

Output: artifacts/player_values.json

Usage:
    python3 -m ml.nba_spread.player_values          # write artifact
    python3 -m ml.nba_spread.player_values --show   # print top-40 and exit
"""
from __future__ import annotations

import argparse
import json
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict

import pandas as pd

ARTIFACT_PATH = Path(__file__).resolve().parent / "artifacts" / "player_values.json"

# ── Tier 1 thresholds (BPM-based) ───────────────────────────────────────────
MIN_GAMES = 10
MIN_MPG   = 10.0

BPM_SCALE = 8.0   # bpm at this level → raw_impact = 1.0 before minute scaling
MP_SCALE  = 28.0  # mpg at this level → minute multiplier = 1.0

# ── Tier 2 thresholds (starter floor) ───────────────────────────────────────
MIN_GAMES_FLOOR      = 20    # must have played at least this many games
MIN_MPG_FLOOR        = 20.0  # must be a real rotation player (not a fill-in)
STARTER_FLOOR_IMPACT = 0.10  # conservative: captures lineup disruption, not star-level impact

# Combined row codes BRef uses for traded players.
# BRef uses 2TM/3TM/4TM (not always "TOT") depending on season — keep all to be safe.
_COMBINED_CODES = {"TOT", "2TM", "3TM", "4TM", "5TM"}

# Basketball Reference team abbreviation → our 3-letter code
_BREF_TO_CODE: Dict[str, str] = {
    "ATL": "atl", "BOS": "bos", "BRK": "bkn", "CHO": "cha",
    "CHI": "chi", "CLE": "cle", "DAL": "dal", "DEN": "den",
    "DET": "det", "GSW": "gs",  "HOU": "hou", "IND": "ind",
    "LAC": "lac", "LAL": "lal", "MEM": "mem", "MIA": "mia",
    "MIL": "mil", "MIN": "min", "NOP": "no",  "NYK": "ny",
    "OKC": "okc", "ORL": "orl", "PHI": "phi", "PHO": "phx",
    "POR": "por", "SAC": "sac", "SAS": "sa",  "TOR": "tor",
    "UTA": "utah","WAS": "wsh",
}


def _current_season_url() -> str:
    """
    Return the BRef advanced stats URL for the current NBA season.
    NBA seasons end in June; the URL year is the ending calendar year.
    """
    now = datetime.now(timezone.utc)
    # Season ending year: if we're past July it's next calendar year, else current
    year = now.year if now.month <= 7 else now.year + 1
    return f"https://www.basketball-reference.com/leagues/NBA_{year}_advanced.html"


def _normalize(name: str) -> str:
    nfd = unicodedata.normalize("NFD", name)
    ascii_str = nfd.encode("ascii", "ignore").decode("ascii")
    return ascii_str.lower().replace(".", "").replace("-", " ").strip()


def scrape_bpm() -> pd.DataFrame:
    """
    Fetch BRef advanced stats table and return clean per-player DataFrame.

    Dedup logic: for traded players BRef emits one row per team plus a combined
    row (TOT, 2TM, 3TM, or 4TM). We keep only the combined row for BPM accuracy,
    but record the player's most-recent individual team for the team lookup.

    team_raw in the result is:
      - A real 3-letter BRef abbreviation for non-traded players.
      - The last single-team row seen for traded players (best-effort current team).
    """
    url = _current_season_url()
    tables = pd.read_html(url, header=0)
    df_raw = tables[0].copy()

    # BRef repeats the header row every 20 rows — drop them
    df_raw = df_raw[df_raw["Player"] != "Player"].reset_index(drop=True)
    df_raw = df_raw.rename(columns={"Team": "team_raw"})

    # Build a map of player → last individual team seen (order = table order = chronological)
    individual_rows = df_raw[~df_raw["team_raw"].isin(_COMBINED_CODES)]
    last_team = individual_rows.groupby("Player")["team_raw"].last()

    # Keep only combined rows for traded players; keep single-team rows as-is
    has_combined = df_raw[df_raw["team_raw"].isin(_COMBINED_CODES)]["Player"].unique()
    df = df_raw[~((df_raw["Player"].isin(has_combined)) & (~df_raw["team_raw"].isin(_COMBINED_CODES)))].copy()

    # Replace the combined-row team code with the player's last real team
    mask_combined = df["team_raw"].isin(_COMBINED_CODES)
    df.loc[mask_combined, "team_raw"] = df.loc[mask_combined, "Player"].map(last_team)

    for col in ("BPM", "MP", "G"):
        df[col] = pd.to_numeric(df[col], errors="coerce")

    df = df.dropna(subset=["BPM", "MP", "G"])
    df["MPG"] = df["MP"] / df["G"]

    # Minimum filter applied here removes tiny-sample outliers before tier logic.
    # Use the lower Tier-1 thresholds; tier-2 applies its own higher thresholds later.
    df = df[(df["G"] >= MIN_GAMES) & (df["MPG"] >= MIN_MPG)]

    return df[["Player", "team_raw", "BPM", "MPG", "G"]].copy()


def build_player_dict(df: pd.DataFrame) -> Dict[str, Any]:
    players: Dict[str, Any] = {}

    for _, row in df.iterrows():
        name_raw = str(row["Player"])
        team_raw = str(row["team_raw"]).strip()
        bpm  = float(row["BPM"])
        mpg  = float(row["MPG"])
        g    = int(row["G"])

        # Map team code; combined rows (2TM etc.) get None — only used in fallback
        team_code = _BREF_TO_CODE.get(team_raw.upper())

        key = _normalize(name_raw)

        # Tier 1: BPM-scaled impact
        raw_impact    = max(0.0, bpm / BPM_SCALE)
        minute_scale  = min(1.0, mpg / MP_SCALE)
        bpm_impact    = round(min(1.0, raw_impact * minute_scale), 4)

        # Tier 2: starter floor for negative-BPM rotation players
        if bpm_impact == 0.0 and g >= MIN_GAMES_FLOOR and mpg >= MIN_MPG_FLOOR:
            impact = STARTER_FLOOR_IMPACT
            tier   = "floor"
        elif bpm_impact > 0.0:
            impact = bpm_impact
            tier   = "bpm"
        else:
            continue  # skip: below floor thresholds AND negative BPM

        players[key] = {
            "name":   name_raw,
            "team":   team_code,   # None for traded players — exact match still works
            "bpm":    round(bpm, 2),
            "mpg":    round(mpg, 1),
            "g":      g,
            "impact": impact,
            "tier":   tier,
        }

    return players


def fetch_and_save() -> Dict[str, Any]:
    url = _current_season_url()
    print(f"  Scraping Basketball Reference: {url}")
    df = scrape_bpm()

    players = build_player_dict(df)
    tier_bpm   = sum(1 for p in players.values() if p["tier"] == "bpm")
    tier_floor = sum(1 for p in players.values() if p["tier"] == "floor")
    print(f"  {len(players)} players total  ({tier_bpm} BPM-scaled, {tier_floor} starter-floor)")

    artifact = {
        "generated_at":        datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source_url":          url,
        "bpm_scale":           BPM_SCALE,
        "mp_scale":            MP_SCALE,
        "starter_floor_impact":STARTER_FLOOR_IMPACT,
        "players":             players,
    }

    ARTIFACT_PATH.write_text(json.dumps(artifact, indent=2))
    print(f"  Artifact written: {ARTIFACT_PATH}")
    return artifact


def show_top(artifact: Dict[str, Any], n: int = 40) -> None:
    players = artifact["players"]
    ranked  = sorted(players.items(), key=lambda x: x[1]["impact"], reverse=True)
    print(f"\n  {'Player':<30}  {'Team':<6}  {'BPM':>6}  {'MPG':>5}  {'G':>3}  {'Impact':>8}  Tier")
    print("  " + "─" * 72)
    for key, p in ranked[:n]:
        team = p["team"] or "??"
        print(
            f"  {p['name']:<30}  {team:<6}  {p['bpm']:>6.2f}  {p['mpg']:>5.1f}"
            f"  {p['g']:>3}  {p['impact']:>8.4f}  {p['tier']}"
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--show", action="store_true", help="Print top-40 and exit without saving")
    parser.add_argument("--top",  type=int, default=40, help="Number of players to show (with --show)")
    args = parser.parse_args()

    artifact = fetch_and_save()

    show_top(artifact, n=args.top if args.show else 10)
    print(f"\n  Generated at: {artifact['generated_at']}")
    print(f"  Source: {artifact['source_url']}")
