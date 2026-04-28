#!/usr/bin/env python3
"""
fetch_player_availability.py

Builds per-game lineup quality features by tracking whether each team's
key players (top 3 by MPG) actually appeared in each game.

Sources:
  - LeagueDashPlayerStats  → identify top-3 players per team per season
  - PlayerGameLog          → each player's game-by-game appearances

Lineup quality = fraction of expected key-player minutes actually on the floor.
  1.0 = all 3 key players played
  0.6 = star (30 MPG) was out, others (20+20 MPG) played

Output: data/lineup_quality.csv
  date, team_code, lineup_quality_pct, star_absent, key_players_absent

~1,640 API calls total — takes ~20 minutes uncached.
Fully incremental: re-runs skip already-cached data.

Usage:
    python3 -m ml.nba_spread.fetch_player_availability
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import pandas as pd

DATA_DIR    = Path(__file__).resolve().parent / "data"
CACHE_DIR   = DATA_DIR / "_player_cache"
GAMELOG_DIR = DATA_DIR / "_gamelogs_cache"
OUTPUT_PATH = DATA_DIR / "lineup_quality.csv"

# nba_api tri-code → our team code
_ABV_TO_CODE: dict[str, str] = {
    "ATL": "atl", "BOS": "bos", "BKN": "bkn", "CHA": "cha", "CHI": "chi",
    "CLE": "cle", "DAL": "dal", "DEN": "den", "DET": "det", "GSW": "gs",
    "HOU": "hou", "IND": "ind", "LAC": "lac", "LAL": "lal", "MEM": "mem",
    "MIA": "mia", "MIL": "mil", "MIN": "min", "NOP": "no",  "NYK": "ny",
    "OKC": "okc", "ORL": "orl", "PHI": "phi", "PHX": "phx", "POR": "por",
    "SAC": "sac", "SAS": "sa",  "TOR": "tor", "UTA": "utah","WAS": "wsh",
    # Legacy franchises
    "NJN": "bkn", "NOH": "no",  "NOK": "no",  "SEA": "okc", "VAN": "mem",
    "NOJ": "utah",
}


def _season_str(year: int) -> str:
    return f"{year - 1}-{str(year)[2:]}"


def _load_key_players(season: int) -> pd.DataFrame:
    """Top 3 players by MPG per team for this season. Cached."""
    cache = CACHE_DIR / f"key_players_{season}.parquet"
    if cache.exists():
        return pd.read_parquet(cache)

    from nba_api.stats.endpoints import LeagueDashPlayerStats
    time.sleep(0.65)
    try:
        df = LeagueDashPlayerStats(
            season=_season_str(season),
            per_mode_detailed="PerGame",
            measure_type_detailed_defense="Base",
        ).get_data_frames()[0]
    except Exception as e:
        print(f"    WARN LeagueDashPlayerStats {season}: {e}")
        return pd.DataFrame()

    df["MIN"] = pd.to_numeric(df["MIN"], errors="coerce")
    df = df[df["MIN"].notna() & (df["MIN"] > 0)].copy()
    df["team_code"] = df["TEAM_ABBREVIATION"].map(_ABV_TO_CODE)
    df = df[df["team_code"].notna()].copy()

    # Top 3 per team by avg minutes
    top3 = (
        df.sort_values("MIN", ascending=False)
        .groupby("team_code", sort=False)
        .head(3)[["PLAYER_ID", "PLAYER_NAME", "team_code", "MIN"]]
        .copy()
    )
    top3["season"] = season
    top3.to_parquet(cache, index=False)
    return top3


def _load_player_games(player_id: int, season: int) -> set[str]:
    """Set of Game_IDs where this player played >0 minutes. Cached."""
    cache = CACHE_DIR / f"pg_{player_id}_{season}.parquet"
    if cache.exists():
        df = pd.read_parquet(cache)
        return set(df["Game_ID"].astype(str).tolist())

    from nba_api.stats.endpoints import PlayerGameLog
    time.sleep(0.65)
    try:
        gl = PlayerGameLog(
            player_id=str(player_id),
            season=_season_str(season),
        ).get_data_frames()[0]
    except Exception as e:
        print(f"    WARN PlayerGameLog pid={player_id} {season}: {e}")
        return set()

    if gl.empty:
        pd.DataFrame(columns=["Game_ID"]).to_parquet(cache, index=False)
        return set()

    gl["MIN_num"] = pd.to_numeric(gl["MIN"], errors="coerce")
    played = gl[gl["MIN_num"] > 0][["Game_ID"]].copy()
    played.to_parquet(cache, index=False)
    return set(played["Game_ID"].astype(str).tolist())


def _load_team_games(season: int) -> pd.DataFrame:
    """All games for all teams in a season from our cached game logs."""
    frames = []
    for code in _ABV_TO_CODE.values():
        pq = GAMELOG_DIR / f"{code}_{season}.parquet"
        if pq.exists():
            df = pd.read_parquet(pq, columns=["team_code", "season", "Game_ID", "GAME_DATE"])
            frames.append(df)
    if not frames:
        return pd.DataFrame()
    combined = pd.concat(frames).drop_duplicates(subset=["team_code", "Game_ID"])
    combined["GAME_DATE"] = pd.to_datetime(combined["GAME_DATE"])
    return combined


def build_season(season: int) -> pd.DataFrame:
    key_players = _load_key_players(season)
    if key_players.empty:
        return pd.DataFrame()

    team_games = _load_team_games(season)
    if team_games.empty:
        return pd.DataFrame()

    # Pre-fetch all player game logs for this season
    player_game_sets: dict[int, set[str]] = {}
    all_player_ids = key_players["PLAYER_ID"].unique().tolist()
    for pid in all_player_ids:
        player_game_sets[int(pid)] = _load_player_games(int(pid), season)

    rows = []
    for _, game_row in team_games.iterrows():
        team = str(game_row["team_code"])
        game_id = str(game_row["Game_ID"])
        date = game_row["GAME_DATE"]

        team_keys = key_players[key_players["team_code"] == team]
        if team_keys.empty:
            continue

        total_mpg = float(team_keys["MIN"].sum())
        if total_mpg <= 0:
            continue

        present_mpg = 0.0
        star_absent = 0
        players_absent = 0

        for rank, (_, p_row) in enumerate(team_keys.sort_values("MIN", ascending=False).iterrows()):
            pid = int(p_row["PLAYER_ID"])
            mpg = float(p_row["MIN"])
            played = game_id in player_game_sets.get(pid, set())
            if played:
                present_mpg += mpg
            else:
                players_absent += 1
                if rank == 0:
                    star_absent = 1

        rows.append({
            "date": date,
            "team_code": team,
            "lineup_quality_pct": round(present_mpg / total_mpg, 4),
            "star_absent": star_absent,
            "key_players_absent": players_absent,
        })

    return pd.DataFrame(rows)


def run(seasons: range = range(2008, 2027)) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    print("=" * 55)
    print("  Fetching player availability data")
    print(f"  Seasons: {seasons.start}–{seasons.stop - 1}")
    print(f"  Cache: {CACHE_DIR}")
    print("=" * 55)

    all_rows: list[pd.DataFrame] = []
    for season in seasons:
        print(f"\n  Season {season}...", flush=True)
        df = build_season(season)
        if not df.empty:
            all_rows.append(df)
            print(f"    → {len(df):,} team-game rows")
        else:
            print("    → skipped (no data)")

    if not all_rows:
        print("  No data collected.")
        sys.exit(1)

    combined = pd.concat(all_rows, ignore_index=True)
    combined["date"] = pd.to_datetime(combined["date"])
    combined = combined.sort_values(["team_code", "date"]).reset_index(drop=True)

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    combined.to_csv(OUTPUT_PATH, index=False)
    print(f"\n  Saved {len(combined):,} rows → {OUTPUT_PATH}")

    # Quick sanity check
    absent_games = combined[combined["star_absent"] == 1]
    print(f"  Star absences: {len(absent_games):,} ({len(absent_games)/len(combined):.1%} of games)")
    print(f"  Avg lineup quality: {combined['lineup_quality_pct'].mean():.3f}")


if __name__ == "__main__":
    try:
        run()
    except KeyboardInterrupt:
        print("\n  Interrupted — partial cache saved, re-run to resume.")
        sys.exit(0)
    except Exception as e:
        print(f"\n  ERROR: {e}", file=sys.stderr)
        sys.exit(1)
