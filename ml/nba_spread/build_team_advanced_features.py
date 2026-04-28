#!/usr/bin/env python3
"""
build_team_advanced_features.py

Builds three feature sets from data we already have — no new API calls:

1. Q4 / clutch features  (from training CSV)
   - Rolling Q4 margin, Q4 cover rate per team

2. Home/away split efficiency  (from game log cache)
   - Separate rolling ortg/drtg for home-only and away-only games

3. Travel burden  (from game log sequence + arena coordinates)
   - Miles traveled to current game, road trip length, time zones crossed

Outputs:
   data/q4_features.csv          — keyed by (date, team_code)
   data/home_away_splits.csv     — keyed by (date, team_code)
   data/travel_features.csv      — keyed by (date, team_code)

Usage:
    python3 -m ml.nba_spread.build_team_advanced_features [--csv PATH]
"""
from __future__ import annotations

import argparse
import math
from pathlib import Path

import numpy as np
import pandas as pd

DATA_DIR = Path(__file__).resolve().parent / "data"
CACHE_DIR = DATA_DIR / "_gamelogs_cache"

# ── Arena coordinates (lat, lng) ──────────────────────────────────────────────
_ARENA: dict[str, tuple[float, float]] = {
    "atl": (33.757, -84.396),  "bos": (42.366, -71.062),
    "bkn": (40.683, -73.975),  "cha": (35.225, -80.839),
    "chi": (41.881, -87.674),  "cle": (41.497, -81.688),
    "dal": (32.790, -97.093),  "den": (39.748, -104.990),
    "det": (42.341, -83.055),  "gs":  (37.768, -122.388),
    "hou": (29.751, -95.362),  "ind": (39.764, -86.156),
    "lac": (34.043, -118.267), "lal": (34.043, -118.267),
    "mem": (35.138, -90.051),  "mia": (25.781, -80.188),
    "mil": (43.044, -87.917),  "min": (44.980, -93.276),
    "no":  (29.949, -90.082),  "ny":  (40.751, -73.994),
    "okc": (35.463, -97.515),  "orl": (28.539, -81.384),
    "phi": (39.901, -75.172),  "phx": (33.446, -112.071),
    "por": (45.532, -122.667), "sac": (38.581, -121.500),
    "sa":  (29.427, -98.438),  "tor": (43.643, -79.379),
    "utah":(40.768, -111.901), "wsh": (38.898, -77.021),
}

# UTC offsets (standard time — not accounting for DST; good enough for delta)
_TZ_OFFSET: dict[str, int] = {
    "atl": -5, "bos": -5, "bkn": -5, "cha": -5, "cle": -5,
    "det": -5, "ind": -5, "mia": -5, "ny":  -5, "orl": -5,
    "phi": -5, "tor": -5, "wsh": -5,
    "chi": -6, "dal": -6, "hou": -6, "mem": -6,
    "mil": -6, "min": -6, "no":  -6, "okc": -6, "sa":  -6,
    "den": -7, "utah": -7, "phx": -7,
    "gs":  -8, "lac": -8, "lal": -8, "por": -8, "sac": -8,
}


def _haversine_miles(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    R = 3958.8
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlng / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))


# ── 1. Q4 / clutch features ────────────────────────────────────────────────────

def build_q4_features(csv_path: Path) -> pd.DataFrame:
    df = pd.read_csv(csv_path)
    df["date"] = pd.to_datetime(df["date"])
    df = df.sort_values("date").reset_index(drop=True)

    # Derive home_line so we can check Q4 cover
    df["home_line"] = np.where(df["whos_favored"].eq("home"), -df["spread"], df["spread"])
    df["q4_margin_home"] = df["q4_home"] - df["q4_away"]

    rows = []
    for perspective in ("home", "away"):
        is_home = perspective == "home"
        sub = df[["date", "home", "away", "q4_margin_home"]].copy()
        sub["team_code"] = sub["home"] if is_home else sub["away"]
        sub["q4_margin"] = sub["q4_margin_home"] if is_home else -sub["q4_margin_home"]
        rows.append(sub[["date", "team_code", "q4_margin"]])

    long = pd.concat(rows).sort_values(["team_code", "date"]).reset_index(drop=True)
    grp = long.groupby("team_code", sort=False)

    long["q4_margin_avg5"]  = grp["q4_margin"].transform(lambda s: s.shift(1).rolling(5,  min_periods=1).mean()).round(3)
    long["q4_margin_avg10"] = grp["q4_margin"].transform(lambda s: s.shift(1).rolling(10, min_periods=1).mean()).round(3)
    long["q4_cover_rate5"]  = grp["q4_margin"].transform(lambda s: (s.shift(1) > 0).rolling(5, min_periods=1).mean()).round(3)

    out = long[["date", "team_code", "q4_margin_avg5", "q4_margin_avg10", "q4_cover_rate5"]]
    path = DATA_DIR / "q4_features.csv"
    out.to_csv(path, index=False)
    print(f"  Q4 features: {len(out):,} rows → {path}")
    return out


# ── 2. Home/away split efficiency ─────────────────────────────────────────────

def build_home_away_splits() -> pd.DataFrame:
    if not CACHE_DIR.exists():
        print("  WARNING: game log cache missing — run fetch_game_efficiency first")
        return pd.DataFrame()

    frames = []
    for pq in sorted(CACHE_DIR.glob("*.parquet")):
        df = pd.read_parquet(pq)
        df["is_home"] = df["MATCHUP"].str.contains("vs\.")
        df["possessions"] = (df["FGA"] - df["OREB"] + df["TOV"] + 0.44 * df["FTA"]).clip(lower=1)
        df["ortg_game"] = (df["PTS"] / df["possessions"] * 100).round(2)
        df["ts_game"] = (df["PTS"] / (2 * (df["FGA"] + 0.44 * df["FTA"]))).clip(0, 1).round(4)
        df["GAME_DATE"] = pd.to_datetime(df["GAME_DATE"])
        frames.append(df[["team_code", "season", "GAME_DATE", "is_home", "ortg_game", "ts_game", "possessions"]])

    raw = pd.concat(frames).sort_values(["team_code", "GAME_DATE"]).reset_index(drop=True)

    # We also need drtg — merge opponent stats by Game_ID
    # For splits, just use ortg for now (drtg needs the opponent row)
    # Build separate rolling windows for home games only and away games only
    out_rows = []
    for team, grp_df in raw.groupby("team_code", sort=False):
        grp_df = grp_df.sort_values("GAME_DATE").reset_index(drop=True)
        home_games = grp_df[grp_df["is_home"]].copy()
        away_games = grp_df[~grp_df["is_home"]].copy()

        for venue_df, suffix in [(home_games, "home"), (away_games, "away")]:
            if venue_df.empty:
                continue
            venue_df = venue_df.copy()
            venue_df[f"ortg_{suffix}_avg5"] = venue_df["ortg_game"].shift(1).rolling(5, min_periods=1).mean().round(3)
            venue_df[f"ts_{suffix}_avg5"]   = venue_df["ts_game"].shift(1).rolling(5, min_periods=1).mean().round(4)
            out_rows.append(venue_df[["team_code", "GAME_DATE", f"ortg_{suffix}_avg5", f"ts_{suffix}_avg5"]])

    if not out_rows:
        return pd.DataFrame()

    splits = pd.concat(out_rows).rename(columns={"GAME_DATE": "date"})
    # Pivot so we have one row per (team, date) with both home and away columns
    splits = splits.groupby(["team_code", "date"]).first().reset_index()

    path = DATA_DIR / "home_away_splits.csv"
    splits.to_csv(path, index=False)
    print(f"  Home/away splits: {len(splits):,} rows → {path}")
    return splits


# ── 3. Travel burden ──────────────────────────────────────────────────────────

def build_travel_features() -> pd.DataFrame:
    if not CACHE_DIR.exists():
        print("  WARNING: game log cache missing — run fetch_game_efficiency first")
        return pd.DataFrame()

    frames = []
    for pq in sorted(CACHE_DIR.glob("*.parquet")):
        df = pd.read_parquet(pq)
        df["is_home"] = df["MATCHUP"].str.contains("vs\.")
        df["GAME_DATE"] = pd.to_datetime(df["GAME_DATE"])
        frames.append(df[["team_code", "season", "Game_ID", "GAME_DATE", "is_home"]])

    raw = pd.concat(frames).sort_values(["team_code", "GAME_DATE"]).reset_index(drop=True)

    # For away games, we need to know WHERE they played — opponent's arena
    # Parse opponent code from Game_ID by cross-referencing home team games on same date
    # Simpler: opponent abbreviation from MATCHUP ("BOS @ ORL" → opponent is ORL)
    # Re-read with MATCHUP
    frames2 = []
    for pq in sorted(CACHE_DIR.glob("*.parquet")):
        df = pd.read_parquet(pq)
        df["is_home"] = df["MATCHUP"].str.contains("vs\.")
        df["GAME_DATE"] = pd.to_datetime(df["GAME_DATE"])
        # Extract opponent tri-code from MATCHUP
        def _opp(row: pd.Series) -> str:
            parts = str(row["MATCHUP"]).replace("vs.", "").replace("@", "").split()
            for p in parts:
                if p.lower() != row["team_code"]:
                    return p.lower()
            return ""
        df["opp_abbr"] = df.apply(_opp, axis=1)
        frames2.append(df[["team_code", "Game_ID", "GAME_DATE", "is_home", "opp_abbr"]])

    raw = pd.concat(frames2).sort_values(["team_code", "GAME_DATE"]).reset_index(drop=True)

    # Build arena code lookup: nba_api tri-code → our team code
    # Use reverse mapping: when home, team_code IS the arena code
    # For away, arena is the opponent's home
    def _game_location(row: pd.Series) -> str:
        if row["is_home"]:
            return row["team_code"]
        # Map opponent tri-code (3-letter abbr from nba_api) to our code
        return _TRI_TO_CODE.get(row["opp_abbr"], "")

    # nba_api tri-codes → our codes
    _TRI_TO_CODE: dict[str, str] = {
        "atl": "atl", "bos": "bos", "bkn": "bkn", "cha": "cha", "chi": "chi",
        "cle": "cle", "dal": "dal", "den": "den", "det": "det", "gsw": "gs",
        "hou": "hou", "ind": "ind", "lac": "lac", "lal": "lal", "mem": "mem",
        "mia": "mia", "mil": "mil", "min": "min", "nop": "no",  "nyk": "ny",
        "okc": "okc", "orl": "orl", "phi": "phi", "phx": "phx", "por": "por",
        "sac": "sac", "sas": "sa",  "tor": "tor", "uta": "utah","was": "wsh",
        # legacy
        "njn": "bkn", "noh": "no", "noo": "no", "sea": "okc", "vck": "okc",
    }

    raw["location"] = raw.apply(_game_location, axis=1)

    travel_rows = []
    for team, grp_df in raw.groupby("team_code", sort=False):
        grp_df = grp_df.sort_values("GAME_DATE").reset_index(drop=True)
        own_arena = team
        own_coords = _ARENA.get(own_arena, (0, 0))
        own_tz = _TZ_OFFSET.get(own_arena, -6)

        last_loc = own_arena  # start of season: team is home
        road_trip = 0

        for idx, row in grp_df.iterrows():
            cur_loc = row["location"] if row["location"] in _ARENA else own_arena
            cur_coords = _ARENA.get(cur_loc, own_coords)
            last_coords = _ARENA.get(last_loc, own_coords)

            miles = round(_haversine_miles(*last_coords, *cur_coords))
            cur_tz = _TZ_OFFSET.get(cur_loc, own_tz)
            last_tz = _TZ_OFFSET.get(last_loc, own_tz)
            tz_delta = abs(cur_tz - last_tz)

            if row["is_home"]:
                road_trip = 0
            else:
                road_trip += 1

            travel_rows.append({
                "team_code": team,
                "date": row["GAME_DATE"],
                "miles_traveled": miles,
                "tz_delta": tz_delta,
                "road_trip_games": road_trip,
            })
            last_loc = cur_loc

    travel = pd.DataFrame(travel_rows)
    path = DATA_DIR / "travel_features.csv"
    travel.to_csv(path, index=False)
    print(f"  Travel features: {len(travel):,} rows → {path}")
    return travel


# ── Main ───────────────────────────────────────────────────────────────────────

def run(csv_path: Path) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    print("=" * 55)
    print("  Building advanced team features")
    print("=" * 55)
    build_q4_features(csv_path)
    build_home_away_splits()
    build_travel_features()
    print("\n  Done.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", required=True, help="Path to nba_2008-2025.csv")
    args = parser.parse_args()
    run(Path(args.csv).expanduser().resolve())
