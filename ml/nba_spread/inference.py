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
MODEL_VERSION = "nba_spread_xgb_v2"

# Columns added after initial release — all migrated in on first write if missing
_LATE_ADD_COLUMNS: Dict[str, Any] = {
    "home_injury_impact": 0.0,
    "away_injury_impact": 0.0,
    "pinnacle_prob": "",      # Pinnacle de-vigged implied probability for home covering
    "edge_vs_pinnacle": "",   # model_home_cover_prob - pinnacle_prob (our claimed edge)
}


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
        # Rolling box-score efficiency
        f"{prefix}_ortg_avg5": float(state.get("ortg_avg5", 0.0)),
        f"{prefix}_drtg_avg5": float(state.get("drtg_avg5", 0.0)),
        f"{prefix}_pace_avg5": float(state.get("pace_avg5", 0.0)),
        f"{prefix}_ts_avg5": float(state.get("ts_avg5", 0.0)),
        f"{prefix}_ortg_avg10": float(state.get("ortg_avg10", 0.0)),
        f"{prefix}_drtg_avg10": float(state.get("drtg_avg10", 0.0)),
        # Q4 / clutch
        f"{prefix}_q4_margin_avg5": float(state.get("q4_margin_avg5", 0.0)),
        f"{prefix}_q4_cover_rate5": float(state.get("q4_cover_rate5", 0.5)),
        # Travel
        f"{prefix}_miles_traveled": float(state.get("miles_traveled", 0.0)),
        f"{prefix}_tz_delta": float(state.get("tz_delta", 0.0)),
        f"{prefix}_road_trip_games": float(state.get("road_trip_games", 0.0)),
        # Venue splits
        f"{prefix}_ortg_home_avg5": float(state.get("ortg_home_avg5", 0.0)),
        f"{prefix}_ts_home_avg5": float(state.get("ts_home_avg5", 0.0)),
        f"{prefix}_ortg_away_avg5": float(state.get("ortg_away_avg5", 0.0)),
        f"{prefix}_ts_away_avg5": float(state.get("ts_away_avg5", 0.0)),
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
            "is_playoffs": int((game_date.month == 4 and game_date.day >= 16) or game_date.month in (5, 6)),
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
        # Efficiency differentials
        row["ortg_avg5_diff"]    = row["home_ortg_avg5"]  - row["away_ortg_avg5"]
        row["drtg_avg5_diff"]    = row["home_drtg_avg5"]  - row["away_drtg_avg5"]
        row["net_rtg_avg5_diff"] = (row["home_ortg_avg5"] - row["home_drtg_avg5"]) \
                                 - (row["away_ortg_avg5"] - row["away_drtg_avg5"])
        row["pace_avg5_diff"]    = row["home_pace_avg5"]  - row["away_pace_avg5"]
        # Q4 differential
        row["q4_margin_diff"]    = row["home_q4_margin_avg5"] - row["away_q4_margin_avg5"]
        # Travel differential (away disadvantage > home disadvantage)
        row["travel_diff"]       = row["away_miles_traveled"] - row["home_miles_traveled"]
        rows.append(row)

    frame = pd.DataFrame(rows)
    for col in feature_columns:
        if col not in frame.columns:
            frame[col] = 0.0
    frame = frame.fillna(0.0)
    # home_line is already in feature_columns — use set to avoid duplicate columns
    meta_cols = ["game_id", "commence_time", "home_team", "away_team", "home_line"]
    return frame[meta_cols + feature_columns]


def _american_to_prob(price: float) -> float:
    """Raw implied probability from American odds (vig included)."""
    if price < 0:
        return abs(price) / (abs(price) + 100.0)
    return 100.0 / (price + 100.0)


def _extract_pinnacle_cover_prob(game: Dict[str, Any]) -> Optional[float]:
    """
    De-vig Pinnacle's spread market juice to get a fair probability of home covering.

    Returns None when Pinnacle has no line for this game (not on the user's API plan,
    or Pinnacle hasn't posted yet). Callers must handle None gracefully.

    De-vig formula: p_fair = p_raw / (p_home_raw + p_away_raw)
    This removes the bookmaker margin and leaves the implied probability.
    """
    home_name = game.get("home_team", "")
    away_name = game.get("away_team", "")

    for bookmaker in game.get("bookmakers", []):
        if bookmaker.get("key") != "pinnacle":
            continue
        entries = _get_market_entries(bookmaker, "spreads")
        if not entries:
            return None
        home_price: Optional[float] = None
        away_price: Optional[float] = None
        for outcome in entries:
            price = outcome.get("price")
            if price is None:
                continue
            name = outcome.get("name", "")
            if name == home_name:
                home_price = float(price)
            elif name == away_name:
                away_price = float(price)
        if home_price is None or away_price is None:
            return None
        h_imp = _american_to_prob(home_price)
        a_imp = _american_to_prob(away_price)
        total = h_imp + a_imp
        if total <= 0:
            return None
        return h_imp / total
    return None


def predict_games(api_data: Iterable[Dict[str, Any]], apply_injuries: bool = True) -> pd.DataFrame:
    from .injuries import fetch_injuries, compute_team_impact, adjust_home_cover_prob

    # Materialize so we can iterate twice: once for features, once for Pinnacle extraction
    games = list(api_data)

    artifacts = load_artifacts()
    model = artifacts["model"]
    feature_columns = artifacts["feature_columns"]
    features = prepare_features_for_model(games)
    raw_probs = model.predict_proba(features[feature_columns])[:, 1]

    output = features[["game_id", "commence_time", "home_team", "away_team", "home_line"]].copy()
    output["raw_home_cover_prob"] = raw_probs

    # --- Injury adjustment (post-hoc, not a trained feature) ---
    injury_data: Dict[str, Any] = {}
    if apply_injuries:
        try:
            injury_data = fetch_injuries()
        except Exception:
            injury_data = {}

    home_impacts = []
    away_impacts = []
    adjusted_probs = []

    for i, row in output.iterrows():
        h_code = str(row["home_team"])
        a_code = str(row["away_team"])
        h_imp = compute_team_impact(h_code, injury_data) if apply_injuries else 0.0
        a_imp = compute_team_impact(a_code, injury_data) if apply_injuries else 0.0
        adj_p = adjust_home_cover_prob(float(raw_probs[output.index.get_loc(i)]), h_imp, a_imp)
        home_impacts.append(h_imp)
        away_impacts.append(a_imp)
        adjusted_probs.append(adj_p)

    adj = np.array(adjusted_probs)
    output["home_cover_prob"] = adj
    output["away_cover_prob"] = 1.0 - adj
    output["home_injury_impact"] = home_impacts
    output["away_injury_impact"] = away_impacts

    # --- Pinnacle divergence signal ---
    # Build game_id → pinnacle_prob map from original raw game dicts.
    # None means Pinnacle had no line (handled gracefully downstream).
    pinnacle_map: Dict[str, Optional[float]] = {
        g.get("id", ""): _extract_pinnacle_cover_prob(g) for g in games
    }
    # pd.to_numeric ensures None values become NaN (float64), not Python None in an
    # object column. Without this, subtracting an object column crashes with TypeError.
    output["pinnacle_prob"] = pd.to_numeric(
        output["game_id"].map(pinnacle_map), errors="coerce"
    )
    # edge > 0: model thinks home MORE likely to cover than Pinnacle
    # edge < 0: model thinks home LESS likely to cover than Pinnacle (away edge)
    # NaN propagates cleanly when pinnacle_prob is missing — no special casing needed.
    output["edge_vs_pinnacle"] = output["home_cover_prob"] - output["pinnacle_prob"]

    output["pick_side"] = np.where(adj >= 0.5, "home", "away")
    output["pick_confidence"] = np.where(adj >= 0.5, adj, 1.0 - adj)
    output["model_version"] = MODEL_VERSION
    return output


def _migrate_late_columns() -> None:
    """Add any columns from _LATE_ADD_COLUMNS that are missing from the CSV."""
    if not MODEL_PERFORMANCE_PATH.exists():
        return
    df = pd.read_csv(MODEL_PERFORMANCE_PATH)
    changed = False
    for col, default in _LATE_ADD_COLUMNS.items():
        if col not in df.columns:
            df[col] = default
            changed = True
    if changed:
        df.to_csv(MODEL_PERFORMANCE_PATH, index=False)


def log_prediction(prediction: Dict[str, Any], notes: str = "", is_bet: bool = False) -> None:
    MODEL_PERFORMANCE_PATH.parent.mkdir(parents=True, exist_ok=True)
    _migrate_late_columns()

    pinnacle_prob = prediction.get("pinnacle_prob")
    edge = prediction.get("edge_vs_pinnacle")
    # NaN from pandas becomes float('nan') in a dict — store as empty string for clean CSV
    pinnacle_prob_val = "" if pinnacle_prob is None or (isinstance(pinnacle_prob, float) and np.isnan(pinnacle_prob)) else round(float(pinnacle_prob), 5)
    edge_val = "" if edge is None or (isinstance(edge, float) and np.isnan(edge)) else round(float(edge), 5)

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
        # is_bet=1 means edge vs Pinnacle (or conf fallback) cleared the threshold
        "is_bet": int(is_bet),
        "model_version": prediction.get("model_version", MODEL_VERSION),
        "actual_home_covered": "",
        "result_status": "pending",
        "correct": "",
        "notes": notes,
        # Late-add columns at END — must stay last to match _migrate_late_columns order
        "home_injury_impact": prediction.get("home_injury_impact", 0.0),
        "away_injury_impact": prediction.get("away_injury_impact", 0.0),
        "pinnacle_prob": pinnacle_prob_val,
        "edge_vs_pinnacle": edge_val,
    }
    with MODEL_PERFORMANCE_PATH.open("a", newline="") as fh:
        if fh.tell() == 0:
            # New file: write header from dict order, which becomes the canonical order
            writer = csv.DictWriter(fh, fieldnames=list(row.keys()))
            writer.writeheader()
        else:
            # Existing file: use the CSV's own header so appended rows always align
            with MODEL_PERFORMANCE_PATH.open(newline="") as rfh:
                existing_fieldnames = next(csv.reader(rfh))
            for key in row:
                if key not in existing_fieldnames:
                    existing_fieldnames.append(key)
            writer = csv.DictWriter(fh, fieldnames=existing_fieldnames)
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
