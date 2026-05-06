#!/usr/bin/env python3
"""
fetch_team_styles.py

Pulls NBA team style and shooting profile data from basketball-reference.com.
Stores results to team_style_stats.csv for use in archetype classification.

Runs weekly (current season) or once for historical backfill.
Two HTML table parses per season: Misc/Advanced stats + Per-Game stats.

Usage:
    python3 -m ml.nba_spread.fetch_team_styles
    python3 -m ml.nba_spread.fetch_team_styles --season 2025-26
    python3 -m ml.nba_spread.fetch_team_styles --backfill --start-year 2010
    python3 -m ml.nba_spread.fetch_team_styles --backfill --start-year 2010 --end-year 2020
"""
from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Optional

import pandas as pd

from .train_spread_model import TEAM_NAME_TO_CODE

DATA_DIR   = Path(__file__).resolve().parent / "data"
STYLE_PATH = DATA_DIR / "team_style_stats.csv"

# basketball-reference table indices (stable across all seasons back to at least 2010)
_PERGAME_TABLE_IDX = 4   # Per-game team stats: Rk, Team, G, FGA, 3PA, 3P%, AST, TOV, PTS ...
_MISC_TABLE_IDX    = 10  # Misc/advanced: ORtg, DRtg, NRtg, Pace, 3PAr, TS%, TOV%, ORB%, DRB%

# Column positions within the misc table (multi-level header → use integer positions)
_MISC_COL = {
    "team":     1,
    "ortg":     10,
    "drtg":     11,
    "net_rtg":  12,
    "pace":     13,
    "fg3a_pct": 15,   # 3PAr: three-point attempt rate (fraction of FGA)
    "ts_pct":   16,
    "efg_pct":  18,   # offense eFG%
    "tov_pct":  19,   # offense TOV%
    "oreb_pct": 20,
    "dreb_pct": 25,
}

# nba_api / bball-ref team suffix → ACE 3-letter code
_SUFFIX_TO_CODE: Dict[str, str] = {
    "hawks": "atl", "celtics": "bos", "nets": "bkn", "hornets": "cha",
    "bulls": "chi", "cavaliers": "cle", "mavericks": "dal", "nuggets": "den",
    "pistons": "det", "warriors": "gs", "rockets": "hou", "pacers": "ind",
    "clippers": "lac", "lakers": "lal", "grizzlies": "mem", "heat": "mia",
    "bucks": "mil", "timberwolves": "min", "pelicans": "no", "knicks": "ny",
    "thunder": "okc", "magic": "orl", "76ers": "phi", "suns": "phx",
    "trail blazers": "por", "kings": "sac", "spurs": "sa", "raptors": "tor",
    "jazz": "utah", "wizards": "wsh",
    # Historical names (relocated/renamed teams)
    "bobcats": "cha",          # Charlotte Bobcats → Hornets
    "supersonics": "okc",      # Seattle SuperSonics → Thunder
    "new jersey nets": "bkn",  # full name match for NJ era
}


def _resolve_team(name: str) -> Optional[str]:
    """Map a bball-ref team name to our 3-letter code."""
    clean = name.rstrip("*").strip()
    if clean in TEAM_NAME_TO_CODE:
        return TEAM_NAME_TO_CODE[clean]
    lower = clean.lower()
    # Try full name first (e.g. "new jersey nets")
    if lower in _SUFFIX_TO_CODE:
        return _SUFFIX_TO_CODE[lower]
    # Suffix match
    for suffix, code in _SUFFIX_TO_CODE.items():
        if lower.endswith(suffix):
            return code
    return None


def _bball_ref_year(season: str) -> int:
    """'2025-26' → 2026"""
    return int(season.split("-")[0]) + 1


def _season_from_year(year: int) -> str:
    """2026 → '2025-26'"""
    return f"{year - 1}-{str(year)[2:]}"


def _current_season() -> str:
    now = datetime.now(timezone.utc)
    year = now.year
    if now.month < 10:
        return f"{year - 1}-{str(year)[2:]}"
    return f"{year}-{str(year + 1)[2:]}"


def _fetch_from_bballref(bball_ref_year: int) -> pd.DataFrame:
    """
    Scrape per-game + misc stats from basketball-reference for one season.
    Returns DataFrame with columns matching team_style_stats.csv schema.
    """
    url = f"https://www.basketball-reference.com/leagues/NBA_{bball_ref_year}.html"
    tables = pd.read_html(url, header=0)

    # ── Per-game table ─────────────────────────────────────────────────────────
    pg = tables[_PERGAME_TABLE_IDX].copy()
    pg = pg[
        pg["Rk"].notna() & (pg["Rk"] != "Rk") & (pg["Team"] != "League Average")
    ].copy()
    pg["team_name"] = pg["Team"].str.rstrip("*").str.strip()
    pg = pg.rename(columns={
        "G":   "gp",
        "FGA": "fga",
        "3PA": "fg3a",
        "3P%": "fg3_pct",
        "AST": "ast_per_game",
        "TOV": "tov_per_game",
        "PTS": "pts_per_game",
    })
    for col in ["gp", "fga", "fg3a", "fg3_pct", "ast_per_game", "tov_per_game", "pts_per_game"]:
        pg[col] = pd.to_numeric(pg[col], errors="coerce")

    pg["fg3a_pct"] = (pg["fg3a"] / pg["fga"].replace(0, float("nan"))).round(4)
    # AST per FGA: ball-movement proxy for percentile ranking
    pg["ast_pct"]  = (pg["ast_per_game"] / pg["fga"].replace(0, float("nan"))).round(4)
    pg["ast_to_ratio"] = (
        pg["ast_per_game"] / pg["tov_per_game"].replace(0, float("nan"))
    ).round(3)

    pg = pg[["team_name", "gp", "fga", "fg3a", "fg3a_pct", "fg3_pct",
             "ast_per_game", "ast_pct", "ast_to_ratio", "tov_per_game", "pts_per_game"]]

    # ── Misc/advanced table ────────────────────────────────────────────────────
    raw = tables[_MISC_TABLE_IDX].copy()
    # Row 0 holds the real header labels; use positional extraction to avoid
    # duplicate-column-name issues (eFG%, TOV% appear for both offense & defense)
    header_row = raw.iloc[0].tolist()
    data_rows  = raw.iloc[1:].copy()
    data_rows.columns = range(len(data_rows.columns))  # integer column access

    data_rows = data_rows[
        data_rows[_MISC_COL["team"]].notna() &
        (data_rows[_MISC_COL["team"]] != "League Average") &
        (data_rows[0] != "Rk")
    ].copy()

    misc = pd.DataFrame({
        "team_name": data_rows[_MISC_COL["team"]].str.rstrip("*").str.strip(),
        "ortg":      pd.to_numeric(data_rows[_MISC_COL["ortg"]],     errors="coerce"),
        "drtg":      pd.to_numeric(data_rows[_MISC_COL["drtg"]],     errors="coerce"),
        "net_rtg":   pd.to_numeric(data_rows[_MISC_COL["net_rtg"]],  errors="coerce"),
        "pace":      pd.to_numeric(data_rows[_MISC_COL["pace"]],     errors="coerce"),
        "ts_pct":    pd.to_numeric(data_rows[_MISC_COL["ts_pct"]],   errors="coerce"),
        "efg_pct":   pd.to_numeric(data_rows[_MISC_COL["efg_pct"]],  errors="coerce"),
        "tov_pct":   pd.to_numeric(data_rows[_MISC_COL["tov_pct"]],  errors="coerce"),
        "oreb_pct":  pd.to_numeric(data_rows[_MISC_COL["oreb_pct"]], errors="coerce"),
        "dreb_pct":  pd.to_numeric(data_rows[_MISC_COL["dreb_pct"]], errors="coerce"),
    })

    # ── Merge ──────────────────────────────────────────────────────────────────
    df = misc.merge(pg, on="team_name", how="outer")
    return df


def fetch_and_save(season: str) -> pd.DataFrame:
    """
    Fetch style data for one season, resolve team codes, append/replace in CSV.
    Returns the new rows DataFrame.
    """
    year = _bball_ref_year(season)
    print(f"  Fetching NBA_{year} ({season}) from basketball-reference...")
    df = _fetch_from_bballref(year)

    df["team_code"] = df["team_name"].apply(_resolve_team)
    unresolved = df[df["team_code"].isna()]["team_name"].tolist()
    if unresolved:
        print(f"    Warning: could not resolve team codes for: {unresolved}")
    df = df.dropna(subset=["team_code"])

    df["season"]      = season
    df["season_type"] = "regular_season"
    df["fetched_at"]  = datetime.now(timezone.utc).isoformat()

    meta_cols  = ["team_code", "team_name", "season", "season_type", "fetched_at", "gp"]
    style_cols = [c for c in df.columns if c not in meta_cols]
    df = df[meta_cols + style_cols]

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if STYLE_PATH.exists():
        existing = pd.read_csv(STYLE_PATH)
        mask = ~(
            (existing["team_code"].isin(df["team_code"])) &
            (existing["season"] == season) &
            (existing["season_type"] == "regular_season")
        )
        combined = pd.concat([existing[mask], df], ignore_index=True)
    else:
        combined = df

    combined.to_csv(STYLE_PATH, index=False)
    print(f"    Saved {len(df)} teams  (CSV total rows: {len(combined)})")
    return df


def backfill(start_year: int = 2010, end_year: Optional[int] = None) -> None:
    """Fetch and save style stats for every season from start_year to end_year."""
    if end_year is None:
        end_year = _bball_ref_year(_current_season())
    print(f"  Backfilling NBA styles: {_season_from_year(start_year)} → {_season_from_year(end_year)}")
    for year in range(start_year, end_year + 1):
        season = _season_from_year(year)
        try:
            fetch_and_save(season)
        except Exception as e:
            print(f"    Skipping NBA_{year}: {e}")
        if year < end_year:
            time.sleep(3)  # polite crawl rate for bball-ref


def run(season: Optional[str] = None) -> None:
    if season is None:
        season = _current_season()

    print("=" * 55)
    print("  ACE — Fetch Team Style Stats (bball-ref)")
    print(f"  Season: {season}")
    print("=" * 55)

    df = fetch_and_save(season)

    print()
    print("  Style snapshot (top 5 by pace):")
    sample_cols = ["team_code", "pace", "fg3a_pct", "ast_pct", "ortg", "drtg"]
    available = [c for c in sample_cols if c in df.columns]
    top = df.nlargest(5, "pace")[available] if "pace" in df.columns else df.head(5)[available]
    for _, row in top.iterrows():
        parts = [
            f"{c}={row[c]:.3f}" if isinstance(row[c], float) else f"{c}={row[c]}"
            for c in available[1:] if not pd.isna(row.get(c, float("nan")))
        ]
        print(f"    {row['team_code']:<6}  {' '.join(parts)}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--season", default=None,
                        help="NBA season string, e.g. 2025-26 (default: current)")
    parser.add_argument("--backfill", action="store_true",
                        help="Fetch all seasons from --start-year to current")
    parser.add_argument("--start-year", type=int, default=2010,
                        help="bball-ref end year to start backfill from (default: 2010)")
    parser.add_argument("--end-year", type=int, default=None,
                        help="bball-ref end year to stop at (default: current season)")
    args = parser.parse_args()

    try:
        if args.backfill:
            backfill(start_year=args.start_year, end_year=args.end_year)
        else:
            run(season=args.season)
    except Exception as e:
        print(f"\n  ERROR: {e}", file=sys.stderr)
        sys.exit(1)
