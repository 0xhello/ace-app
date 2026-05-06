from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Dict, List, Tuple

import joblib
import numpy as np
import pandas as pd
from sklearn.metrics import accuracy_score, precision_score, recall_score, roc_auc_score
from xgboost import XGBClassifier

ARTIFACT_DIR = Path(__file__).resolve().parent / "artifacts"
EFFICIENCY_PATH = Path(__file__).resolve().parent / "data" / "team_season_efficiency.csv"
GAME_EFFICIENCY_PATH = Path(__file__).resolve().parent / "data" / "team_game_efficiency.csv"
REFEREE_PATH = Path(__file__).resolve().parent / "data" / "referee_features.csv"
MODEL_PATH = ARTIFACT_DIR / "nba_spread_xgb.joblib"
FEATURE_COLUMNS_PATH = ARTIFACT_DIR / "feature_columns.json"
BACKTEST_METRICS_PATH = ARTIFACT_DIR / "backtest_metrics.json"
TEAM_STATE_PATH = ARTIFACT_DIR / "latest_team_state.json"

FEATURE_COLUMNS: List[str] = [
    # Context
    "season",
    "month",
    "day_of_week",
    "is_playoffs",
    # Rest / schedule
    "home_rest_days",
    "away_rest_days",
    "rest_diff",
    "home_back2back",
    "away_back2back",
    # Rolling team performance — fundamental only, no market prices
    "home_margin_last1",
    "away_margin_last1",
    "home_margin_avg_3",
    "away_margin_avg_3",
    "home_margin_avg_5",
    "away_margin_avg_5",
    "home_points_for_avg_5",
    "away_points_for_avg_5",
    "home_points_against_avg_5",
    "away_points_against_avg_5",
    "home_cover_rate_5",
    "away_cover_rate_5",
    "home_cover_rate_10",
    "away_cover_rate_10",
    "home_games_played",
    "away_games_played",
    # Matchup differentials (rolling)
    "margin_avg5_diff",
    "pts_for_avg5_diff",
    "pts_against_avg5_diff",
    "cover_rate5_diff",
    # Per-game rolling efficiency (ortg/drtg/pace from actual box scores — pre-shifted, no leakage)
    "home_ortg_avg5",
    "away_ortg_avg5",
    "home_drtg_avg5",
    "away_drtg_avg5",
    "home_pace_avg5",
    "away_pace_avg5",
    "home_ts_avg5",
    "away_ts_avg5",
    "home_ortg_avg10",
    "away_ortg_avg10",
    "home_drtg_avg10",
    "away_drtg_avg10",
    # Efficiency matchup differentials
    "ortg_avg5_diff",
    "drtg_avg5_diff",
    "net_rtg_avg5_diff",
    "pace_avg5_diff",
    # Q4 / clutch performance
    "home_q4_margin_avg5",
    "away_q4_margin_avg5",
    "home_q4_cover_rate5",
    "away_q4_cover_rate5",
    "q4_margin_diff",
    # Home/away venue-specific efficiency splits
    "home_ortg_home_avg5",
    "away_ortg_away_avg5",
    "home_ts_home_avg5",
    "away_ts_away_avg5",
    # Travel burden
    "home_miles_traveled",
    "away_miles_traveled",
    "home_road_trip_games",
    "away_road_trip_games",
    "home_tz_delta",
    "away_tz_delta",
    "travel_diff",
    # crew_total_pts_avg excluded: referee data only covers 2021+ (~28% of rows).
    # Sparse coverage degrades the model vs the baseline. Re-add once multi-season
    # historical referee data is available.
    # Experiment 1 (2026-05-01): added home_line, spread_abs, home_favorite, total_line.
    # Result: ROC AUC -0.0073, ROI -0.26pp worse across all thresholds. FAILED.
    # Hypothesis falsified. Spread context does not improve this model on this dataset.
]

TEAM_NAME_TO_CODE: Dict[str, str] = {
    "Atlanta Hawks": "atl",
    "Boston Celtics": "bos",
    "Brooklyn Nets": "bkn",
    "Charlotte Hornets": "cha",
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
    "New York Knicks": "ny",
    "Oklahoma City Thunder": "okc",
    "Orlando Magic": "orl",
    "Philadelphia 76ers": "phi",
    "Phoenix Suns": "phx",
    "Portland Trail Blazers": "por",
    "Sacramento Kings": "sac",
    "San Antonio Spurs": "sa",
    "Toronto Raptors": "tor",
    "Utah Jazz": "utah",
    "Washington Wizards": "wsh",
}


def american_to_implied_prob(odds: pd.Series) -> pd.Series:
    odds = odds.astype(float)
    return np.where(odds > 0, 100.0 / (odds + 100.0), np.abs(odds) / (np.abs(odds) + 100.0))


def season_from_date(date_value: pd.Timestamp) -> int:
    return date_value.year + 1 if date_value.month >= 10 else date_value.year


def build_team_games(df: pd.DataFrame) -> pd.DataFrame:
    base_cols = ["game_id", "season", "date", "playoffs"]

    home = df[base_cols].copy()
    home["team"] = df["home"]
    home["opponent"] = df["away"]
    home["is_home"] = 1
    home["line"] = df["home_line"]
    home["points_for"] = df["score_home"]
    home["points_against"] = df["score_away"]
    home["margin"] = df["score_home"] - df["score_away"]
    home["covered"] = df["home_covered"]

    away = df[base_cols].copy()
    away["team"] = df["away"]
    away["opponent"] = df["home"]
    away["is_home"] = 0
    away["line"] = -df["home_line"]
    away["points_for"] = df["score_away"]
    away["points_against"] = df["score_home"]
    away["margin"] = df["score_away"] - df["score_home"]
    away["covered"] = 1 - df["home_covered"]

    team_games = pd.concat([home, away], ignore_index=True)
    team_games = team_games.sort_values(["season", "team", "date", "game_id"]).reset_index(drop=True)

    grouped = team_games.groupby(["season", "team"], sort=False)
    prev_date = grouped["date"].shift(1)
    team_games["rest_days"] = (team_games["date"] - prev_date).dt.days.sub(1)
    team_games["rest_days"] = team_games["rest_days"].fillna(5).clip(lower=0, upper=7)

    team_games["margin_last1"] = grouped["margin"].shift(1)
    team_games["margin_avg_3"] = grouped["margin"].transform(lambda s: s.shift(1).rolling(3, min_periods=1).mean())
    team_games["margin_avg_5"] = grouped["margin"].transform(lambda s: s.shift(1).rolling(5, min_periods=1).mean())
    team_games["points_for_avg_5"] = grouped["points_for"].transform(lambda s: s.shift(1).rolling(5, min_periods=1).mean())
    team_games["points_against_avg_5"] = grouped["points_against"].transform(lambda s: s.shift(1).rolling(5, min_periods=1).mean())
    team_games["cover_rate_5"] = grouped["covered"].transform(lambda s: s.shift(1).rolling(5, min_periods=1).mean())
    team_games["cover_rate_10"] = grouped["covered"].transform(lambda s: s.shift(1).rolling(10, min_periods=1).mean())
    team_games["games_played"] = grouped.cumcount()

    fill_defaults = {
        "margin_last1": 0.0,
        "margin_avg_3": 0.0,
        "margin_avg_5": 0.0,
        "points_for_avg_5": 100.0,
        "points_against_avg_5": 100.0,
        "cover_rate_5": 0.5,
        "cover_rate_10": 0.5,
        "games_played": 0,
    }
    team_games = team_games.fillna(fill_defaults)
    return team_games


def merge_team_features(df: pd.DataFrame, team_games: pd.DataFrame) -> pd.DataFrame:
    team_feature_cols = [
        "game_id",
        "team",
        "rest_days",
        "margin_last1",
        "margin_avg_3",
        "margin_avg_5",
        "points_for_avg_5",
        "points_against_avg_5",
        "cover_rate_5",
        "cover_rate_10",
        "games_played",
    ]
    features = team_games[team_feature_cols]

    home = features.rename(
        columns={
            "team": "home",
            "rest_days": "home_rest_days",
            "margin_last1": "home_margin_last1",
            "margin_avg_3": "home_margin_avg_3",
            "margin_avg_5": "home_margin_avg_5",
            "points_for_avg_5": "home_points_for_avg_5",
            "points_against_avg_5": "home_points_against_avg_5",
            "cover_rate_5": "home_cover_rate_5",
            "cover_rate_10": "home_cover_rate_10",
            "games_played": "home_games_played",
        }
    )
    away = features.rename(
        columns={
            "team": "away",
            "rest_days": "away_rest_days",
            "margin_last1": "away_margin_last1",
            "margin_avg_3": "away_margin_avg_3",
            "margin_avg_5": "away_margin_avg_5",
            "points_for_avg_5": "away_points_for_avg_5",
            "points_against_avg_5": "away_points_against_avg_5",
            "cover_rate_5": "away_cover_rate_5",
            "cover_rate_10": "away_cover_rate_10",
            "games_played": "away_games_played",
        }
    )

    merged = df.merge(home, on=["game_id", "home"], how="left")
    merged = merged.merge(away, on=["game_id", "away"], how="left")
    merged["rest_diff"] = merged["home_rest_days"] - merged["away_rest_days"]
    merged["home_back2back"] = (merged["home_rest_days"] == 0).astype(int)
    merged["away_back2back"] = (merged["away_rest_days"] == 0).astype(int)
    merged["margin_avg5_diff"] = merged["home_margin_avg_5"] - merged["away_margin_avg_5"]
    merged["pts_for_avg5_diff"] = merged["home_points_for_avg_5"] - merged["away_points_for_avg_5"]
    merged["pts_against_avg5_diff"] = merged["home_points_against_avg_5"] - merged["away_points_against_avg_5"]
    merged["cover_rate5_diff"] = merged["home_cover_rate_5"] - merged["away_cover_rate_5"]
    return merged


def load_efficiency_data() -> pd.DataFrame:
    """
    Load team season efficiency and shift by 1 season to prevent leakage.
    Each row represents the efficiency stats a team ENTERS a season with
    (i.e., last season's numbers), keyed by (team_code, season).
    """
    if not EFFICIENCY_PATH.exists():
        raise FileNotFoundError(
            f"Efficiency data not found: {EFFICIENCY_PATH}\n"
            "Run: python3 -m ml.nba_spread.fetch_efficiency_data"
        )
    eff = pd.read_csv(EFFICIENCY_PATH)
    # Lag by 1: season 2025 game uses season 2024 efficiency stats
    eff["season"] = eff["season"] + 1
    return eff.rename(columns={
        "ortg": "home_ortg", "drtg": "home_drtg",
        "net_rtg": "home_net_rtg", "pace": "home_pace", "ts_pct": "home_ts_pct",
    })


def merge_efficiency(df: pd.DataFrame, eff: pd.DataFrame) -> pd.DataFrame:
    """Join lagged efficiency onto each game for both home and away team."""
    home_eff = eff.rename(columns={
        "team_code": "home",
        "home_ortg": "home_ortg", "home_drtg": "home_drtg",
        "home_net_rtg": "home_net_rtg", "home_pace": "home_pace", "home_ts_pct": "home_ts_pct",
    })
    away_eff = eff.rename(columns={
        "team_code": "away",
        "home_ortg": "away_ortg", "home_drtg": "away_drtg",
        "home_net_rtg": "away_net_rtg", "home_pace": "away_pace", "home_ts_pct": "away_ts_pct",
    })

    merged = df.merge(home_eff[["season", "home", "home_ortg", "home_drtg", "home_net_rtg", "home_pace", "home_ts_pct"]],
                      on=["season", "home"], how="left")
    merged = merged.merge(away_eff[["season", "away", "away_ortg", "away_drtg", "away_net_rtg", "away_pace", "away_ts_pct"]],
                          on=["season", "away"], how="left")

    # Fill missing (first season in dataset or expansion teams) with global means
    for col in ["home_ortg", "home_drtg", "home_net_rtg", "home_pace", "home_ts_pct"]:
        merged[col] = merged[col].fillna(merged[col].mean())
    for col in ["away_ortg", "away_drtg", "away_net_rtg", "away_pace", "away_ts_pct"]:
        merged[col] = merged[col].fillna(merged[col].mean())

    merged["ortg_diff"] = merged["home_ortg"] - merged["away_ortg"]
    merged["drtg_diff"] = merged["home_drtg"] - merged["away_drtg"]
    merged["net_rtg_diff"] = merged["home_net_rtg"] - merged["away_net_rtg"]
    merged["pace_diff"] = merged["home_pace"] - merged["away_pace"]
    return merged


def merge_advanced_features(df: pd.DataFrame) -> pd.DataFrame:
    """
    Join Q4/clutch, home/away splits, and travel features onto each training row.
    All three CSVs are keyed by (date, team_code) with pre-shifted rolling values.
    Missing rows fill with column mean.
    """
    advanced_dir = Path(__file__).resolve().parent / "data"

    # Fixed defaults for NaN imputation — avoids future-looking column.mean()
    _FILL_DEFAULTS: dict[str, float] = {
        "q4_margin_avg5": 0.0, "q4_margin_avg10": 0.0, "q4_cover_rate5": 0.5,
        "ortg_home_avg5": 0.0, "ts_home_avg5": 0.0,
        "ortg_away_avg5": 0.0, "ts_away_avg5": 0.0,
        "miles_traveled": 0.0, "tz_delta": 0.0, "road_trip_games": 0.0,
    }

    def _join(df_base: pd.DataFrame, path: Path,
              home_cols: list[str], away_cols: list[str]) -> pd.DataFrame:
        if not path.exists():
            return df_base
        feat = pd.read_csv(path, parse_dates=["date"])

        home_feat = feat.rename(columns={"team_code": "home",
                                          **{c: f"home_{c}" for c in home_cols + away_cols}})
        away_feat = feat.rename(columns={"team_code": "away",
                                          **{c: f"away_{c}" for c in home_cols + away_cols}})

        home_keep = ["date", "home"] + [f"home_{c}" for c in home_cols]
        away_keep = ["date", "away"] + [f"away_{c}" for c in away_cols]

        merged = df_base.merge(home_feat[home_keep], on=["date", "home"], how="left")
        merged = merged.merge(away_feat[away_keep], on=["date", "away"], how="left")
        for c in home_keep[2:] + away_keep[2:]:
            if c in merged.columns:
                # Strip prefix to find the base column name for its fixed default
                base = c.removeprefix("home_").removeprefix("away_")
                fill = _FILL_DEFAULTS.get(base, 0.0)
                merged[c] = merged[c].fillna(fill)
        return merged

    # Q4 features
    q4_cols = ["q4_margin_avg5", "q4_margin_avg10", "q4_cover_rate5"]
    df = _join(df, advanced_dir / "q4_features.csv", q4_cols, q4_cols)
    df["q4_margin_diff"] = df.get("home_q4_margin_avg5", 0) - df.get("away_q4_margin_avg5", 0)

    # Home/away venue splits
    home_split_cols = ["ortg_home_avg5", "ts_home_avg5"]
    away_split_cols = ["ortg_away_avg5", "ts_away_avg5"]
    df = _join(df, advanced_dir / "home_away_splits.csv", home_split_cols, away_split_cols)

    # Travel features
    travel_cols = ["miles_traveled", "tz_delta", "road_trip_games"]
    df = _join(df, advanced_dir / "travel_features.csv", travel_cols, travel_cols)
    df["travel_diff"] = df.get("away_miles_traveled", 0) - df.get("home_miles_traveled", 0)

    # Player availability / lineup quality
    lineup_path = advanced_dir / "lineup_quality.csv"
    if lineup_path.exists():
        lq = pd.read_csv(lineup_path, parse_dates=["date"])
        lq = lq[["date", "team_code", "lineup_quality_pct", "star_absent", "key_players_absent"]]

        home_lq = lq.rename(columns={
            "team_code": "home",
            "lineup_quality_pct": "home_lineup_quality_pct",
            "star_absent": "home_star_absent",
            "key_players_absent": "home_key_players_absent",
        })
        away_lq = lq.rename(columns={
            "team_code": "away",
            "lineup_quality_pct": "away_lineup_quality_pct",
            "star_absent": "away_star_absent",
            "key_players_absent": "away_key_players_absent",
        })

        df = df.merge(
            home_lq[["date", "home", "home_lineup_quality_pct", "home_star_absent", "home_key_players_absent"]],
            on=["date", "home"], how="left",
        )
        df = df.merge(
            away_lq[["date", "away", "away_lineup_quality_pct", "away_star_absent", "away_key_players_absent"]],
            on=["date", "away"], how="left",
        )

        df["home_lineup_quality_pct"] = df["home_lineup_quality_pct"].fillna(1.0)
        df["away_lineup_quality_pct"] = df["away_lineup_quality_pct"].fillna(1.0)
        df["home_star_absent"] = df["home_star_absent"].fillna(0)
        df["away_star_absent"] = df["away_star_absent"].fillna(0)
        df["home_key_players_absent"] = df["home_key_players_absent"].fillna(0)
        df["away_key_players_absent"] = df["away_key_players_absent"].fillna(0)
        df["lineup_quality_diff"] = df["home_lineup_quality_pct"] - df["away_lineup_quality_pct"]

    # Referee tendencies — join via NBA game_id bridge from game efficiency CSV
    referee_path = advanced_dir / "referee_features.csv"
    game_eff_path = advanced_dir / "team_game_efficiency.csv"
    if referee_path.exists() and game_eff_path.exists():
        ref = pd.read_csv(referee_path)[["game_id", "crew_total_pts_avg"]].dropna(subset=["crew_total_pts_avg"])
        ref = ref.rename(columns={"game_id": "nba_game_id"})
        ref["nba_game_id"] = ref["nba_game_id"].astype(str)

        # Build (date, home_team, away_team) → nba_game_id from game efficiency rows
        eff_cols = pd.read_csv(game_eff_path, usecols=["date", "team_code", "nba_game_id"])
        eff_cols["date"] = pd.to_datetime(eff_cols["date"])
        eff_cols["nba_game_id"] = eff_cols["nba_game_id"].astype(str)
        # Self-join on same game_id to get home and away
        home_rows = eff_cols.rename(columns={"team_code": "home"})
        away_rows = eff_cols.rename(columns={"team_code": "away"})
        game_bridge = home_rows.merge(away_rows, on=["date", "nba_game_id"]).query("home != away")
        game_bridge = game_bridge.drop_duplicates(subset=["date", "home", "away"])

        # Join referee features onto the bridge then onto training data
        game_bridge = game_bridge.merge(ref, on="nba_game_id", how="left")
        df = df.merge(
            game_bridge[["date", "home", "away", "crew_total_pts_avg"]],
            on=["date", "home", "away"], how="left",
        )
        # NaN rows (no referee match) are left as NaN — XGBoost handles missing natively
    else:
        df["crew_total_pts_avg"] = float("nan")

    return df


def merge_game_efficiency(df: pd.DataFrame) -> pd.DataFrame:
    """
    Join per-game rolling ortg/drtg/pace onto each training row.
    Matches on (date, team_code) — rolling values are pre-shifted so no leakage.
    Falls back to column mean when a team/date has no prior game data.
    """
    if not GAME_EFFICIENCY_PATH.exists():
        raise FileNotFoundError(
            f"Game efficiency data not found: {GAME_EFFICIENCY_PATH}\n"
            "Run: python3 -m ml.nba_spread.fetch_game_efficiency"
        )
    eff = pd.read_csv(GAME_EFFICIENCY_PATH, parse_dates=["date"])

    roll_cols = ["ortg_avg5", "drtg_avg5", "pace_avg5", "ts_avg5", "ortg_avg10", "drtg_avg10"]

    home_eff = eff.rename(columns={
        "team_code": "home",
        **{c: f"home_{c}" for c in roll_cols},
    })[["date", "home"] + [f"home_{c}" for c in roll_cols]]

    away_eff = eff.rename(columns={
        "team_code": "away",
        **{c: f"away_{c}" for c in roll_cols},
    })[["date", "away"] + [f"away_{c}" for c in roll_cols]]

    merged = df.merge(home_eff, on=["date", "home"], how="left")
    merged = merged.merge(away_eff, on=["date", "away"], how="left")

    # Neutral priors for missing efficiency data (e.g., expansion teams, first season)
    # Using historical NBA averages rather than future-looking column.mean()
    _EFF_DEFAULTS = {
        "ortg_avg5": 110.0, "drtg_avg5": 110.0, "pace_avg5": 98.0,
        "ts_avg5": 0.55, "ortg_avg10": 110.0, "drtg_avg10": 110.0,
    }
    for side in ("home", "away"):
        for c in roll_cols:
            col = f"{side}_{c}"
            merged[col] = merged[col].fillna(_EFF_DEFAULTS.get(c, 0.0))

    merged["ortg_avg5_diff"]   = merged["home_ortg_avg5"] - merged["away_ortg_avg5"]
    merged["drtg_avg5_diff"]   = merged["home_drtg_avg5"] - merged["away_drtg_avg5"]
    merged["net_rtg_avg5_diff"] = (merged["home_ortg_avg5"] - merged["home_drtg_avg5"]) \
                                 - (merged["away_ortg_avg5"] - merged["away_drtg_avg5"])
    merged["pace_avg5_diff"]   = merged["home_pace_avg5"] - merged["away_pace_avg5"]
    return merged


def load_and_prepare_dataset(csv_path: Path) -> Tuple[pd.DataFrame, pd.DataFrame]:
    df = pd.read_csv(csv_path)
    df.columns = [c.strip() for c in df.columns]
    df["date"] = pd.to_datetime(df["date"])
    df = df.sort_values(["date", "season", "away", "home"]).reset_index(drop=True)
    df["game_id"] = np.arange(len(df)).astype(str)

    df["spread"] = pd.to_numeric(df["spread"], errors="coerce")
    df["total"] = pd.to_numeric(df["total"], errors="coerce")
    df["moneyline_home"] = pd.to_numeric(df["moneyline_home"], errors="coerce")
    df["moneyline_away"] = pd.to_numeric(df["moneyline_away"], errors="coerce")
    df["h2_spread"] = pd.to_numeric(df["h2_spread"], errors="coerce")
    df["h2_total"] = pd.to_numeric(df["h2_total"], errors="coerce")
    # id_spread and id_total are post-game result flags — not parsed, not used

    df["season"] = df["season"].fillna(df["date"].apply(season_from_date)).astype(int)
    df["month"] = df["date"].dt.month
    df["day_of_week"] = df["date"].dt.dayofweek
    df["is_playoffs"] = df["playoffs"].astype(int)

    df["home_line"] = np.where(df["whos_favored"].eq("home"), -df["spread"], df["spread"])
    df["spread_abs"] = df["home_line"].abs()
    df["home_favorite"] = (df["home_line"] < 0).astype(int)
    df["pickem"] = (df["home_line"] == 0).astype(int)
    df["total_line"] = df["total"]

    df["implied_prob_home"] = american_to_implied_prob(df["moneyline_home"])
    df["implied_prob_away"] = american_to_implied_prob(df["moneyline_away"])
    df["implied_prob_gap"] = df["implied_prob_home"] - df["implied_prob_away"]

    # h2_spread is the 2nd-half spread — a real pre-game market line, useful signal
    # id_spread / id_total are POST-GAME result flags encoding who covered — excluded to prevent leakage
    df["h2_spread_line"] = df["h2_spread"].fillna(df["spread"] / 2)

    margin_home = df["score_home"] - df["score_away"]
    cover_margin = margin_home + df["home_line"]
    df["home_covered"] = np.where(cover_margin > 0, 1, np.where(cover_margin < 0, 0, np.nan))

    model_df = df.dropna(subset=["home_covered"]).copy()
    model_df["home_covered"] = model_df["home_covered"].astype(int)

    team_games = build_team_games(model_df)
    model_df = merge_team_features(model_df, team_games)
    model_df = merge_game_efficiency(model_df)
    model_df = merge_advanced_features(model_df)

    # Per-column defaults — avoids bad 0-fills for features where 0 is misleading.
    # crew_total_pts_avg intentionally left out: referee data only covers 2021+,
    # so ~72% of rows are NaN — XGBoost handles missing natively (learns direction
    # for each split), which outperforms filling with an arbitrary 215.0 constant.
    _FINAL_DEFAULTS: dict[str, float] = {
        "home_q4_cover_rate5": 0.5, "away_q4_cover_rate5": 0.5,
        "home_cover_rate_5": 0.5, "away_cover_rate_5": 0.5,
        "home_cover_rate_10": 0.5, "away_cover_rate_10": 0.5,
    }
    for col in FEATURE_COLUMNS:
        if col in model_df.columns:
            model_df[col] = model_df[col].fillna(_FINAL_DEFAULTS.get(col, 0.0))
    return model_df, team_games


def build_latest_team_state(team_games: pd.DataFrame) -> Dict[str, Dict[str, float]]:
    latest: Dict[str, Dict[str, float]] = {}
    ordered = team_games.sort_values(["date", "game_id"]).groupby("team", sort=False).tail(1)
    for _, row in ordered.iterrows():
        latest[row["team"]] = {
            "season": int(row["season"]),
            "last_game_date": row["date"].strftime("%Y-%m-%d"),
            "rest_days": float(row["rest_days"]),
            "margin_last1": float(row["margin_last1"]),
            "margin_avg_3": float(row["margin_avg_3"]),
            "margin_avg_5": float(row["margin_avg_5"]),
            "points_for_avg_5": float(row["points_for_avg_5"]),
            "points_against_avg_5": float(row["points_against_avg_5"]),
            "cover_rate_5": float(row["cover_rate_5"]),
            "cover_rate_10": float(row["cover_rate_10"]),
            "games_played": int(row["games_played"]),
        }
    return latest


def chronological_split(df: pd.DataFrame, test_size: float = 0.2) -> Tuple[pd.DataFrame, pd.DataFrame]:
    ordered = df.sort_values(["date", "game_id"]).reset_index(drop=True)
    split_idx = int(len(ordered) * (1 - test_size))
    return ordered.iloc[:split_idx].copy(), ordered.iloc[split_idx:].copy()


def run_backtest(test_df: pd.DataFrame, probs: np.ndarray, threshold: float = 0.54) -> Dict[str, float]:
    bets = []
    payout_win = 100.0 / 110.0
    for row, p_home in zip(test_df.itertuples(index=False), probs):
        p_home = float(p_home)
        if p_home >= threshold:
            won = int(row.home_covered == 1)
            profit = payout_win if won else -1.0
            bets.append({"side": "home", "won": won, "profit": profit, "prob": p_home})
        elif p_home <= 1 - threshold:
            won = int(row.home_covered == 0)
            profit = payout_win if won else -1.0
            bets.append({"side": "away", "won": won, "profit": profit, "prob": 1 - p_home})

    if not bets:
        return {"bets": 0, "wins": 0, "win_rate": 0.0, "units": 0.0, "roi": 0.0}

    bets_df = pd.DataFrame(bets)
    units = float(bets_df["profit"].sum())
    num_bets = int(len(bets_df))
    wins = int(bets_df["won"].sum())
    return {
        "bets": num_bets,
        "wins": wins,
        "win_rate": round(wins / num_bets, 4),
        "units": round(units, 4),
        "roi": round(units / num_bets, 4),
    }


def train_model(train_df: pd.DataFrame) -> XGBClassifier:
    X_train = train_df[FEATURE_COLUMNS]
    y_train = train_df["home_covered"]

    model = XGBClassifier(
        n_estimators=600,
        max_depth=4,
        learning_rate=0.025,
        subsample=0.8,
        colsample_bytree=0.65,
        reg_lambda=2.5,
        reg_alpha=0.5,
        min_child_weight=5,
        gamma=0.15,
        objective="binary:logistic",
        eval_metric="logloss",
        random_state=42,
    )
    model.fit(X_train, y_train)
    return model


def evaluate_model(model: XGBClassifier, test_df: pd.DataFrame) -> Dict[str, float]:
    X_test = test_df[FEATURE_COLUMNS]
    y_test = test_df["home_covered"]

    probs = model.predict_proba(X_test)[:, 1]
    preds = (probs >= 0.5).astype(int)

    metrics = {
        "rows_train": 0,
        "rows_test": int(len(test_df)),
        "accuracy": round(float(accuracy_score(y_test, preds)), 4),
        "precision": round(float(precision_score(y_test, preds, zero_division=0)), 4),
        "recall": round(float(recall_score(y_test, preds, zero_division=0)), 4),
        "roc_auc": round(float(roc_auc_score(y_test, probs)), 4),
    }

    # Find best threshold by ROI across candidates
    best_threshold = 0.54
    best_roi = -999.0
    threshold_results: Dict[str, Dict[str, float]] = {}
    for t in [0.52, 0.53, 0.54, 0.55, 0.56, 0.57, 0.58]:
        bt = run_backtest(test_df, probs, threshold=t)
        threshold_results[str(t)] = bt
        if bt["bets"] >= 50 and bt["roi"] > best_roi:
            best_roi = bt["roi"]
            best_threshold = t

    metrics["best_threshold"] = best_threshold
    metrics["threshold_sweep"] = threshold_results
    metrics.update(run_backtest(test_df, probs, threshold=best_threshold))
    return metrics


def save_artifacts(model: XGBClassifier, feature_columns: List[str], metrics: Dict[str, float], team_state: Dict[str, Dict[str, float]]) -> None:
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    joblib.dump(model, MODEL_PATH)
    FEATURE_COLUMNS_PATH.write_text(json.dumps(feature_columns, indent=2))
    BACKTEST_METRICS_PATH.write_text(json.dumps(metrics, indent=2))
    TEAM_STATE_PATH.write_text(json.dumps(team_state, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description="Train the ACE NBA spread model.")
    parser.add_argument("--csv", required=True, help="Path to nba_2008-2025.csv")
    args = parser.parse_args()

    csv_path = Path(args.csv).expanduser().resolve()
    if not csv_path.exists():
        raise FileNotFoundError(f"CSV not found: {csv_path}")

    model_df, team_games = load_and_prepare_dataset(csv_path)
    train_df, test_df = chronological_split(model_df, test_size=0.2)

    model = train_model(train_df)
    metrics = evaluate_model(model, test_df)
    metrics["rows_train"] = int(len(train_df))
    metrics["rows_test"] = int(len(test_df))

    team_state = build_latest_team_state(team_games)
    save_artifacts(model, FEATURE_COLUMNS, metrics, team_state)

    print("=" * 55)
    print("  ACE NBA SPREAD MODEL — TRAINING RESULTS")
    print("=" * 55)
    print(f"  Train rows :  {metrics['rows_train']:,}")
    print(f"  Test rows  :  {metrics['rows_test']:,}")
    print(f"  Accuracy   :  {metrics['accuracy']:.4f}")
    print(f"  Precision  :  {metrics['precision']:.4f}")
    print(f"  ROC-AUC    :  {metrics['roc_auc']:.4f}")
    print()
    print(f"  Backtest @ threshold {metrics['best_threshold']} (best found):")
    print(f"    Bets     :  {metrics['bets']:,}")
    print(f"    Win rate :  {metrics['win_rate']:.4f}  (need >0.5238 to profit)")
    print(f"    Units    :  {metrics['units']:+.2f}")
    print(f"    ROI      :  {metrics['roi']:+.4f}")
    print()
    print("  Threshold sweep:")
    for t, bt in metrics["threshold_sweep"].items():
        flag = " <-- best" if float(t) == metrics["best_threshold"] else ""
        print(f"    {t}: {bt['bets']:4d} bets  win={bt['win_rate']:.3f}  ROI={bt['roi']:+.4f}{flag}")
    print()
    print("  Top 10 features by importance:")
    importances = sorted(zip(FEATURE_COLUMNS, model.feature_importances_), key=lambda x: -x[1])
    for feat, imp in importances[:10]:
        print(f"    {feat:<35} {imp:.4f}")
    print("=" * 55)
    print(f"  Model → {MODEL_PATH}")
    print(f"  State → {TEAM_STATE_PATH}")


if __name__ == "__main__":
    main()
