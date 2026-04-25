#!/usr/bin/env python3
"""
fetch_and_predict.py

Fetches today's upcoming NBA games from The Odds API, runs the spread model,
and logs new predictions to model_performance.csv.

Skips games that are already in the log (deduped by game_id).
Only logs games where the model confidence meets the backtest threshold (0.58).

Usage:
    python3 -m ml.nba_spread.fetch_and_predict
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
import pandas as pd
from dotenv import load_dotenv

from .inference import predict_games, log_prediction, MODEL_PERFORMANCE_PATH
from .train_spread_model import BACKTEST_METRICS_PATH

# Load ODDS_API_KEY from .env.local (same file the Next.js app uses)
_ENV_PATH = Path(__file__).resolve().parents[2] / ".env.local"
load_dotenv(_ENV_PATH)

ODDS_API_KEY = os.getenv("ODDS_API_KEY", "")
ODDS_BASE = "https://api.the-odds-api.com/v4"
SPORT = "basketball_nba"
MARKETS = "h2h,spreads,totals"
BOOKS = "fanduel,draftkings,betmgm,caesars,pointsbet"

# Minimum confidence to log a prediction (matches best backtest threshold)
CONFIDENCE_THRESHOLD = 0.58


def _load_best_threshold() -> float:
    """Pull the threshold from the last training run if available."""
    try:
        import json
        metrics = json.loads(BACKTEST_METRICS_PATH.read_text())
        return float(metrics.get("best_threshold", CONFIDENCE_THRESHOLD))
    except Exception:
        return CONFIDENCE_THRESHOLD


def fetch_nba_odds() -> List[Dict[str, Any]]:
    if not ODDS_API_KEY:
        raise EnvironmentError("ODDS_API_KEY not set. Add it to .env.local.")

    url = f"{ODDS_BASE}/sports/{SPORT}/odds"
    params = {
        "apiKey": ODDS_API_KEY,
        "regions": "us",
        "markets": MARKETS,
        "bookmakers": BOOKS,
        "oddsFormat": "american",
    }
    resp = httpx.get(url, params=params, timeout=15)

    remaining = resp.headers.get("x-requests-remaining")
    used = resp.headers.get("x-requests-used")
    if remaining:
        print(f"  [quota] {used} used / {remaining} remaining")

    if resp.status_code == 401:
        raise EnvironmentError("ODDS_API_KEY is invalid or expired.")
    if resp.status_code == 422:
        return []  # off-season
    if resp.status_code == 429:
        raise RuntimeError("Odds API quota exceeded.")
    resp.raise_for_status()
    return resp.json()


def load_logged_game_ids() -> set:
    """Return set of game_ids already in the performance log."""
    if not MODEL_PERFORMANCE_PATH.exists():
        return set()
    try:
        df = pd.read_csv(MODEL_PERFORMANCE_PATH)
        return set(df["game_id"].astype(str))
    except Exception:
        return set()


def filter_upcoming(games: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Keep only games that haven't started yet."""
    now = datetime.now(timezone.utc)
    upcoming = []
    for g in games:
        try:
            start = datetime.fromisoformat(g["commence_time"].replace("Z", "+00:00"))
            if start > now:
                upcoming.append(g)
        except Exception:
            continue
    return upcoming


def run(threshold: Optional[float] = None) -> None:
    print("=" * 55)
    print("  ACE — NBA Spread Prediction Run")
    print(f"  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 55)

    if threshold is None:
        threshold = _load_best_threshold()
    print(f"  Confidence threshold: {threshold}")

    print("  Fetching NBA odds from The Odds API...")
    raw_games = fetch_nba_odds()
    upcoming = filter_upcoming(raw_games)
    print(f"  Found {len(raw_games)} total games, {len(upcoming)} upcoming")

    if not upcoming:
        print("  No upcoming NBA games. Nothing to predict.")
        return

    already_logged = load_logged_game_ids()
    new_games = [g for g in upcoming if g.get("id") not in already_logged]
    print(f"  {len(new_games)} new (not yet logged)")

    if not new_games:
        print("  All games already logged. Nothing to add.")
        return

    print("\n  Running model predictions...")
    predictions = predict_games(new_games)

    logged = 0
    bets = 0
    print()
    for _, row in predictions.iterrows():
        conf = float(row["pick_confidence"])
        side = row["pick_side"]
        home = row["home_team"]
        away = row["away_team"]
        line = row["home_line"]
        is_bet = conf >= threshold

        log_prediction(row.to_dict(), is_bet=is_bet)
        logged += 1
        if is_bet:
            bets += 1

        direction = "HOME" if side == "home" else "AWAY"
        team = home if side == "home" else away
        flag = " *** BET" if is_bet else ""
        print(f"  LOG   {away} @ {home}  line={line:+.1f}  → {direction}  conf={conf:.3f}{flag}")

    print()
    print(f"  Logged {logged} prediction(s).  High-confidence bets: {bets} (threshold={threshold})")
    print(f"  Log file: {MODEL_PERFORMANCE_PATH}")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--threshold", type=float, default=None,
                        help="Override confidence threshold (e.g. 0.54). Defaults to value from last training run.")
    args = parser.parse_args()

    try:
        run(threshold=args.threshold)
    except Exception as e:
        print(f"\n  ERROR: {e}", file=sys.stderr)
        sys.exit(1)
