#!/usr/bin/env python3
"""
grade_results.py

Checks The Odds API scores endpoint for completed NBA games, matches them
against pending predictions in model_performance.csv, and grades each one.

Run this daily — it's safe to run multiple times (already-graded rows are skipped).

Usage:
    python3 -m ml.nba_spread.grade_results [--days N]

    --days N   How many days back to check for completed games (default: 3)
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
import pandas as pd
from dotenv import load_dotenv

from .inference import MODEL_PERFORMANCE_PATH, update_prediction_result

_ENV_PATH = Path(__file__).resolve().parents[2] / ".env.local"
load_dotenv(_ENV_PATH)

ODDS_API_KEY = os.getenv("ODDS_API_KEY", "")
ODDS_BASE = "https://api.the-odds-api.com/v4"
SPORT = "basketball_nba"


def fetch_scores(days_back: int = 3) -> List[Dict[str, Any]]:
    if not ODDS_API_KEY:
        raise EnvironmentError("ODDS_API_KEY not set. Add it to .env.local.")

    url = f"{ODDS_BASE}/sports/{SPORT}/scores"
    params = {
        "apiKey": ODDS_API_KEY,
        "daysFrom": str(days_back),
    }
    resp = httpx.get(url, params=params, timeout=15)

    remaining = resp.headers.get("x-requests-remaining")
    used = resp.headers.get("x-requests-used")
    if remaining:
        print(f"  [quota] {used} used / {remaining} remaining")

    if resp.status_code == 401:
        raise EnvironmentError("ODDS_API_KEY is invalid or expired.")
    if resp.status_code == 422:
        return []
    if resp.status_code == 429:
        raise RuntimeError("Odds API quota exceeded.")
    resp.raise_for_status()
    return resp.json()


def parse_score(scores_list: Optional[List[Dict[str, Any]]], team_name: str) -> Optional[int]:
    """Extract numeric score for a team from the scores array."""
    if not scores_list:
        return None
    for entry in scores_list:
        if entry.get("name") == team_name:
            try:
                return int(entry["score"])
            except (KeyError, ValueError, TypeError):
                return None
    return None


def determine_covered(home_score: int, away_score: int, home_line: float) -> Optional[int]:
    """1 if home covered, 0 if away covered, None on push."""
    cover_margin = (home_score - away_score) + home_line
    if cover_margin > 0:
        return 1
    if cover_margin < 0:
        return 0
    return None  # push — no action


def report_only() -> None:
    """Print performance summary from the local log without hitting any API."""
    print("=" * 55)
    print("  ACE — Model Performance Report")
    print(f"  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 55)
    if not MODEL_PERFORMANCE_PATH.exists():
        print("  No model_performance.csv found. Run fetch_and_predict first.")
        return
    df = pd.read_csv(MODEL_PERFORMANCE_PATH)
    _print_summary(df)


def run(days_back: int = 3) -> None:
    print("=" * 55)
    print("  ACE — Grade Pending Predictions")
    print(f"  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 55)

    if not MODEL_PERFORMANCE_PATH.exists():
        print("  No model_performance.csv found. Run fetch_and_predict first.")
        return

    log_df = pd.read_csv(MODEL_PERFORMANCE_PATH)
    pending = log_df[log_df["result_status"] == "pending"]
    print(f"  Pending predictions: {len(pending)}")

    if pending.empty:
        _print_summary(log_df)
        return

    print(f"  Fetching completed NBA scores (last {days_back} days)...")
    score_games = fetch_scores(days_back)
    completed = [g for g in score_games if g.get("completed")]
    print(f"  Found {len(completed)} completed game(s)")

    # Build lookup: game_id → score dict
    score_map: Dict[str, Dict[str, Any]] = {g["id"]: g for g in completed}

    graded = 0
    pushed = 0
    not_found = 0

    for _, pred in pending.iterrows():
        game_id = str(pred["game_id"])
        home_team = str(pred["home_team"])
        away_team = str(pred["away_team"])
        home_line = float(pred["home_line"])

        # Try direct ID match first
        game = score_map.get(game_id)

        # Fallback: match by team names (handles ID mismatches across API calls)
        if game is None:
            for g in completed:
                if _teams_match(g, home_team, away_team):
                    game = g
                    break

        if game is None:
            not_found += 1
            continue

        home_score = parse_score(game.get("scores"), game["home_team"])
        away_score = parse_score(game.get("scores"), game["away_team"])

        if home_score is None or away_score is None:
            not_found += 1
            continue

        actual = determine_covered(home_score, away_score, home_line)

        if actual is None:
            # Push — mark as void, not a win or loss
            _mark_void(game_id, home_score, away_score)
            pushed += 1
            print(f"  PUSH  {away_team} @ {home_team}  {away_score}-{home_score}  line={home_line:+.1f}")
            continue

        update_prediction_result(game_id, actual)
        graded += 1

        pick_side = str(pred["pick_side"])
        correct = (pick_side == "home" and actual == 1) or (pick_side == "away" and actual == 0)
        result_str = "WIN " if correct else "LOSS"
        print(
            f"  {result_str}  {away_team} @ {home_team}  "
            f"{away_score}-{home_score}  line={home_line:+.1f}  "
            f"pick={pick_side.upper()}  actual_covered={'HOME' if actual == 1 else 'AWAY'}"
        )

    print()
    print(f"  Graded: {graded}  Pushed: {pushed}  Not found yet: {not_found}")

    # Reload and show updated summary
    updated_df = pd.read_csv(MODEL_PERFORMANCE_PATH)
    _print_summary(updated_df)


def _teams_match(game: Dict[str, Any], home_team: str, away_team: str) -> bool:
    """Fuzzy match by last word of team name (e.g. 'Celtics' matches 'Boston Celtics')."""
    g_home = game.get("home_team", "")
    g_away = game.get("away_team", "")
    ht = home_team.split()[-1].lower()
    at = away_team.split()[-1].lower()
    return (ht in g_home.lower() and at in g_away.lower()) or (
        g_home.lower().endswith(ht) and g_away.lower().endswith(at)
    )


def _mark_void(game_id: str, home_score: int, away_score: int) -> None:
    df = pd.read_csv(MODEL_PERFORMANCE_PATH)
    mask = df["game_id"].astype(str) == str(game_id)
    df.loc[mask, "result_status"] = "push"
    df.loc[mask, "actual_home_covered"] = f"{home_score}-{away_score}"
    df.loc[mask, "correct"] = ""
    df.to_csv(MODEL_PERFORMANCE_PATH, index=False)


def _print_summary(df: pd.DataFrame) -> None:
    print()
    print("  ── Performance Summary ──────────────────────────")

    graded = df[df["result_status"] == "graded"]
    pending = df[df["result_status"] == "pending"]
    pushed = df[df["result_status"] == "push"]
    total = len(df)

    if graded.empty:
        print("  No graded predictions yet.")
        if not pending.empty:
            print(f"  {len(pending)} prediction(s) still pending.")
        return

    graded = graded.copy()
    graded["correct"] = pd.to_numeric(graded["correct"], errors="coerce")

    def _stats(subset: pd.DataFrame, label: str) -> None:
        if subset.empty:
            print(f"  {label}: no data yet")
            return
        wins = int(subset["correct"].sum())
        total_g = len(subset)
        losses = total_g - wins
        win_rate = wins / total_g
        payout = 100.0 / 110.0
        units = wins * payout + losses * (-1.0)
        roi = units / total_g
        print(f"  {label}: {total_g} graded  {wins}W/{losses}L  win={win_rate:.1%}  ROI={roi:+.2%}")

    print(f"  Total logged   : {len(df)}")
    print(f"  Graded         : {len(graded)}")
    print(f"  Pending        : {len(pending)}")
    print(f"  Pushed (void)  : {len(pushed)}")
    print()

    _stats(graded, "All predictions    ")
    if "is_bet" in graded.columns:
        bets_only = graded[pd.to_numeric(graded["is_bet"], errors="coerce") == 1]
        _stats(bets_only, "High-conf bets only")
    print(f"  (break-even at -110 is 52.4%)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=3, help="Days back to check for scores")
    parser.add_argument("--report-only", action="store_true", help="Print stats without hitting any API")
    args = parser.parse_args()

    try:
        if args.report_only:
            report_only()
        else:
            run(days_back=args.days)
    except Exception as e:
        print(f"\n  ERROR: {e}", file=sys.stderr)
        sys.exit(1)
