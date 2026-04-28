#!/usr/bin/env python3
"""
fetch_efficiency_data.py

Scrapes Basketball Reference for NBA team season-level advanced efficiency stats
(ORtg, DRtg, NRtg, Pace, TS%) for every season from 2007 through the current season.

Output: ml/nba_spread/data/team_season_efficiency.csv
  season  team_code  ortg   drtg   net_rtg  pace   ts_pct

Usage:
    python3 -m ml.nba_spread.fetch_efficiency_data

Safe to re-run — fetches all seasons and overwrites the file.
"""
from __future__ import annotations

import io
import sys
import time
import urllib.request
from pathlib import Path
from typing import Optional

import pandas as pd

DATA_DIR = Path(__file__).resolve().parent / "data"
OUTPUT_PATH = DATA_DIR / "team_season_efficiency.csv"

# Basketball Reference full name → our team code
# Includes historical franchises (relocated / renamed teams)
_BBREF_TO_CODE: dict[str, str] = {
    "Atlanta Hawks": "atl",
    "Boston Celtics": "bos",
    "Brooklyn Nets": "bkn",
    "New Jersey Nets": "bkn",
    "Charlotte Hornets": "cha",
    "Charlotte Bobcats": "cha",
    "Chicago Bulls": "chi",
    "Cleveland Cavaliers": "cle",
    "Dallas Mavericks": "dal",
    "Denver Nuggets": "den",
    "Detroit Pistons": "det",
    "Golden State Warriors": "gs",
    "Houston Rockets": "hou",
    "Indiana Pacers": "ind",
    "LA Clippers": "lac",
    "Los Angeles Clippers": "lac",
    "Los Angeles Lakers": "lal",
    "Memphis Grizzlies": "mem",
    "Miami Heat": "mia",
    "Milwaukee Bucks": "mil",
    "Minnesota Timberwolves": "min",
    "New Orleans Pelicans": "no",
    "New Orleans Hornets": "no",
    "New Orleans/Oklahoma City Hornets": "no",
    "New York Knicks": "ny",
    "Oklahoma City Thunder": "okc",
    "Seattle SuperSonics": "okc",
    "Orlando Magic": "orl",
    "Philadelphia 76ers": "phi",
    "Phoenix Suns": "phx",
    "Portland Trail Blazers": "por",
    "Sacramento Kings": "sac",
    "San Antonio Spurs": "sa",
    "Toronto Raptors": "tor",
    "Utah Jazz": "utah",
    "Washington Wizards": "wsh",
    "Washington Bullets": "wsh",
}


def _fetch_html(url: str) -> str:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0 (research/educational use)"},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.read().decode("utf-8")


def _parse_ratings_table(html: str, season: int) -> Optional[pd.DataFrame]:
    """
    Find the misc/ratings table (table index 10 on the season summary page).
    It has multi-level headers — flatten them before reading.
    """
    tables = pd.read_html(io.StringIO(html))

    ratings: Optional[pd.DataFrame] = None
    for t in tables:
        cols = t.columns
        # Multi-level: flatten
        if hasattr(cols, "levels"):
            flat = [b if str(a).startswith("Unnamed") else f"{a}_{b}" for a, b in cols]
            t.columns = flat
        if "ORtg" in t.columns and "DRtg" in t.columns and "Pace" in t.columns:
            ratings = t
            break

    if ratings is None:
        return None

    # Drop header-repeat rows and the league-average row
    ratings = ratings[pd.to_numeric(ratings["ORtg"], errors="coerce").notna()].copy()

    # Strip playoff markers (* +) from team names
    ratings["Team"] = ratings["Team"].str.replace(r"[*+]", "", regex=True).str.strip()

    ratings["team_code"] = ratings["Team"].map(_BBREF_TO_CODE)
    unmapped = ratings[ratings["team_code"].isna()]["Team"].tolist()
    if unmapped:
        print(f"    WARNING: unmapped teams in {season}: {unmapped}")

    ratings = ratings[ratings["team_code"].notna()].copy()
    ratings["season"] = season
    ratings["ortg"] = pd.to_numeric(ratings["ORtg"], errors="coerce")
    ratings["drtg"] = pd.to_numeric(ratings["DRtg"], errors="coerce")
    ratings["net_rtg"] = pd.to_numeric(ratings.get("NRtg", ratings["ORtg"] - ratings["DRtg"]), errors="coerce")
    ratings["pace"] = pd.to_numeric(ratings["Pace"], errors="coerce")
    ratings["ts_pct"] = pd.to_numeric(ratings.get("TS%", pd.Series(dtype=float)), errors="coerce")

    return ratings[["season", "team_code", "ortg", "drtg", "net_rtg", "pace", "ts_pct"]].dropna(
        subset=["ortg", "drtg", "pace"]
    )


def fetch_season(season: int) -> Optional[pd.DataFrame]:
    url = f"https://www.basketball-reference.com/leagues/NBA_{season}.html"
    try:
        html = _fetch_html(url)
        return _parse_ratings_table(html, season)
    except Exception as e:
        print(f"    ERROR fetching {season}: {e}")
        return None


def run(seasons: range = range(2007, 2027)) -> pd.DataFrame:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    print("=" * 55)
    print("  Fetching NBA team efficiency from Basketball Reference")
    print("=" * 55)

    all_rows: list[pd.DataFrame] = []
    for season in seasons:
        print(f"  Season {season}...", end=" ", flush=True)
        df = fetch_season(season)
        if df is not None and not df.empty:
            all_rows.append(df)
            print(f"{len(df)} teams")
        else:
            print("skipped")
        # Polite rate limit — BBRef blocks aggressive scrapers
        time.sleep(4)

    if not all_rows:
        print("  No data collected. Exiting.")
        sys.exit(1)

    combined = pd.concat(all_rows, ignore_index=True)
    combined.to_csv(OUTPUT_PATH, index=False)
    print(f"\n  Saved {len(combined)} rows → {OUTPUT_PATH}")
    return combined


if __name__ == "__main__":
    run()
