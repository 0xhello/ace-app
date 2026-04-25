from __future__ import annotations

import csv
import json
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

import joblib
import numpy as np
import pandas as pd

from .train_spread_model import (
    FEATURE_COLUMNS,
    FEATURE_COLUMNS_PATH,
    MODEL_PATH,
    TEAM_NAME_TO_CODE,
    TEAM_STATE_PATH,
    american_to_implied_prob,
    season_from_date,
)

MODULE_DIR = Path(__file__).resolve().parent
MODEL_PERFORMANCE_PATH = MODULE_DIR / "model_performance.csv"
MODEL_VERSION = "nba_spread_xgb_v1"


def _load_json(path: Path) -> Dict[str, Any]:
    return json.loads(path.read_text()) if path.exists() else {}


def load_artifacts() -> Dict[str, Any]:
    if not MODEL_PATH.exists():
        raise FileNotFoundError(f"Model artifact missing: {MODEL_PATH}")
    return {
        "model": joblib.load(MODEL_PATH),
        "feature_columns": json.loads(FEATURE_COLUMNS_PATH.read_text()) if FEATURE_COLUMNS_PATH.exists() else FEATURE_COLUMNS,
        "team_state": _load_json(TEAM_STATE_PATH),
    }


def normalize_team_code(team: str) -> str:
    team = (team or "").strip()
    if team.lower() in {"golden state warriors", "golden state"}:
        return "gs"
    if team.lower() in {"new york knicks", "new york"}:
        return "ny"
    if team.lower() in {"san antonio spurs", "san antonio"}:
        return "sa"
    if team.lower() in {"new orleans pelicans", "new orleans hornets", "new orleans"}:
        return "no"
    if team.lower() == "utah jazz":
        return "utah"
    if team.lower() == "la clippers":
        return "lac"
    if team.lower() == "los angeles lakers":
        return "lal"
    if team.lower() == "los angeles clippers":
        return "lac"
    if team in TEAM_NAME_TO_CODE:
        return TEAM_NAME_TO_CODE[team]
    compact = team.lower().replace(".", "").replace(" ", "")
    reverse_lookup = {v: v for v in TEAM_NAME_TO_CODE.values()}
    if compact in reverse_lookup:
        return reverse_lookup[compact]
    return team.lower()


def _coerce_game(game: Dict[str, Any]) -> Dict[str, Any]:
    if "bookmakers" in game and "home_team" in game and "away_team" in game:
        return game
    raise ValueError("api_data must contain normalized game dictionaries with bookmakers, home_team, away_team, and commence_time")


def _get_market_entries(bookmaker: Dict[str, Any], market_key: str) -> List[Dict[str, Any]]:
    """Handle both raw Odds API format (markets as list) and normalized format (markets as dict)."""
    markets = bookmaker.get("markets", {})
    if isinstance(markets, dict):
        return markets.get(market_key, [])
    # Raw Odds API: markets is a list of {key, outcomes: [...]}
    for m in markets:
        if m.get("key") == market_key:
            return m.get("outcomes", [])
    return []


def _extract_consensus_market(game: Dict[str, Any], market_key: str, outcome_name: Optional[str] = None) -> Optional[float]:
    values: List[float] = []
    for bookmaker in game.get("bookmakers", []):
        for outcome in _get_market_entries(bookmaker, market_key):
            if outcome_name is None or outcome.get("name") == outcome_name:
                target = outcome.get("point") if market_key in {"spreads", "totals"} else outcome.get("price")
                if target is not None:
                    values.append(float(target))
    if not values:
        return None
    return float(np.median(values))


def _extract_best_price(game: Dict[str, Any], market_key: str, outcome_name: str) -> Optional[float]:
    prices: List[float] = []
    for bookmaker in game.get("bookmakers", []):
        for outcome in _get_market_entries(bookmaker, market_key):
            if outcome.get("name") == outcome_name and outcome.get("price") is not None:
                prices.append(float(outcome["price"]))
    if not prices:
        return None
    return max(prices)


def _to_naive_timestamp(value: Any) -> pd.Timestamp:
    ts = pd.Timestamp(value)
    return ts.tz_localize(None) if ts.tzinfo is not None else ts


def _team_feature_block(team_code: str, game_date: pd.Timestamp, team_state: Dict[str, Any], prefix: str) -> Dict[str, float]:
    state = team_state.get(team_code, {})
    last_game_date_raw = state.get("last_game_date")
    if last_game_date_raw:
        last_game_date = _to_naive_timestamp(last_game_date_raw)
        rest_days = max(min((game_date - last_game_date).days - 1, 7), 0)
    else:
        rest_days = 5

    return {
        f"{prefix}_rest_days": float(rest_days),
        f"{prefix}_margin_last1": float(state.get("margin_last1", 0.0)),
        f"{prefix}_margin_avg_3": float(state.get("margin_avg_3", 0.0)),
        f"{prefix}_margin_avg_5": float(state.get("margin_avg_5", 0.0)),
        f"{prefix}_points_for_avg_5": float(state.get("points_for_avg_5", 100.0)),
        f"{prefix}_points_against_avg_5": float(state.get("points_against_avg_5", 100.0)),
        f"{prefix}_cover_rate_5": float(state.get("cover_rate_5", 0.5)),
        f"{prefix}_cover_rate_10": float(state.get("cover_rate_10", 0.5)),
        f"{prefix}_games_played": float(state.get("games_played", 0)),
    }


def prepare_features_for_model(api_data: Iterable[Dict[str, Any]]) -> pd.DataFrame:
    artifacts = load_artifacts()
    feature_columns: List[str] = artifacts["feature_columns"]
    team_state: Dict[str, Any] = artifacts["team_state"]

    rows: List[Dict[str, Any]] = []
    for raw_game in api_data:
        game = _coerce_game(raw_game)
        game_date = _to_naive_timestamp(game["commence_time"])
        season = season_from_date(game_date)

        home_team = normalize_team_code(game["home_team"])
        away_team = normalize_team_code(game["away_team"])

        home_line = _extract_consensus_market(game, "spreads", game["home_team"])
        total_line = _extract_consensus_market(game, "totals", "Over")
        home_moneyline = _extract_best_price(game, "h2h", game["home_team"])
        away_moneyline = _extract_best_price(game, "h2h", game["away_team"])

        if home_line is None:
            home_line = 0.0
        if total_line is None:
            total_line = 220.0
        if home_moneyline is None:
            home_moneyline = -110.0
        if away_moneyline is None:
            away_moneyline = -110.0

        home_cover_prob_home = float(american_to_implied_prob(pd.Series([home_moneyline]))[0])
        home_cover_prob_away = float(american_to_implied_prob(pd.Series([away_moneyline]))[0])

        row: Dict[str, Any] = {
            "game_id": game.get("id", f"{away_team}@{home_team}:{game_date.isoformat()}"),
            "commence_time": game["commence_time"],
            "season": season,
            "month": int(game_date.month),
            "day_of_week": int(game_date.dayofweek),
            "is_playoffs": 0,
            "home_team": home_team,
            "away_team": away_team,
            "home_line": float(home_line),
            "spread_abs": abs(float(home_line)),
            "home_favorite": int(float(home_line) < 0),
            "pickem": int(float(home_line) == 0),
            "total_line": float(total_line),
            "moneyline_home": float(home_moneyline),
            "moneyline_away": float(away_moneyline),
            "implied_prob_home": home_cover_prob_home,
            "implied_prob_away": home_cover_prob_away,
            "implied_prob_gap": home_cover_prob_home - home_cover_prob_away,
            # No 2nd-half spread from live API — proxy with abs(home_line)/2
            "h2_spread_line": abs(float(home_line)) / 2.0,
        }
        row.update(_team_feature_block(home_team, game_date, team_state, "home"))
        row.update(_team_feature_block(away_team, game_date, team_state, "away"))
        row["rest_diff"] = row["home_rest_days"] - row["away_rest_days"]
        row["home_back2back"] = int(row["home_rest_days"] == 0)
        row["away_back2back"] = int(row["away_rest_days"] == 0)
        # Matchup differentials (derived from team_feature_block values)
        row["margin_avg5_diff"] = row["home_margin_avg_5"] - row["away_margin_avg_5"]
        row["pts_for_avg5_diff"] = row["home_points_for_avg_5"] - row["away_points_for_avg_5"]
        row["pts_against_avg5_diff"] = row["home_points_against_avg_5"] - row["away_points_against_avg_5"]
        row["cover_rate5_diff"] = row["home_cover_rate_5"] - row["away_cover_rate_5"]
        rows.append(row)

    frame = pd.DataFrame(rows)
    for col in feature_columns:
        if col not in frame.columns:
            frame[col] = 0.0
    frame = frame.fillna(0.0)
    # home_line is already in feature_columns — use set to avoid duplicate columns
    meta_cols = ["game_id", "commence_time", "home_team", "away_team"]
    return frame[meta_cols + feature_columns]


def predict_games(api_data: Iterable[Dict[str, Any]]) -> pd.DataFrame:
    artifacts = load_artifacts()
    model = artifacts["model"]
    feature_columns = artifacts["feature_columns"]
    features = prepare_features_for_model(api_data)
    probs = model.predict_proba(features[feature_columns])[:, 1]
    output = features[["game_id", "commence_time", "home_team", "away_team", "home_line"]].copy()
    output["home_cover_prob"] = probs
    output["away_cover_prob"] = 1 - probs
    output["pick_side"] = np.where(probs >= 0.5, "home", "away")
    output["pick_confidence"] = np.where(probs >= 0.5, probs, 1 - probs)
    output["model_version"] = MODEL_VERSION
    return output


def log_prediction(prediction: Dict[str, Any], notes: str = "", is_bet: bool = False) -> None:
    MODEL_PERFORMANCE_PATH.parent.mkdir(parents=True, exist_ok=True)
    row = {
        "logged_at": datetime.utcnow().isoformat(),
        "game_id": prediction.get("game_id"),
        "commence_time": prediction.get("commence_time"),
        "season": prediction.get("season", ""),
        "home_team": prediction.get("home_team"),
        "away_team": prediction.get("away_team"),
        "home_line": prediction.get("home_line"),
        "home_cover_prob": prediction.get("home_cover_prob"),
        "away_cover_prob": prediction.get("away_cover_prob"),
        "pick_side": prediction.get("pick_side"),
        "pick_confidence": prediction.get("pick_confidence"),
        # is_bet=1 means confidence cleared the betting threshold — treat as a real bet for ROI tracking
        "is_bet": int(is_bet),
        "model_version": prediction.get("model_version", MODEL_VERSION),
        "actual_home_covered": "",
        "result_status": "pending",
        "correct": "",
        "notes": notes,
    }
    with MODEL_PERFORMANCE_PATH.open("a", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(row.keys()))
        if fh.tell() == 0:
            writer.writeheader()
        writer.writerow(row)


def update_prediction_result(game_id: str, actual_home_covered: int, notes: str = "") -> None:
    if not MODEL_PERFORMANCE_PATH.exists():
        raise FileNotFoundError(f"Performance log not found: {MODEL_PERFORMANCE_PATH}")

    df = pd.read_csv(MODEL_PERFORMANCE_PATH)
    mask = df["game_id"].astype(str) == str(game_id)
    if not mask.any():
        raise ValueError(f"Prediction for game_id={game_id} not found in performance log")

    df.loc[mask, "actual_home_covered"] = int(actual_home_covered)
    df.loc[mask, "result_status"] = "graded"
    df.loc[mask, "correct"] = (
        ((df.loc[mask, "pick_side"] == "home") & (int(actual_home_covered) == 1))
        | ((df.loc[mask, "pick_side"] == "away") & (int(actual_home_covered) == 0))
    ).astype(int)
    if notes:
        df.loc[mask, "notes"] = notes
    df.to_csv(MODEL_PERFORMANCE_PATH, index=False)
