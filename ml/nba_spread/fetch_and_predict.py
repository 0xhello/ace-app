#!/usr/bin/env python3
"""
fetch_and_predict.py

Fetches today's upcoming NBA games from The Odds API, runs the spread model,
and logs new predictions to model_performance.csv.

Also saves line snapshots on every run (morning / 6pm_proxy labels auto-detected
from ET time). In --snapshot-only mode, skips model inference entirely — useful
for the 6pm cron that records closing-line proxies.

Skips games that are already in the log (deduped by game_id).
Only logs games where the model confidence meets the backtest threshold (0.58).

Usage:
    python3 -m ml.nba_spread.fetch_and_predict
    python3 -m ml.nba_spread.fetch_and_predict --snapshot-only
    python3 -m ml.nba_spread.fetch_and_predict --snapshot-only --label 6pm_proxy
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx
import pandas as pd
from dotenv import load_dotenv

from .inference import predict_games, log_prediction, MODEL_PERFORMANCE_PATH
from .signal_logger import (
    save_snapshot, record_closing_proxy, detect_line_movements,
    get_signal_execution_source,
)
from .train_spread_model import BACKTEST_METRICS_PATH

# Load ODDS_API_KEY from .env.local (same file the Next.js app uses)
_ENV_PATH = Path(__file__).resolve().parents[2] / ".env.local"
load_dotenv(_ENV_PATH)

ODDS_API_KEY = os.getenv("ODDS_API_KEY", "")
ODDS_BASE = "https://api.the-odds-api.com/v4"
SPORT = "basketball_nba"
MARKETS = "h2h,spreads,totals"
# Pinnacle is listed first — it's the sharp reference line for edge calculation.
# If the user's API plan doesn't include Pinnacle, it simply won't appear in responses
# and we fall back to the confidence threshold. No crash, no silent wrong answer.
BOOKS = "pinnacle,fanduel,draftkings,betmgm,caesars,pointsbet"

# Fallback confidence threshold when Pinnacle has no line for a game
CONFIDENCE_THRESHOLD = 0.58
# Minimum divergence from Pinnacle's de-vigged probability to count as a bet.
# 0.04 = model must disagree with Pinnacle by ≥4 percentage points in our pick's direction.
EDGE_THRESHOLD = 0.04


_PREFERRED_BOOKS = ("pinnacle", "fanduel", "draftkings", "betmgm", "caesars")

# UTC-5 conservative ET offset (treats EDT as EST).
# Keeps all NBA games — including 10pm ET tipoffs (02:00 UTC next day) —
# on the correct calendar date. Off by 1hr during DST but consistent
# with _snapshot_label() and safe for all realistic game times.
_ET_OFFSET = timedelta(hours=5)


def _et_game_date(commence_time: str) -> str:
    """Return the ET calendar date for a UTC ISO commence_time string."""
    dt = datetime.fromisoformat(commence_time.replace("Z", "+00:00"))
    return (dt - _ET_OFFSET).strftime("%Y-%m-%d")


def _et_today() -> str:
    """Return today's date in ET (used for detect_line_movements default)."""
    return (datetime.now(timezone.utc) - _ET_OFFSET).strftime("%Y-%m-%d")


def _extract_spread(
    game: Dict[str, Any],
    preferred_book: Optional[str] = None,
) -> Tuple[Optional[float], Optional[float], Optional[str]]:
    """
    Pull home_line, over_under, and book_key from a raw Odds API game object.

    Tries preferred_book first (if given), then falls back through
    _PREFERRED_BOOKS order (Pinnacle → FanDuel → DraftKings → …).
    Returns (None, None, None) if no spread market found.
    """
    order = list(_PREFERRED_BOOKS)
    if preferred_book and preferred_book in order:
        order.remove(preferred_book)
        order.insert(0, preferred_book)

    for book_key in order:
        for bm in game.get("bookmakers", []):
            if bm["key"] != book_key:
                continue
            for market in bm.get("markets", []):
                if market["key"] == "spreads":
                    home_name = game["home_team"]
                    home_line: Optional[float] = None
                    for oc in market["outcomes"]:
                        if oc["name"] == home_name:
                            home_line = float(oc["point"])
                            break
                    ou: Optional[float] = None
                    for tm in bm.get("markets", []):
                        if tm["key"] == "totals" and tm["outcomes"]:
                            ou = float(tm["outcomes"][0]["point"])
                            break
                    if home_line is not None:
                        return home_line, ou, book_key
    return None, None, None


def _snapshot_label(override: Optional[str] = None) -> str:
    """
    Auto-detect snapshot label from current ET time.
    ET = UTC-5 (EST) / UTC-4 (EDT); we use UTC-5 as a conservative constant
    since this is just a label, not a strict timezone conversion.
    """
    if override:
        return override
    et_hour = (datetime.now(timezone.utc).hour - 5) % 24
    if et_hour >= 18:
        return "6pm_proxy"
    if et_hour >= 12:
        return "afternoon"
    return "morning"


def _save_snapshots(upcoming: List[Dict[str, Any]], label: str) -> int:
    """Save a line_snapshots row for each upcoming game. Returns count saved."""
    saved = 0
    for game in upcoming:
        home_line, ou, book = _extract_spread(game)
        if home_line is None:
            continue
        game_date = _et_game_date(game["commence_time"])
        save_snapshot(
            game_id=game["id"],
            game_date=game_date,
            home_team=game["home_team"],
            away_team=game["away_team"],
            home_line=home_line,
            snapshot_label=label,
            over_under=ou,
            book=book or "unknown",
            source="odds_api",
        )
        saved += 1
    return saved


def _record_closing_proxies(upcoming: List[Dict[str, Any]], force: bool = False) -> int:
    """
    For every open signal whose game_id is in the current odds fetch,
    record the current spread as the closing-line proxy.

    force=True — used by the pregame cron to overwrite the 6pm_proxy line
                 with a truer closing number captured closer to tip-off.
    """
    updated_total = 0
    for game in upcoming:
        game_id = game["id"]
        preferred = get_signal_execution_source(game_id)
        home_line, _, book = _extract_spread(game, preferred_book=preferred)
        if home_line is None:
            continue
        if preferred and book != preferred:
            source = f"{book}_fallback"
        else:
            source = book or "odds_api_6pm_proxy"
        updated_total += record_closing_proxy(
            game_id=game_id,
            closing_line=home_line,
            source=source,
            force=force,
        )
    return updated_total


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


def run(
    threshold: Optional[float] = None,
    snapshot_only: bool = False,
    label_override: Optional[str] = None,
) -> None:
    print("=" * 55)
    if snapshot_only:
        print("  ACE — NBA Odds Snapshot Run")
    else:
        print("  ACE — NBA Spread Prediction Run")
    print(f"  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 55)

    print("  Fetching NBA odds from The Odds API...")
    raw_games = fetch_nba_odds()
    upcoming = filter_upcoming(raw_games)
    print(f"  Found {len(raw_games)} total games, {len(upcoming)} upcoming")

    if not upcoming:
        print("  No upcoming NBA games. Exiting.")
        return

    # Always save snapshots — morning run gets 'morning', 6pm run gets '6pm_proxy'
    label = _snapshot_label(label_override)
    n_saved = _save_snapshots(upcoming, label)
    print(f"  Snapshots saved: {n_saved} games  (label={label!r})")

    # On 6pm_proxy / pregame runs: stamp open signals with closing line proxy.
    # pregame uses force=True to overwrite the 6pm_proxy line with a truer close.
    # detect_line_movements only fires on 6pm_proxy (movements already decided by then).
    if label in ("6pm_proxy", "pregame"):
        n_updated = _record_closing_proxies(upcoming, force=(label == "pregame"))
        if n_updated:
            print(f"  Closing proxies recorded: {n_updated} signal row(s) updated")

    if label == "6pm_proxy":
        new_signals = detect_line_movements(game_date=_et_today())
        if new_signals:
            print(f"  Line movement signals auto-logged: {len(new_signals)}")
            for s in new_signals:
                print(
                    f"    #{s['id']}  {s['away_team']} @ {s['home_team']}  "
                    f"{s['morning_line']:+.1f} → {s['proxy_line']:+.1f}  "
                    f"({s['movement']:+.1f} pts)  bet={s['bet_side'].upper()}"
                )

    if snapshot_only:
        return

    if threshold is None:
        threshold = _load_best_threshold()
    print(f"  Confidence threshold: {threshold}")

    already_logged = load_logged_game_ids()
    new_games = [g for g in upcoming if g.get("id") not in already_logged]
    print(f"  {len(new_games)} new (not yet logged)")

    if not new_games:
        print("  All games already logged. Nothing to add.")
        return

    print("\n  Running model predictions (with injury adjustments)...")
    predictions = predict_games(new_games, apply_injuries=True)

    logged = 0
    bets = 0
    print()
    for _, row in predictions.iterrows():
        conf = float(row["pick_confidence"])
        side = str(row["pick_side"])
        home = row["home_team"]
        away = row["away_team"]
        line = row["home_line"]
        h_imp = float(row.get("home_injury_impact", 0.0))
        a_imp = float(row.get("away_injury_impact", 0.0))

        raw_edge = row.get("edge_vs_pinnacle")
        # pd.isna handles None, float('nan'), numpy.nan, and pd.NA uniformly
        has_pinnacle = raw_edge is not None and not pd.isna(raw_edge)

        if has_pinnacle:
            edge = float(raw_edge)
            # Only bet when our pick direction matches the divergence direction:
            # home pick requires edge > 0 (we think home more likely than Pinnacle)
            # away pick requires edge < 0 (we think away more likely than Pinnacle)
            direction_consistent = (side == "home" and edge > 0) or (side == "away" and edge < 0)
            is_bet = direction_consistent and abs(edge) >= EDGE_THRESHOLD
        else:
            # Pinnacle not available — fall back to raw confidence threshold
            edge = None
            is_bet = conf >= threshold

        log_prediction(row.to_dict(), is_bet=is_bet, threshold_used=threshold)
        logged += 1
        if is_bet:
            bets += 1

        direction = "HOME" if side == "home" else "AWAY"
        flag = " *** BET" if is_bet else ""
        inj_note = ""
        if h_imp > 0 or a_imp > 0:
            inj_note = f"  inj=H:{h_imp:.2f}/A:{a_imp:.2f}"
        edge_note = f"  edge={edge:+.3f}" if edge is not None else "  edge=n/a"
        print(f"  LOG   {away} @ {home}  line={line:+.1f}  → {direction}  conf={conf:.3f}{edge_note}{flag}{inj_note}")

    print()
    print(f"  Logged {logged} prediction(s).  High-confidence bets: {bets} (threshold={threshold})")
    print(f"  Log file: {MODEL_PERFORMANCE_PATH}")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--threshold", type=float, default=None,
                        help="Override confidence threshold (e.g. 0.54). Defaults to value from last training run.")
    parser.add_argument("--snapshot-only", action="store_true",
                        help="Save line snapshots and closing proxies without running model inference.")
    parser.add_argument("--label", type=str, default=None,
                        help="Override snapshot label (morning|afternoon|6pm_proxy). Auto-detected from ET time if omitted.")
    args = parser.parse_args()

    try:
        run(threshold=args.threshold, snapshot_only=args.snapshot_only, label_override=args.label)
    except Exception as e:
        print(f"\n  ERROR: {e}", file=sys.stderr)
        sys.exit(1)
