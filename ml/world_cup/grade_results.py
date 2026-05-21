#!/usr/bin/env python3
"""
grade_results.py — soccer signal grading (multi-tournament).

Fetches completed game scores from The Odds API for every soccer
competition we have open signals on (WC + EPL + La Liga + Bundesliga +
Serie A + Ligue 1 + UCL) and grades any open soccer_signals rows.

Why multi-tournament:
  Before Phase 2.1, soccer_signals only held FIFA World Cup rows, so a
  single fetch_wc_scores() call was enough. After 2.1, club-league rows
  appear in the same table (tagged via `tournament`). A WC-only fetch
  would leave EPL / La Liga / etc. signals open forever even after their
  games finished. This grader walks unique sport keys derived from each
  open signal's tournament and calls the scores endpoint per key.

Usage:
    python3 -m ml.world_cup.grade_results
    python3 -m ml.world_cup.grade_results --days 5
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
from dotenv import load_dotenv

from .fetch_signals import fetch_scores_for_sport, SPORT
from .signal_logger import get_open_signals, get_all_signals, grade_signal, init_db, DB_PATH

# Maps the `tournament` column on soccer_signals to its Odds API sport key.
# Mirrors ml/soccer/leagues.LEAGUES — keep in sync when leagues are added.
# Unknown tournament labels fall through to FIFA World Cup as a safe default
# (preserves pre-2.1 behavior).
TOURNAMENT_TO_SPORT_KEY: Dict[str, str] = {
    "FIFA World Cup":  "soccer_fifa_world_cup",
    "Premier League":  "soccer_epl",
    "La Liga":         "soccer_spain_la_liga",
    "Bundesliga":      "soccer_germany_bundesliga",
    "Serie A":         "soccer_italy_serie_a",
    "Ligue 1":         "soccer_france_ligue_one",
    "UCL":             "soccer_uefa_champs_league",
}


def _sport_key_for(tournament: Optional[str]) -> str:
    """Return the Odds API sport key for a tournament label."""
    if not tournament:
        return "soccer_fifa_world_cup"  # legacy default
    return TOURNAMENT_TO_SPORT_KEY.get(tournament, "soccer_fifa_world_cup")

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
    print("  ACE — Soccer Grade Results (multi-tournament)")
    print(f"  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 55)

    init_db()
    open_sigs = get_open_signals()
    print(f"  Open signals: {len(open_sigs)}")

    if not open_sigs:
        _print_summary()
        return

    # Group open signals by the sport key derived from their tournament
    # column. Each unique sport key gets one scores call. Defensive: when
    # the column is null (legacy rows) we route to WC.
    sigs_by_sport: Dict[str, List[Any]] = {}
    for sig in open_sigs:
        sport_key = _sport_key_for(sig.get("tournament"))
        sigs_by_sport.setdefault(sport_key, []).append(sig)

    print(f"  Open signals span {len(sigs_by_sport)} sport key(s): "
          f"{', '.join(sigs_by_sport.keys())}")

    # Fetch scores per sport key, combine into a unified score map.
    # Track which signals belong to each fetch so a missing Odds API
    # response for one sport doesn't sink the others.
    score_map_by_sport: Dict[str, Dict[str, Dict[str, Any]]] = {}
    for sport_key in sigs_by_sport:
        try:
            score_games = fetch_scores_for_sport(sport_key, days_back)
        except Exception as e:
            print(f"  ERROR fetching {sport_key} scores: {e}", file=sys.stderr)
            score_map_by_sport[sport_key] = {}
            continue
        completed = [g for g in score_games if g.get("completed")]
        score_map_by_sport[sport_key] = {g["id"]: g for g in completed}
        print(f"  {sport_key}: {len(completed)} completed game(s)")

    graded_count = 0
    not_found    = 0
    # Deduplicate by game_id — grade each game only once even if multiple
    # signals reference it.
    seen_game_ids: set = set()

    for sport_key, sigs in sigs_by_sport.items():
        score_map = score_map_by_sport.get(sport_key, {})
        completed_list = list(score_map.values())

        for sig in sigs:
            game_id   = sig["game_id"]
            home_team = sig["home_team"]
            away_team = sig["away_team"]

            if game_id in seen_game_ids:
                continue

            game = score_map.get(game_id)

            # Fallback: team-name match within the same sport's completed
            # list when the Odds API game_id doesn't match (rare but happens
            # when WC scrapes use a different id than odds).
            if game is None:
                for g in completed_list:
                    if g.get("home_team") == home_team and g.get("away_team") == away_team:
                        game = g
                        break

            if game is None:
                not_found += 1
                continue

            seen_game_ids.add(game_id)

            home_score = _parse_score(game.get("scores"), game["home_team"])
            away_score = _parse_score(game.get("scores"), game["away_team"])

            if home_score is None or away_score is None:
                not_found += 1
                continue

            results = grade_signal(game_id, home_score, away_score)
            for r in results:
                graded_count += 1
                result_str = {1: "WIN ", 0: "LOSS", None: "VOID"}.get(r["correct"], "?   ")
                market_str = f"{r['market']}/{r['bet_side'].upper()}"
                # Player-prop rows don't have edge_pp populated the same way
                # (it's prior_prob - book_prob, stored in edge_pp on the
                # logger side). Format defensively.
                edge_str = f"edge={r['edge_pp']*100:.1f}pp" if r.get("edge_pp") is not None else ""
                print(
                    f"  {result_str}  {away_team} @ {home_team}  "
                    f"{away_score}-{home_score}  "
                    f"{market_str}  {edge_str}".rstrip()
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
    # Soccer signals typically bet at ~-110 equivalent
    payout  = 100 / 110
    roi     = (wins * payout + losses * -1) / len(graded) if graded else None

    print()
    print("  ── World Cup Signal Summary ─────────────────────")
    print(f"  Total signals : {len(all_sigs)}")
    print(f"  Open          : {len(open_s)}")
    print(f"  Graded        : {len(graded)}")
    print(f"  Void          : {len(void_s)}")
    if graded:
        print(f"  Record        : {wins}W / {losses}L  ({win_pct:.1%})  ROI {roi:+.1%}")

    # Break down by market
    for market in ("h2h", "totals"):
        sub = [s for s in graded if s["market"] == market]
        if not sub:
            continue
        w = sum(1 for s in sub if s["correct"] == 1)
        print(f"  {market.upper():8s}      : {len(sub)} graded  {w}W/{len(sub)-w}L  ({w/len(sub):.1%})")


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
