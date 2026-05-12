#!/usr/bin/env python3
"""
fetch_signals.py — World Cup signal detection.

Polls The Odds API for FIFA World Cup odds, de-vigs Pinnacle's 1X2 and
totals lines, then compares against soft books. Fires a signal when a soft
book's implied probability exceeds Pinnacle's by >= EDGE_THRESHOLD.

One signal per (game_id, market, bet_side) — duplicates silently ignored.

Usage:
    python3 -m ml.world_cup.fetch_signals
    python3 -m ml.world_cup.fetch_signals --snapshot-only  # no signal logging
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

import httpx
from dotenv import load_dotenv

from .signal_logger import (
    devig, init_db, log_signal, update_meta, DB_PATH,
)

_ENV_PATH = Path(__file__).resolve().parents[2] / ".env.local"
load_dotenv(_ENV_PATH)

ODDS_API_KEY = os.getenv("ODDS_API_KEY", "")
ODDS_BASE    = "https://api.the-odds-api.com/v4"

# The Odds API sport key for the FIFA World Cup 2026.
# Confirm/update at https://api.the-odds-api.com/v4/sports?apiKey=...
SPORT   = "soccer_fifa_world_cup"
MARKETS = "h2h,totals"
BOOKS   = "pinnacle,fanduel,draftkings,betmgm,williamhill_us,betrivers"

# Minimum probability edge over Pinnacle to fire a signal (decimal, e.g. 0.03 = 3pp).
EDGE_THRESHOLD = 0.03

_TZ_ET = ZoneInfo("America/New_York")
_PREFERRED_BOOKS = ("fanduel", "draftkings", "betmgm", "williamhill_us", "betrivers")


# ---------------------------------------------------------------------------
# Odds API helpers
# ---------------------------------------------------------------------------

def fetch_wc_odds() -> List[Dict[str, Any]]:
    if not ODDS_API_KEY:
        raise EnvironmentError("ODDS_API_KEY not set.")

    url = f"{ODDS_BASE}/sports/{SPORT}/odds"
    params = {
        "apiKey":      ODDS_API_KEY,
        "regions":     "us",
        "markets":     MARKETS,
        "bookmakers":  BOOKS,
        "oddsFormat":  "american",
    }
    resp = httpx.get(url, params=params, timeout=15)

    remaining = resp.headers.get("x-requests-remaining")
    used      = resp.headers.get("x-requests-used")
    if remaining:
        print(f"  [quota] {used} used / {remaining} remaining")

    if resp.status_code == 401:
        raise EnvironmentError("ODDS_API_KEY invalid or expired.")
    if resp.status_code == 422:
        return []  # sport not currently available
    if resp.status_code == 429:
        raise RuntimeError("Odds API quota exceeded.")
    resp.raise_for_status()
    return resp.json()


def fetch_wc_scores(days_back: int = 3) -> List[Dict[str, Any]]:
    if not ODDS_API_KEY:
        raise EnvironmentError("ODDS_API_KEY not set.")

    url = f"{ODDS_BASE}/sports/{SPORT}/scores"
    params = {"apiKey": ODDS_API_KEY, "daysFrom": str(days_back)}
    resp = httpx.get(url, params=params, timeout=15)

    remaining = resp.headers.get("x-requests-remaining")
    used      = resp.headers.get("x-requests-used")
    if remaining:
        print(f"  [quota] {used} used / {remaining} remaining")

    if resp.status_code in (401, 422):
        return []
    if resp.status_code == 429:
        raise RuntimeError("Odds API quota exceeded.")
    resp.raise_for_status()
    return resp.json()


def filter_upcoming(games: List[Dict[str, Any]], horizon_hours: int = 48) -> List[Dict[str, Any]]:
    """Keep only games starting within the next horizon_hours."""
    now    = datetime.now(timezone.utc)
    cutoff = now + timedelta(hours=horizon_hours)
    result = []
    for g in games:
        try:
            start = datetime.fromisoformat(g["commence_time"].replace("Z", "+00:00"))
            if now < start <= cutoff:
                result.append(g)
        except Exception:
            continue
    return result


def _et_game_date(commence_time: str) -> str:
    dt = datetime.fromisoformat(commence_time.replace("Z", "+00:00"))
    return dt.astimezone(_TZ_ET).strftime("%Y-%m-%d")


# ---------------------------------------------------------------------------
# De-vig extraction
# ---------------------------------------------------------------------------

def _extract_h2h_probs(
    bookmakers: List[Dict[str, Any]],
    book_key: str,
    home_name: str,
    away_name: str,
) -> Optional[Dict[str, float]]:
    """
    Returns de-vigged probabilities for {home, draw, away} from book_key,
    or None if the book has no h2h market for this game.
    """
    for bm in bookmakers:
        if bm["key"] != book_key:
            continue
        for market in bm.get("markets", []):
            if market["key"] != "h2h":
                continue
            outcomes = {o["name"]: float(o["price"]) for o in market.get("outcomes", [])}
            if len(outcomes) < 2:
                continue

            home_odds = outcomes.get(home_name)
            away_odds = outcomes.get(away_name)
            draw_odds = outcomes.get("Draw")

            if home_odds is None or away_odds is None:
                continue

            if draw_odds is not None:
                probs = devig([home_odds, draw_odds, away_odds])
                return {"home": probs[0], "draw": probs[1], "away": probs[2]}
            else:
                # No draw market (rare — treat as 2-way)
                probs = devig([home_odds, away_odds])
                return {"home": probs[0], "draw": 0.0, "away": probs[1]}
    return None


def _extract_h2h_odds(
    bookmakers: List[Dict[str, Any]],
    book_key: str,
    home_name: str,
    away_name: str,
) -> Optional[Dict[str, float]]:
    """Returns raw American odds {home, draw, away} (not de-vigged) for logging."""
    for bm in bookmakers:
        if bm["key"] != book_key:
            continue
        for market in bm.get("markets", []):
            if market["key"] != "h2h":
                continue
            outcomes = {o["name"]: float(o["price"]) for o in market.get("outcomes", [])}
            return {
                "home": outcomes.get(home_name, 0),
                "draw": outcomes.get("Draw", 0),
                "away": outcomes.get(away_name, 0),
            }
    return None


def _extract_totals_probs(
    bookmakers: List[Dict[str, Any]],
    book_key: str,
) -> Optional[Dict[str, Any]]:
    """
    Returns {'over_prob': float, 'under_prob': float, 'line': float, 'over_odds': float, 'under_odds': float}
    or None if book has no totals market.
    """
    for bm in bookmakers:
        if bm["key"] != book_key:
            continue
        for market in bm.get("markets", []):
            if market["key"] != "totals":
                continue
            outcomes = {o["name"]: o for o in market.get("outcomes", [])}
            over  = outcomes.get("Over")
            under = outcomes.get("Under")
            if not over or not under:
                continue
            line        = float(over.get("point", 2.5))
            over_odds   = float(over["price"])
            under_odds  = float(under["price"])
            probs       = devig([over_odds, under_odds])
            return {
                "over_prob":   probs[0],
                "under_prob":  probs[1],
                "line":        line,
                "over_odds":   over_odds,
                "under_odds":  under_odds,
            }
    return None


# ---------------------------------------------------------------------------
# Divergence detection
# ---------------------------------------------------------------------------

def _detect_h2h_divergence(
    game: Dict[str, Any],
    pin_probs: Dict[str, float],
) -> Optional[Dict[str, Any]]:
    """
    Compare each soft book's h2h probs against Pinnacle.
    Returns the single best signal (largest edge across all books × outcomes),
    or None if no edge clears the threshold.
    """
    home_name = game["home_team"]
    away_name = game["away_team"]
    best: Optional[Dict[str, Any]] = None

    for bm in game.get("bookmakers", []):
        book_key = bm["key"]
        if book_key == "pinnacle":
            continue

        soft_probs = _extract_h2h_probs(
            game["bookmakers"], book_key, home_name, away_name
        )
        soft_odds = _extract_h2h_odds(
            game["bookmakers"], book_key, home_name, away_name
        )
        if soft_probs is None or soft_odds is None:
            continue

        for side in ("home", "draw", "away"):
            edge = soft_probs[side] - pin_probs.get(side, 0.0)
            if edge < EDGE_THRESHOLD:
                continue
            if best is None or edge > best["edge_pp"]:
                best = {
                    "market":        "h2h",
                    "bet_side":      side,
                    "pinnacle_prob": pin_probs[side],
                    "book":          book_key,
                    "book_prob":     soft_probs[side],
                    "book_odds":     soft_odds[side],
                    "edge_pp":       edge,
                    "total_line":    None,
                }
    return best


def _detect_totals_divergence(
    game: Dict[str, Any],
    pin_totals: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    """
    Compare each soft book's totals probs against Pinnacle.
    Returns the single best signal or None.
    """
    best: Optional[Dict[str, Any]] = None

    for bm in game.get("bookmakers", []):
        book_key = bm["key"]
        if book_key == "pinnacle":
            continue

        soft = _extract_totals_probs(game["bookmakers"], book_key)
        if soft is None:
            continue
        # Only compare when lines match (different totals = different bet)
        if abs(soft["line"] - pin_totals["line"]) > 0.01:
            continue

        for side, prob_key, odds_key in (
            ("over",  "over_prob",  "over_odds"),
            ("under", "under_prob", "under_odds"),
        ):
            edge = soft[prob_key] - pin_totals[f"{side}_prob"]
            if edge < EDGE_THRESHOLD:
                continue
            if best is None or edge > best["edge_pp"]:
                best = {
                    "market":        "totals",
                    "bet_side":      side,
                    "pinnacle_prob": pin_totals[f"{side}_prob"],
                    "book":          book_key,
                    "book_prob":     soft[prob_key],
                    "book_odds":     soft[odds_key],
                    "edge_pp":       edge,
                    "total_line":    pin_totals["line"],
                }
    return best


# ---------------------------------------------------------------------------
# Main run
# ---------------------------------------------------------------------------

def run(snapshot_only: bool = False) -> List[Dict[str, Any]]:
    print("=" * 55)
    print("  ACE — World Cup Signal Scan")
    print(f"  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 55)

    if not ODDS_API_KEY:
        print("  ERROR: ODDS_API_KEY not set", file=sys.stderr)
        return []

    print(f"  Fetching {SPORT} odds...")
    try:
        raw_games = fetch_wc_odds()
    except RuntimeError as e:
        print(f"  ERROR: {e}", file=sys.stderr)
        sys.exit(1)

    if not raw_games:
        print(f"  No games returned — {SPORT} may not be active yet.")
        return []

    upcoming = filter_upcoming(raw_games, horizon_hours=48)
    print(f"  {len(raw_games)} total games, {len(upcoming)} upcoming (48h window)")

    if not upcoming:
        print("  No upcoming World Cup games.")
        return raw_games  # return all for worker tip-time caching

    init_db()

    signals_fired = 0
    signals_skipped = 0

    for game in upcoming:
        home_name = game["home_team"]
        away_name = game["away_team"]
        game_id   = game["id"]
        game_date = _et_game_date(game["commence_time"])

        # Extract Pinnacle probs — skip game if Pinnacle has no line
        pin_h2h = _extract_h2h_probs(
            game["bookmakers"], "pinnacle", home_name, away_name
        )
        pin_totals = _extract_totals_probs(game["bookmakers"], "pinnacle")

        if pin_h2h is None and pin_totals is None:
            continue  # no Pinnacle line — no edge reference

        if snapshot_only:
            continue

        # H2H divergence
        if pin_h2h:
            sig = _detect_h2h_divergence(game, pin_h2h)
            if sig:
                row_id = log_signal(
                    game_id       = game_id,
                    game_date     = game_date,
                    home_team     = home_name,
                    away_team     = away_name,
                    commence_time = game["commence_time"],
                    **sig,
                )
                if row_id:
                    signals_fired += 1
                    pct = sig["edge_pp"] * 100
                    print(
                        f"  [SIGNAL] {away_name} @ {home_name}  "
                        f"h2h/{sig['bet_side'].upper()}  "
                        f"pin={sig['pinnacle_prob']:.1%}  "
                        f"{sig['book']}={sig['book_prob']:.1%}  "
                        f"edge={pct:.1f}pp"
                    )
                else:
                    signals_skipped += 1

        # Totals divergence
        if pin_totals:
            sig = _detect_totals_divergence(game, pin_totals)
            if sig:
                row_id = log_signal(
                    game_id       = game_id,
                    game_date     = game_date,
                    home_team     = home_name,
                    away_team     = away_name,
                    commence_time = game["commence_time"],
                    **sig,
                )
                if row_id:
                    signals_fired += 1
                    pct = sig["edge_pp"] * 100
                    print(
                        f"  [SIGNAL] {away_name} @ {home_name}  "
                        f"totals/{sig['bet_side'].upper()} {sig['total_line']}  "
                        f"pin={sig['pinnacle_prob']:.1%}  "
                        f"{sig['book']}={sig['book_prob']:.1%}  "
                        f"edge={pct:.1f}pp"
                    )
                else:
                    signals_skipped += 1

    if not snapshot_only:
        print(f"\n  Signals fired: {signals_fired}  Skipped (dup): {signals_skipped}")

    return raw_games


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot-only", action="store_true",
                        help="Fetch odds but do not log signals")
    args = parser.parse_args()
    try:
        run(snapshot_only=args.snapshot_only)
    except Exception as e:
        print(f"\n  ERROR: {e}", file=sys.stderr)
        sys.exit(1)
