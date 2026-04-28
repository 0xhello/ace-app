#!/usr/bin/env python3
"""
fetch_game_efficiency.py

Fetches per-game box score stats (FGA, FTA, OREB, TOV, PTS) for every team
for seasons 2007-2026 via nba_api, then computes per-game offensive/defensive
efficiency and pace in rolling windows.

Output: ml/nba_spread/data/team_game_efficiency.csv
  season, date, team_code, game_id,
  ortg, drtg, ts_pct,           ← single-game values
  ortg_avg5, drtg_avg5, ts_avg5, pace_avg5,   ← rolling 5-game (pre-shifted)
  ortg_avg10, drtg_avg10        ← rolling 10-game

Usage:
    python3 -m ml.nba_spread.fetch_game_efficiency

Safe to re-run — skips seasons already cached.
~10-15 min for full historical pull (rate limited to respect NBA API).
"""
from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Optional

import pandas as pd

from .train_spread_model import TEAM_NAME_TO_CODE

DATA_DIR = Path(__file__).resolve().parent / "data"
CACHE_DIR = DATA_DIR / "_gamelogs_cache"
OUTPUT_PATH = DATA_DIR / "team_game_efficiency.csv"

# nba_api season string format: "2024-25"
def _season_str(season_end_year: int) -> str:
    return f"{season_end_year - 1}-{str(season_end_year)[2:]}"


# Map nba_api full team names to our 3-letter codes (union of all known variants)
_NBA_API_TO_CODE: dict[str, str] = {
    **TEAM_NAME_TO_CODE,
    # Variants nba_api uses that differ from our TEAM_NAME_TO_CODE
    "LA Clippers": "lac",
    "New Orleans/Oklahoma City Hornets": "no",
    "Seattle SuperSonics": "okc",
    "New Jersey Nets": "bkn",
    "Charlotte Bobcats": "cha",
    "Washington Bullets": "wsh",
}

# nba_api numeric team IDs (static — these don't change)
_TEAM_IDS: dict[str, int] = {
    "atl": 1610612737, "bos": 1610612738, "bkn": 1610612751,
    "cha": 1610612766, "chi": 1610612741, "cle": 1610612739,
    "dal": 1610612742, "den": 1610612743, "det": 1610612765,
    "gs":  1610612744, "hou": 1610612745, "ind": 1610612754,
    "lac": 1610612746, "lal": 1610612747, "mem": 1610612763,
    "mia": 1610612748, "mil": 1610612749, "min": 1610612750,
    "no":  1610612740, "ny":  1610612752, "okc": 1610612760,
    "orl": 1610612753, "phi": 1610612755, "phx": 1610612756,
    "por": 1610612757, "sac": 1610612758, "sa":  1610612759,
    "tor": 1610612761, "utah":1610612762, "wsh": 1610612764,
}


def _possessions(row: pd.Series) -> float:
    """Dean Oliver possession estimate."""
    return float(row["FGA"] - row["OREB"] + row["TOV"] + 0.44 * row["FTA"])


def _fetch_team_season(team_code: str, season: int, retries: int = 3) -> Optional[pd.DataFrame]:
    from nba_api.stats.endpoints import TeamGameLog
    team_id = _TEAM_IDS.get(team_code)
    if team_id is None:
        return None
    season_str = _season_str(season)
    for attempt in range(retries):
        try:
            time.sleep(0.65)  # NBA API rate limit
            gl = TeamGameLog(
                team_id=team_id,
                season=season_str,
                season_type_all_star="Regular Season",
            ).get_data_frames()[0]
            if gl.empty:
                return None
            gl["team_code"] = team_code
            gl["season"] = season
            return gl[["team_code", "season", "Game_ID", "GAME_DATE", "MATCHUP",
                        "PTS", "FGA", "FG3A", "FTA", "OREB", "TOV"]]
        except Exception as e:
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
            else:
                print(f"    FAILED {team_code} {season}: {e}")
    return None


def _load_or_fetch(team_code: str, season: int) -> Optional[pd.DataFrame]:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file = CACHE_DIR / f"{team_code}_{season}.parquet"
    if cache_file.exists():
        return pd.read_parquet(cache_file)
    df = _fetch_team_season(team_code, season)
    if df is not None and not df.empty:
        df.to_parquet(cache_file, index=False)
    return df


def build_game_efficiency(seasons: range = range(2008, 2027)) -> pd.DataFrame:
    """
    Fetch all team game logs, compute per-game efficiency, merge home+away
    by game_id to get ortg AND drtg per team per game.
    """
    all_logs: list[pd.DataFrame] = []
    total = len(_TEAM_IDS) * len(seasons)
    done = 0

    for season in seasons:
        for team_code in sorted(_TEAM_IDS):
            done += 1
            print(f"\r  [{done}/{total}] {team_code} {season}    ", end="", flush=True)
            df = _load_or_fetch(team_code, season)
            if df is not None and not df.empty:
                all_logs.append(df)

    print()
    if not all_logs:
        raise RuntimeError("No game logs fetched.")

    raw = pd.concat(all_logs, ignore_index=True)
    raw["GAME_DATE"] = pd.to_datetime(raw["GAME_DATE"])
    raw["possessions"] = raw.apply(_possessions, axis=1).clip(lower=1)
    raw["ortg_game"] = (raw["PTS"] / raw["possessions"] * 100).round(2)
    raw["ts_pct_game"] = (raw["PTS"] / (2 * (raw["FGA"] + 0.44 * raw["FTA"]))).round(4)
    raw["ts_pct_game"] = raw["ts_pct_game"].clip(0, 1)

    # Parse opponent team code from MATCHUP ("BOS vs. CHA" or "BOS @ CHA")
    def _opp_code(matchup: str, own_code: str) -> Optional[str]:
        parts = str(matchup).replace("vs.", "").replace("@", "").split()
        for p in parts:
            p = p.strip().lower()
            # Our codes are 2-4 chars; MATCHUP uses abbreviated tri-codes
            # Map via a fuzzy lookup on suffix
            for code in _TEAM_IDS:
                if p == code or (len(p) == 3 and any(
                    name.lower().endswith(p) or name.lower().split()[-1].lower()[:3] == p
                    for name in [code]
                )):
                    if code != own_code:
                        return code
        return None

    # Merge same game for home+away teams to compute drtg
    # drtg of team A in game G = ortg of team B in game G
    game_ortg = raw[["Game_ID", "season", "team_code", "GAME_DATE", "ortg_game",
                      "ts_pct_game", "possessions"]].copy()

    merged = game_ortg.merge(
        game_ortg[["Game_ID", "team_code", "ortg_game", "possessions"]].rename(
            columns={"team_code": "opp_code", "ortg_game": "drtg_game",
                     "possessions": "opp_possessions"}),
        on="Game_ID",
    )
    # Each row is (team, game) — keep only rows where opp_code != team_code
    merged = merged[merged["team_code"] != merged["opp_code"]].copy()
    # pace: total possessions / game minutes * 48 — approximate with both teams' possessions
    merged["pace_game"] = ((merged["possessions"] + merged["opp_possessions"]) / 2).round(1)

    # Sort chronologically per team, then build rolling windows
    merged = merged.sort_values(["team_code", "season", "GAME_DATE", "Game_ID"])
    grp = merged.groupby("team_code", sort=False)

    # shift(1) ensures we only use PAST games — no same-game leakage
    for stat, out5, out10 in [
        ("ortg_game", "ortg_avg5", "ortg_avg10"),
        ("drtg_game", "drtg_avg5", "drtg_avg10"),
        ("ts_pct_game", "ts_avg5", "ts_avg10"),
        ("pace_game", "pace_avg5", "pace_avg10"),
    ]:
        s = grp[stat]
        merged[out5] = s.transform(lambda x: x.shift(1).rolling(5, min_periods=1).mean()).round(3)
        merged[out10] = s.transform(lambda x: x.shift(1).rolling(10, min_periods=1).mean()).round(3)

    merged = merged.rename(columns={
        "GAME_DATE": "date",
        "Game_ID": "nba_game_id",
    })

    out_cols = ["season", "date", "team_code", "nba_game_id",
                "ortg_game", "drtg_game", "pace_game", "ts_pct_game",
                "ortg_avg5", "drtg_avg5", "pace_avg5", "ts_avg5",
                "ortg_avg10", "drtg_avg10"]
    final = merged[out_cols].drop_duplicates(subset=["nba_game_id", "team_code"])

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    final.to_csv(OUTPUT_PATH, index=False)
    print(f"  Saved {len(final):,} rows → {OUTPUT_PATH}")
    return final


def fetch_playoff_efficiency(season: int = 2026) -> None:
    """
    Fetch playoff game logs, compute per-game efficiency with rolling windows
    that extend from the regular season, and append new rows to the CSV.
    Idempotent: rows already in the CSV are skipped.
    """
    from nba_api.stats.endpoints import TeamGameLog

    if not OUTPUT_PATH.exists():
        print("  team_game_efficiency.csv not found — run full fetch first")
        return

    existing = pd.read_csv(OUTPUT_PATH, parse_dates=["date"])
    existing_ids = set(existing["nba_game_id"].astype(str).tolist())
    season_str = _season_str(season)
    print(f"  Fetching playoff logs: {season_str}  ({len(_TEAM_IDS)} teams)")

    # Step 1: collect raw playoff box scores per team
    raw_playoff: list[pd.DataFrame] = []
    for team_code in sorted(_TEAM_IDS):
        team_id = _TEAM_IDS[team_code]
        try:
            time.sleep(0.65)
            gl = TeamGameLog(
                team_id=team_id,
                season=season_str,
                season_type_all_star="Playoffs",
            ).get_data_frames()[0]
        except Exception as e:
            print(f"    WARN {team_code}: {e}")
            continue
        if gl.empty:
            continue
        gl["team_code"] = team_code
        gl["season"] = season
        gl = gl[["team_code", "season", "Game_ID", "GAME_DATE", "MATCHUP",
                  "PTS", "FGA", "FG3A", "FTA", "OREB", "TOV"]]
        new_rows = gl[~gl["Game_ID"].astype(str).isin(existing_ids)]
        if not new_rows.empty:
            raw_playoff.append(new_rows)

    if not raw_playoff:
        print("  No new playoff games to add.")
        return

    raw = pd.concat(raw_playoff, ignore_index=True)
    raw["GAME_DATE"] = pd.to_datetime(raw["GAME_DATE"])
    raw["Game_ID"] = raw["Game_ID"].astype(str)
    print(f"  New playoff rows: {len(raw)} across {raw['team_code'].nunique()} teams")

    # Step 2: compute per-game efficiency (same formulas as regular season)
    for col in ["PTS", "FGA", "FTA", "OREB", "TOV"]:
        raw[col] = pd.to_numeric(raw[col], errors="coerce").fillna(0)
    raw["possessions"] = (raw["FGA"] - raw["OREB"] + raw["TOV"] + 0.44 * raw["FTA"]).clip(lower=1)
    raw["ortg_game"]  = (raw["PTS"] / raw["possessions"] * 100).round(2)
    raw["pace_game"]  = (raw["possessions"] * 48 / 40).round(1)  # approximate
    raw["ts_pct_game"] = (raw["PTS"] / (2 * (raw["FGA"] + 0.44 * raw["FTA"])).clip(lower=1)).round(4)

    # drtg = opponent's ortg in same game — self-join on Game_ID
    opp = raw[["Game_ID", "team_code", "ortg_game"]].rename(
        columns={"team_code": "opp_code", "ortg_game": "drtg_game"}
    )
    raw = raw.merge(opp, on="Game_ID", how="left")
    raw = raw[raw["team_code"] != raw["opp_code"]].drop_duplicates(subset=["team_code", "Game_ID"])

    # Step 3: compute rolling windows by prepending existing regular-season rows
    new_eff_rows: list[pd.DataFrame] = []
    for team, grp in raw.groupby("team_code"):
        hist = existing[existing["team_code"] == team].copy()
        # Append playoff rows to history (no rolling values yet)
        playoff_rows = grp[["team_code", "season", "Game_ID", "GAME_DATE",
                             "ortg_game", "drtg_game", "pace_game", "ts_pct_game"]].copy()
        playoff_rows = playoff_rows.rename(columns={"Game_ID": "nba_game_id", "GAME_DATE": "date"})
        playoff_rows["date"] = pd.to_datetime(playoff_rows["date"])
        combined_team = pd.concat([
            hist[["team_code", "season", "nba_game_id", "date",
                  "ortg_game", "drtg_game", "pace_game", "ts_pct_game"]],
            playoff_rows,
        ]).sort_values("date").reset_index(drop=True)

        for src, out5, out10 in [
            ("ortg_game", "ortg_avg5", "ortg_avg10"),
            ("drtg_game", "drtg_avg5", "drtg_avg10"),
            ("pace_game", "pace_avg5", None),
            ("ts_pct_game", "ts_avg5", None),
        ]:
            s = combined_team[src]
            combined_team[out5] = s.shift(1).rolling(5, min_periods=1).mean().round(3)
            if out10:
                combined_team[out10] = s.shift(1).rolling(10, min_periods=1).mean().round(3)

        # Keep only the newly added playoff rows
        new_only = combined_team[combined_team["nba_game_id"].isin(
            playoff_rows["nba_game_id"].astype(str)
        )]
        new_eff_rows.append(new_only)

    if not new_eff_rows:
        return

    appended = pd.concat(new_eff_rows, ignore_index=True)
    appended = appended.rename(columns={"date": "date"})
    full = pd.concat([existing, appended], ignore_index=True).sort_values(
        ["team_code", "date"]
    ).reset_index(drop=True)
    full.to_csv(OUTPUT_PATH, index=False)
    print(f"  Updated CSV: {len(existing):,} → {len(full):,} rows (+{len(appended)} playoff games)")


def run(include_playoffs: bool = False) -> None:
    print("=" * 55)
    print("  Fetching NBA game-level efficiency (nba_api)")
    print("=" * 55)
    print(f"  Teams: {len(_TEAM_IDS)}  |  Seasons: 2008-2026")
    print(f"  Cache: {CACHE_DIR}")
    print(f"  Estimated time: ~{len(_TEAM_IDS) * 19 * 0.65 / 60:.0f} min (uncached)")
    print()
    df = build_game_efficiency()
    print()
    print("  Sample:")
    print(df[df["team_code"] == "bos"].tail(3)[
        ["season", "date", "team_code", "ortg_avg5", "drtg_avg5", "pace_avg5"]
    ].to_string(index=False))

    if include_playoffs:
        print()
        fetch_playoff_efficiency()


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--playoffs", action="store_true",
                        help="Also fetch current-season playoff game logs")
    args = parser.parse_args()
    try:
        run(include_playoffs=args.playoffs)
    except Exception as e:
        print(f"\n  ERROR: {e}", file=sys.stderr)
        sys.exit(1)
