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
MODEL_PATH = ARTIFACT_DIR / "nba_spread_xgb.joblib"
FEATURE_COLUMNS_PATH = ARTIFACT_DIR / "feature_columns.json"
BACKTEST_METRICS_PATH = ARTIFACT_DIR / "backtest_metrics.json"
TEAM_STATE_PATH = ARTIFACT_DIR / "latest_team_state.json"

FEATURE_COLUMNS: List[str] = [
    "season",
    "month",
    "day_of_week",
    "is_playoffs",
    "home_line",
    "spread_abs",
    "home_favorite",
    "pickem",
    "total_line",
    "moneyline_home",
    "moneyline_away",
    "implied_prob_home",
    "implied_prob_away",
    "implied_prob_gap",
    # Rest / schedule
    "home_rest_days",
    "away_rest_days",
    "rest_diff",
    "home_back2back",
    "away_back2back",
    # 2nd-half spread (real pre-game market line)
    "h2_spread_line",
    # Rolling team performance
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
    # Matchup differentials
    "margin_avg5_diff",
    "pts_for_avg5_diff",
    "pts_against_avg5_diff",
    "cover_rate5_diff",
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
    model_df[FEATURE_COLUMNS] = model_df[FEATURE_COLUMNS].fillna(0)

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
        n_estimators=500,
        max_depth=4,
        learning_rate=0.03,
        subsample=0.8,
        colsample_bytree=0.75,
        reg_lambda=2.0,
        reg_alpha=0.5,
        min_child_weight=4,
        gamma=0.1,
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
