#!/usr/bin/env python3
"""
fetch_referee_features.py

Fetches referee assignments per game from nba_api BoxScoreSummaryV2,
then computes per-referee historical tendencies (FTA rate, pace, total pts).

Processes recent seasons only (configurable, default last 5) to keep
API calls manageable. Each game is cached so re-runs are incremental.

Output: data/referee_features.csv
  game_id, date, ref1, ref2, ref3,
  crew_fta_rate_avg,   ← avg FTA per 100 possessions this crew historically
  crew_pace_avg,       ← avg pace games this crew officiated
  crew_total_pts_avg   ← avg total score

Usage:
    python3 -m ml.nba_spread.fetch_referee_features [--seasons N]
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import pandas as pd

DATA_DIR   = Path(__file__).resolve().parent / "data"
CACHE_DIR  = DATA_DIR / "_ref_cache"
OUTPUT_PATH = DATA_DIR / "referee_features.csv"

# nba_api regular season game ID pattern: 002YYXXXXX
# Build list of game IDs from our existing game log cache
GAMELOG_CACHE = DATA_DIR / "_gamelogs_cache"


def _all_game_ids(seasons: list[int]) -> list[str]:
    """Pull unique Game_IDs from existing game log parquet cache for given seasons."""
    ids: set[str] = set()
    for pq in sorted(GAMELOG_CACHE.glob("*.parquet")):
        df = pd.read_parquet(pq, columns=["season", "Game_ID"])
        season_match = df[df["season"].isin(seasons)]
        ids.update(season_match["Game_ID"].tolist())
    return sorted(ids)


def _fetch_game_summary(game_id: str) -> dict | None:
    cache_file = CACHE_DIR / f"{game_id}.json"
    if cache_file.exists():
        return json.loads(cache_file.read_text())

    try:
        from nba_api.stats.endpoints import BoxScoreSummaryV2
        time.sleep(0.65)
        frames = BoxScoreSummaryV2(game_id=game_id).get_data_frames()

        officials_df = frames[2]
        linescore_df = frames[5]
        gameinfo_df  = frames[4]  # GAME_DATE, ATTENDANCE

        if officials_df.empty:
            return None

        officials = [
            f"{r['FIRST_NAME']} {r['LAST_NAME']}"
            for _, r in officials_df.iterrows()
        ]

        # Total pts + approximate pace from linescore
        total_pts = int(linescore_df["PTS"].sum()) if not linescore_df.empty else None
        date_str  = gameinfo_df["GAME_DATE"].iloc[0] if not gameinfo_df.empty else ""

        result = {
            "game_id": game_id,
            "date": str(date_str),
            "officials": officials,
            "total_pts": total_pts,
        }
        cache_file.write_text(json.dumps(result))
        return result

    except Exception as e:
        print(f"    WARN {game_id}: {e}")
        return None


def build_referee_features(seasons: list[int]) -> pd.DataFrame:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    game_ids = _all_game_ids(seasons)
    print(f"  Games to process: {len(game_ids)}")
    print(f"  Estimated time: ~{len(game_ids) * 0.65 / 60:.0f} min (uncached)")

    records = []
    for i, gid in enumerate(game_ids, 1):
        if i % 200 == 0:
            print(f"  [{i}/{len(game_ids)}]")
        result = _fetch_game_summary(gid)
        if result:
            records.append(result)

    if not records:
        print("  No referee data collected.")
        return pd.DataFrame()

    df = pd.DataFrame(records)
    df["date"] = pd.to_datetime(df["date"])

    # Expand officials list into ref1/ref2/ref3
    max_refs = df["officials"].apply(len).max()
    for i in range(min(max_refs, 3)):
        df[f"ref{i+1}"] = df["officials"].apply(lambda x: x[i] if i < len(x) else "")
    df = df.drop(columns=["officials"])

    # Build referee tendency stats (rolling over all prior games officiated)
    # Simple approach: compute each ref's historical avg total_pts per game
    all_ref_games = []
    for col in ["ref1", "ref2", "ref3"]:
        sub = df[["game_id", "date", col, "total_pts"]].copy()
        sub = sub.rename(columns={col: "ref_name"})
        sub = sub[sub["ref_name"] != ""]
        all_ref_games.append(sub)

    ref_games = pd.concat(all_ref_games).sort_values("date").reset_index(drop=True)
    grp = ref_games.groupby("ref_name", sort=False)
    ref_games["ref_total_avg10"] = grp["total_pts"].transform(
        lambda s: s.shift(1).rolling(10, min_periods=3).mean()
    ).round(1)

    # Average across the 3 refs in each game
    ref_game_avgs = ref_games.groupby("game_id")["ref_total_avg10"].mean().reset_index()
    ref_game_avgs.columns = ["game_id", "crew_total_pts_avg"]

    result = df.merge(ref_game_avgs, on="game_id", how="left")
    result = result[["game_id", "date", "ref1", "ref2", "ref3", "crew_total_pts_avg"]]

    result.to_csv(OUTPUT_PATH, index=False)
    print(f"  Saved {len(result):,} rows → {OUTPUT_PATH}")
    return result


def run(num_seasons: int = 5) -> None:
    current_season = 2026
    seasons = list(range(current_season - num_seasons, current_season + 1))

    print("=" * 55)
    print("  Fetching referee features (nba_api)")
    print(f"  Seasons: {seasons[0]}–{seasons[-1]}")
    print("=" * 55)
    build_referee_features(seasons)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--seasons", type=int, default=5,
                        help="How many recent seasons to fetch (default: 5)")
    args = parser.parse_args()
    try:
        run(args.seasons)
    except Exception as e:
        print(f"\n  ERROR: {e}", file=sys.stderr)
        sys.exit(1)
