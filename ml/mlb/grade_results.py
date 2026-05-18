#!/usr/bin/env python3
"""
grade_results.py — MLB signal grading.

Fetches completed game scores from The Odds API and grades any open
mlb_signals rows. Mirrors ml/world_cup/grade_results.py.

Usage:
    python3 -m ml.mlb.grade_results
    python3 -m ml.mlb.grade_results --days 5
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv

from .fetch_signals import fetch_mlb_scores, SPORT
from .signal_logger import get_open_signals, get_all_signals, grade_signal, init_db

_ENV_PATH = Path(__file__).resolve().parents[2] / ".env.local"
load_dotenv(_ENV_PATH)


def _parse_score(scores_list: Optional[List[Dict[str, Any]]], team_name: str) -> Optional[int]:
    if not scores_list:
        return None
    for entry in scores_list:
        if entry.get("name") == team_name:
            try:
                return int(entry["score"])
            except (KeyError, ValueError, TypeError):
                return None
    return None


def run(days_back: int = 3) -> None:
    print("=" * 55)
    print("  ACE — MLB Grade Results")
    print(f"  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 55)

    init_db()
    open_sigs = get_open_signals()
    print(f"  Open signals: {len(open_sigs)}")

    if not open_sigs:
        _print_summary()
        return

    print(f"  Fetching completed {SPORT} scores (last {days_back} days)...")
    try:
        score_games = fetch_mlb_scores(days_back)
    except Exception as e:
        print(f"  ERROR fetching scores: {e}", file=sys.stderr)
        sys.exit(1)

    completed = [g for g in score_games if g.get("completed")]
    print(f"  Found {len(completed)} completed game(s)")
    score_map: Dict[str, Dict[str, Any]] = {g["id"]: g for g in completed}

    graded_count = 0
    not_found    = 0
    seen: set = set()

    for sig in open_sigs:
        game_id = sig["game_id"]
        if game_id in seen:
            continue
        game = score_map.get(game_id)
        if game is None:
            for g in completed:
                if g.get("home_team") == sig["home_team"] and g.get("away_team") == sig["away_team"]:
                    game = g
                    break
        if game is None:
            not_found += 1
            continue
        seen.add(game_id)

        home_score = _parse_score(game.get("scores"), game["home_team"])
        away_score = _parse_score(game.get("scores"), game["away_team"])
        if home_score is None or away_score is None:
            not_found += 1
            continue

        results = grade_signal(game_id, home_score, away_score)
        for r in results:
            graded_count += 1
            result_str = {1: "WIN ", 0: "LOSS", None: "VOID"}.get(r["correct"], "?   ")
            print(
                f"  {result_str}  {sig['away_team']} @ {sig['home_team']}  "
                f"{away_score}-{home_score}  "
                f"{r['market']}/{r['bet_side'].upper()}  edge={r['edge_pp']*100:.1f}pp"
            )

    print(f"\n  Graded: {graded_count}  Not found yet: {not_found}")
    _print_summary()


def _print_summary() -> None:
    all_sigs = get_all_signals()
    if not all_sigs:
        print("\n  No signals logged yet.")
        return
    graded  = [s for s in all_sigs if s["status"] == "graded"]
    open_s  = [s for s in all_sigs if s["status"] == "open"]
    void_s  = [s for s in all_sigs if s["status"] == "void"]
    wins    = sum(1 for s in graded if s["correct"] == 1)
    losses  = len(graded) - wins
    win_pct = wins / len(graded) if graded else None
    payout  = 100 / 110
    roi     = (wins * payout + losses * -1) / len(graded) if graded else None

    print()
    print("  ── MLB Signal Summary ────────────────────────────")
    print(f"  Total signals : {len(all_sigs)}")
    print(f"  Open          : {len(open_s)}")
    print(f"  Graded        : {len(graded)}")
    print(f"  Void          : {len(void_s)}")
    if graded:
        print(f"  Record        : {wins}W / {losses}L  ({win_pct:.1%})  ROI {roi:+.1%}")
    for market in ("h2h", "run_line", "totals"):
        sub = [s for s in graded if s["market"] == market]
        if not sub:
            continue
        w = sum(1 for s in sub if s["correct"] == 1)
        print(f"  {market.upper():9s}     : {len(sub)} graded  {w}W/{len(sub)-w}L  ({w/len(sub):.1%})")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=3,
                        help="Days back to check for scores (default: 3)")
    args = parser.parse_args()
    try:
        run(days_back=args.days)
    except Exception as e:
        print(f"\n  ERROR: {e}", file=sys.stderr)
        sys.exit(1)
