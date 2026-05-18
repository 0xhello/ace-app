#!/usr/bin/env python3
"""
fetch_signals.py — MLB signal detection.

Polls The Odds API for baseball_mlb odds, de-vigs the sharp benchmark's
2-way ML / run line / totals, and compares against soft books. Fires a
signal when a soft book's implied probability is below the sharp truth's
by >= EDGE_THRESHOLD (i.e. the soft book is offering longer odds than
fair value).

One signal per (game_id, market, bet_side) — dupes silently ignored.
Closing lines are stamped within [-15min, +5min] of kickoff to enable
CLV computation downstream.

Usage:
    python3 -m ml.mlb.fetch_signals
    python3 -m ml.mlb.fetch_signals --snapshot-only
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

import httpx
from dotenv import load_dotenv

from .signal_logger import (
    devig, init_db, log_signal, update_closing_lines,
)

_ENV_PATH = Path(__file__).resolve().parents[2] / ".env.local"
load_dotenv(_ENV_PATH)

ODDS_API_KEY = os.getenv("ODDS_API_KEY", "")
ODDS_BASE    = "https://api.the-odds-api.com/v4"

SPORT   = "baseball_mlb"
MARKETS = "h2h,spreads,totals"
BOOKS   = "pinnacle,fanduel,draftkings,betmgm,williamhill_us,betrivers"

EDGE_THRESHOLD = 0.03  # 3pp — same threshold as WC for v1; tune later from data

# Closing-line snapshot window
CLOSING_WINDOW_PRE_MIN  = 15
CLOSING_WINDOW_POST_MIN = 5

_TZ_ET = ZoneInfo("America/New_York")


# ---------------------------------------------------------------------------
# Odds API
# ---------------------------------------------------------------------------

def fetch_mlb_odds() -> List[Dict[str, Any]]:
    if not ODDS_API_KEY:
        raise EnvironmentError("ODDS_API_KEY not set.")
    resp = httpx.get(
        f"{ODDS_BASE}/sports/{SPORT}/odds",
        params={
            "apiKey":     ODDS_API_KEY,
            "regions":    "us",
            "markets":    MARKETS,
            "bookmakers": BOOKS,
            "oddsFormat": "american",
        },
        timeout=15,
    )
    remaining = resp.headers.get("x-requests-remaining")
    used      = resp.headers.get("x-requests-used")
    if remaining:
        print(f"  [quota] {used} used / {remaining} remaining")
    if resp.status_code == 401:
        raise EnvironmentError("ODDS_API_KEY invalid or expired.")
    if resp.status_code == 422:
        return []
    if resp.status_code == 429:
        raise RuntimeError("Odds API quota exceeded.")
    resp.raise_for_status()
    return resp.json()


def fetch_mlb_scores(days_back: int = 3) -> List[Dict[str, Any]]:
    if not ODDS_API_KEY:
        raise EnvironmentError("ODDS_API_KEY not set.")
    resp = httpx.get(
        f"{ODDS_BASE}/sports/{SPORT}/scores",
        params={"apiKey": ODDS_API_KEY, "daysFrom": str(days_back)},
        timeout=15,
    )
    if resp.status_code in (401, 422):
        return []
    if resp.status_code == 429:
        raise RuntimeError("Odds API quota exceeded.")
    resp.raise_for_status()
    return resp.json()


def filter_upcoming(games: List[Dict[str, Any]], horizon_hours: int = 48) -> List[Dict[str, Any]]:
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


def _is_in_closing_window(commence_time: str) -> bool:
    try:
        start = datetime.fromisoformat(commence_time.replace("Z", "+00:00"))
    except Exception:
        return False
    delta = (start - datetime.now(timezone.utc)).total_seconds()
    return -CLOSING_WINDOW_POST_MIN * 60 <= delta <= CLOSING_WINDOW_PRE_MIN * 60


# ---------------------------------------------------------------------------
# Market extraction
# ---------------------------------------------------------------------------

def _extract_h2h(
    bookmakers: List[Dict[str, Any]],
    book_key: str,
    home_name: str,
    away_name: str,
) -> Optional[Dict[str, Any]]:
    """Return {probs: {home, away}, odds: {home, away}} for the 2-way ML market."""
    for bm in bookmakers:
        if bm["key"] != book_key:
            continue
        for market in bm.get("markets", []):
            if market["key"] != "h2h":
                continue
            outcomes = {o["name"]: float(o["price"]) for o in market.get("outcomes", [])}
            home_odds = outcomes.get(home_name)
            away_odds = outcomes.get(away_name)
            if home_odds is None or away_odds is None:
                continue
            probs = devig([home_odds, away_odds])
            return {
                "probs": {"home": probs[0], "away": probs[1]},
                "odds":  {"home": home_odds, "away": away_odds},
            }
    return None


def _extract_run_line(
    bookmakers: List[Dict[str, Any]],
    book_key: str,
    home_name: str,
) -> Optional[Dict[str, Any]]:
    """Return {home_line, home_odds, away_odds, probs}. Standard MLB run line is ±1.5."""
    for bm in bookmakers:
        if bm["key"] != book_key:
            continue
        for market in bm.get("markets", []):
            if market["key"] != "spreads":
                continue
            home_line: Optional[float] = None
            home_odds: Optional[float] = None
            away_odds: Optional[float] = None
            for oc in market.get("outcomes", []):
                if oc["name"] == home_name:
                    home_line = float(oc["point"])
                    home_odds = float(oc["price"])
                else:
                    away_odds = float(oc["price"])
            if home_line is not None and home_odds is not None and away_odds is not None:
                probs = devig([home_odds, away_odds])
                return {
                    "home_line": home_line,
                    "home_odds": home_odds,
                    "away_odds": away_odds,
                    "probs":     {"home": probs[0], "away": probs[1]},
                }
    return None


def _extract_totals(
    bookmakers: List[Dict[str, Any]],
    book_key: str,
) -> Optional[Dict[str, Any]]:
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
            line       = float(over.get("point", 8.5))
            over_odds  = float(over["price"])
            under_odds = float(under["price"])
            probs      = devig([over_odds, under_odds])
            return {
                "line":       line,
                "over_odds":  over_odds,
                "under_odds": under_odds,
                "probs":      {"over": probs[0], "under": probs[1]},
            }
    return None


# ---------------------------------------------------------------------------
# Divergence detection
# ---------------------------------------------------------------------------

def _detect_h2h_divergence(
    game: Dict[str, Any],
    pin_h2h: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    """Best h2h divergence across all soft books."""
    best: Optional[Dict[str, Any]] = None
    for bm in game.get("bookmakers", []):
        if bm["key"] == "pinnacle":
            continue
        soft = _extract_h2h(game["bookmakers"], bm["key"], game["home_team"], game["away_team"])
        if soft is None:
            continue
        for side in ("home", "away"):
            edge = pin_h2h["probs"][side] - soft["probs"][side]
            if edge < EDGE_THRESHOLD:
                continue
            if best is None or edge > best["edge_pp"]:
                best = {
                    "market":        "h2h",
                    "bet_side":      side,
                    "pinnacle_prob": pin_h2h["probs"][side],
                    "book":          bm["key"],
                    "book_prob":     soft["probs"][side],
                    "book_odds":     soft["odds"][side],
                    "edge_pp":       edge,
                    "line":          None,
                }
    return best


def _detect_run_line_divergence(
    game: Dict[str, Any],
    pin_rl: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    """Best run-line divergence. Only compares same-line matchups (e.g. both -1.5)."""
    best: Optional[Dict[str, Any]] = None
    for bm in game.get("bookmakers", []):
        if bm["key"] == "pinnacle":
            continue
        soft = _extract_run_line(game["bookmakers"], bm["key"], game["home_team"])
        if soft is None or abs(soft["home_line"] - pin_rl["home_line"]) > 0.01:
            continue
        for side in ("home", "away"):
            edge = pin_rl["probs"][side] - soft["probs"][side]
            if edge < EDGE_THRESHOLD:
                continue
            if best is None or edge > best["edge_pp"]:
                best = {
                    "market":        "run_line",
                    "bet_side":      side,
                    "pinnacle_prob": pin_rl["probs"][side],
                    "book":          bm["key"],
                    "book_prob":     soft["probs"][side],
                    "book_odds":     soft["home_odds"] if side == "home" else soft["away_odds"],
                    "edge_pp":       edge,
                    "line":          pin_rl["home_line"],
                }
    return best


def _detect_totals_divergence(
    game: Dict[str, Any],
    pin_tot: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    best: Optional[Dict[str, Any]] = None
    for bm in game.get("bookmakers", []):
        if bm["key"] == "pinnacle":
            continue
        soft = _extract_totals(game["bookmakers"], bm["key"])
        if soft is None or abs(soft["line"] - pin_tot["line"]) > 0.01:
            continue
        for side in ("over", "under"):
            edge = pin_tot["probs"][side] - soft["probs"][side]
            if edge < EDGE_THRESHOLD:
                continue
            if best is None or edge > best["edge_pp"]:
                best = {
                    "market":        "totals",
                    "bet_side":      side,
                    "pinnacle_prob": pin_tot["probs"][side],
                    "book":          bm["key"],
                    "book_prob":     soft["probs"][side],
                    "book_odds":     soft["over_odds"] if side == "over" else soft["under_odds"],
                    "edge_pp":       edge,
                    "line":          pin_tot["line"],
                }
    return best


# ---------------------------------------------------------------------------
# Closing-line snapshot
# ---------------------------------------------------------------------------

def _build_closing_snapshot(
    game: Dict[str, Any],
    pin_h2h: Optional[Dict[str, Any]],
    pin_tot: Optional[Dict[str, Any]],
) -> tuple[Dict[str, float], Dict[tuple, float]]:
    """Build (pinnacle_probs_by_side, odds_by_book_side) for update_closing_lines."""
    pinnacle_probs: Dict[str, float] = {}
    if pin_h2h:
        pinnacle_probs["home"] = pin_h2h["probs"]["home"]
        pinnacle_probs["away"] = pin_h2h["probs"]["away"]
    if pin_tot:
        pinnacle_probs["over"]  = pin_tot["probs"]["over"]
        pinnacle_probs["under"] = pin_tot["probs"]["under"]

    odds_by_book_side: Dict[tuple, float] = {}
    for bm in game.get("bookmakers", []):
        book_key = bm["key"]
        h2h = _extract_h2h(game["bookmakers"], book_key, game["home_team"], game["away_team"])
        if h2h:
            odds_by_book_side[(book_key, "home")] = h2h["odds"]["home"]
            odds_by_book_side[(book_key, "away")] = h2h["odds"]["away"]
        tot = _extract_totals(game["bookmakers"], book_key)
        if tot:
            odds_by_book_side[(book_key, "over")]  = tot["over_odds"]
            odds_by_book_side[(book_key, "under")] = tot["under_odds"]
    return pinnacle_probs, odds_by_book_side


# ---------------------------------------------------------------------------
# Main run
# ---------------------------------------------------------------------------

def run(snapshot_only: bool = False) -> List[Dict[str, Any]]:
    print("=" * 55)
    print("  ACE — MLB Signal Scan")
    print(f"  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 55)

    if not ODDS_API_KEY:
        print("  ERROR: ODDS_API_KEY not set", file=sys.stderr)
        return []

    print(f"  Fetching {SPORT} odds...")
    try:
        raw_games = fetch_mlb_odds()
    except RuntimeError as e:
        print(f"  ERROR: {e}", file=sys.stderr)
        sys.exit(1)

    if not raw_games:
        print(f"  No games returned — {SPORT} may not be active.")
        return []

    upcoming = filter_upcoming(raw_games, horizon_hours=48)
    print(f"  {len(raw_games)} total games, {len(upcoming)} upcoming (48h)")

    if not upcoming:
        return raw_games

    init_db()

    signals_fired = 0
    signals_skipped = 0

    for game in upcoming:
        home_name = game["home_team"]
        away_name = game["away_team"]
        game_id   = game["id"]
        game_date = _et_game_date(game["commence_time"])

        pin_h2h = _extract_h2h(game["bookmakers"], "pinnacle", home_name, away_name)
        pin_rl  = _extract_run_line(game["bookmakers"], "pinnacle", home_name)
        pin_tot = _extract_totals(game["bookmakers"], "pinnacle")

        if pin_h2h is None and pin_rl is None and pin_tot is None:
            continue

        # Closing-line snapshot at/near kickoff
        if _is_in_closing_window(game["commence_time"]):
            pin_probs, odds_map = _build_closing_snapshot(game, pin_h2h, pin_tot)
            if pin_probs:
                n = update_closing_lines(game_id, pin_probs, odds_map)
                if n:
                    print(f"  [closing] {away_name} @ {home_name}: stamped {n}")

        if snapshot_only:
            continue

        # Right now MLB has no context module — leave reasoning empty.
        # Phase 3b will add pitcher/park/weather context and start populating this.
        reasoning_json: Optional[str] = None

        for detector, label in (
            (lambda: _detect_h2h_divergence(game, pin_h2h)        if pin_h2h else None, "ML"),
            (lambda: _detect_run_line_divergence(game, pin_rl)    if pin_rl  else None, "RL"),
            (lambda: _detect_totals_divergence(game, pin_tot)     if pin_tot else None, "TOT"),
        ):
            sig = detector()
            if not sig:
                continue
            row_id = log_signal(
                game_id        = game_id,
                game_date      = game_date,
                home_team      = home_name,
                away_team      = away_name,
                commence_time  = game["commence_time"],
                notes          = "",
                reasoning_json = reasoning_json,
                **sig,
            )
            if row_id:
                signals_fired += 1
                pct = sig["edge_pp"] * 100
                side_label = sig["bet_side"].upper()
                line_label = f" {sig['line']:+g}" if sig.get("line") is not None and sig["market"] != "totals" else (f" {sig['line']}" if sig.get("line") is not None else "")
                print(
                    f"  [SIGNAL] {away_name} @ {home_name}  "
                    f"{label}/{side_label}{line_label}  "
                    f"{sig['book']}  edge={pct:.1f}pp"
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
