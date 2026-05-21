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
    devig, init_db, log_signal, log_player_prop_signal, update_closing_lines,
)
from .context import get_game_context

# Window around kickoff in which we treat the current odds as "closing".
# Worker polls every ~60s near kickoff, so a 15-min pre / 5-min post window
# guarantees at least one snapshot lands per game.
CLOSING_WINDOW_PRE_MIN  = 15
CLOSING_WINDOW_POST_MIN = 5

_ENV_PATH = Path(__file__).resolve().parents[2] / ".env.local"
load_dotenv(_ENV_PATH)

ODDS_API_KEY = os.getenv("ODDS_API_KEY", "")
ODDS_BASE    = "https://api.the-odds-api.com/v4"

# The Odds API sport key for the FIFA World Cup 2026.
# Confirm/update at https://api.the-odds-api.com/v4/sports?apiKey=...
SPORT   = "soccer_fifa_world_cup"
# h2h = 1X2, spreads = Asian Handicap (best 2-way market), totals = goal over/under
MARKETS = "h2h,spreads,totals"
BOOKS   = "pinnacle,fanduel,draftkings,betmgm,williamhill_us,betrivers"

# Minimum probability edge over Pinnacle (game-level) or over our prior (player
# props) to fire a signal — decimal, e.g. 0.03 = 3pp.
EDGE_THRESHOLD = 0.03

# Player-prop markets we scan when they're posted on Odds API. Each market is
# 1 credit per call, so we don't add them to MARKETS unconditionally — they
# only get pulled when the daily market probe has detected the markets going
# live (sets meta key wc:player_props_first_seen_at). Env var still works as
# an emergency override / kill-switch.
PLAYER_PROP_MARKETS = "player_goal_scorer_anytime"


def _player_props_enabled() -> bool:
    """Auto-flip: True when the daily market probe has seen
    player_goal_scorer_anytime live on Odds API at least once.

    Falls back to env var WC_PLAYER_PROPS_ENABLED for manual override
    (force-on for testing, or force-off to kill-switch the scan if it's
    misbehaving). Env trumps meta-key when explicitly set.
    """
    env = os.getenv("WC_PLAYER_PROPS_ENABLED", "").lower()
    if env in ("1", "true", "yes"):
        return True
    if env in ("0", "false", "no"):
        return False
    # Default: read the meta key set by market_probe._detect_market_flips
    try:
        from .market_probe import is_player_props_live
        return is_player_props_live()
    except Exception:
        return False

_TZ_ET = ZoneInfo("America/New_York")
_PREFERRED_BOOKS = ("fanduel", "draftkings", "betmgm", "williamhill_us", "betrivers")


# ---------------------------------------------------------------------------
# Odds API helpers
# ---------------------------------------------------------------------------

def fetch_wc_odds() -> List[Dict[str, Any]]:
    # Read-through Upstash Redis cache populated by the Next.js dashboard.
    # When a user just viewed the board within the last ~25 min, the same
    # response is already cached and we pay zero credits.
    from ml.common.odds_cache import try_get_odds
    cached = try_get_odds("__raw_odds_wc__")
    if cached is not None:
        return cached

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
    try:
        from ml.common.odds_cache import write_quota
        write_quota(remaining, used, resp.headers.get("x-requests-last"),
                    source="python-wc", endpoint=f"/sports/{SPORT}/odds")
    except Exception:
        pass

    if resp.status_code == 401:
        raise EnvironmentError("ODDS_API_KEY invalid or expired.")
    if resp.status_code == 422:
        return []  # sport not currently available
    if resp.status_code == 429:
        raise RuntimeError("Odds API quota exceeded.")
    resp.raise_for_status()
    return resp.json()


def fetch_wc_player_props() -> List[Dict[str, Any]]:
    """Pull player-prop markets for WC. Separate call from fetch_wc_odds()
    because player markets are 1 credit per market specified — keeping them
    out of the main fetch lets us flip them on (via WC_PLAYER_PROPS_ENABLED)
    only when they're actually posted.

    Returns the same Odds API event shape, with bookmakers[].markets[] now
    containing player_goal_scorer_anytime outcomes when live.
    """
    if not _player_props_enabled():
        return []  # markets not yet detected as live — keep credit spend at zero
    if not ODDS_API_KEY:
        raise EnvironmentError("ODDS_API_KEY not set.")

    url = f"{ODDS_BASE}/sports/{SPORT}/odds"
    params = {
        "apiKey":      ODDS_API_KEY,
        "regions":     "us",
        "markets":     PLAYER_PROP_MARKETS,
        "bookmakers":  BOOKS,
        "oddsFormat":  "american",
    }
    resp = httpx.get(url, params=params, timeout=15)

    remaining = resp.headers.get("x-requests-remaining")
    used      = resp.headers.get("x-requests-used")
    if remaining:
        print(f"  [quota] {used} used / {remaining} remaining (player props)")
    try:
        from ml.common.odds_cache import write_quota
        write_quota(remaining, used, resp.headers.get("x-requests-last"),
                    source="python-wc", endpoint=f"/sports/{SPORT}/odds [player_props]")
    except Exception:
        pass

    if resp.status_code in (401, 422):
        return []  # off-season / not posted yet
    if resp.status_code == 429:
        raise RuntimeError("Odds API quota exceeded.")
    resp.raise_for_status()
    return resp.json()


def fetch_scores_for_sport(sport_key: str, days_back: int = 3) -> List[Dict[str, Any]]:
    """Pull completed-game scores for any soccer sport key on Odds API.

    Used by grade_results to grade signals across multiple competitions
    (WC + EPL + La Liga + Bundesliga + Serie A + Ligue 1 + UCL) — the
    grader walks unique sport keys derived from each signal's
    `tournament` column and calls this once per key.

    Returns [] on 422 (off-season) or 401, raises on 429 (so the worker
    can back off cleanly).
    """
    if not ODDS_API_KEY:
        raise EnvironmentError("ODDS_API_KEY not set.")
    url = f"{ODDS_BASE}/sports/{sport_key}/scores"
    params = {"apiKey": ODDS_API_KEY, "daysFrom": str(days_back)}
    resp = httpx.get(url, params=params, timeout=15)
    remaining = resp.headers.get("x-requests-remaining")
    used      = resp.headers.get("x-requests-used")
    if remaining:
        print(f"  [quota] ({sport_key}/scores) {used} used / {remaining} remaining")
    if resp.status_code in (401, 422):
        return []
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


def _american_to_implied_prob(american: float) -> float:
    """Convert American odds to raw implied probability (with vig)."""
    if american > 0:
        return 100.0 / (american + 100.0)
    return -american / (-american + 100.0)


def _detect_player_prop_signals(
    game: Dict[str, Any],
    expected_team_goals: float = 1.40,
) -> List[Dict[str, Any]]:
    """For each player_goal_scorer_anytime outcome in this game's
    bookmaker data, compute our prior P(scores) and compare to the
    soft-book implied probability. Fire a signal when our prior exceeds
    the book by >= EDGE_THRESHOLD.

    Returns a list of signal dicts ready to feed to log_player_prop_signal.
    Empty list if no player markets are present or no edges exceed threshold.
    """
    # Import inside function to avoid a hard dep on players.py when only
    # game-level scans are running (e.g. in tests that don't touch priors).
    from .players import find_wc_player, compute_goalscorer_prior

    signals: List[Dict[str, Any]] = []

    for bm in game.get("bookmakers") or []:
        book = bm.get("key") or ""
        if book == "pinnacle":
            continue  # Pinnacle is our future sharp anchor; not a soft book to bet at
        if book not in _PREFERRED_BOOKS:
            continue

        for mkt in bm.get("markets") or []:
            if mkt.get("key") != "player_goal_scorer_anytime":
                continue

            # The "Yes" outcomes carry one row per player. "No" rows tell
            # us the de-vig pair but we focus on Yes for v1 (signal == we
            # think the player scores more often than the book implies).
            for outcome in mkt.get("outcomes") or []:
                # Odds API encodes anytime markets as outcome.name == "Yes"
                # with the player in outcome.description. Some books flip
                # this; defend against both.
                player_name_raw = (
                    outcome.get("description")
                    or (outcome.get("name") if outcome.get("name") not in ("Yes", "No") else None)
                )
                if not player_name_raw or outcome.get("name") == "No":
                    continue
                price = outcome.get("price")
                if price is None:
                    continue

                # Resolve to our wc_players row (with canonical-name handling)
                wc_player = find_wc_player(player_name_raw)
                if not wc_player:
                    continue  # we don't know this player → can't form a prior
                pid = wc_player.get("api_player_id")
                if pid is None:
                    continue

                # Compute the prior for this matchup. expected_team_goals
                # could be derived from the totals line; for v1 we use the
                # baseline 1.40 (international tournament average).
                prior = compute_goalscorer_prior(
                    api_player_id                   = pid,
                    expected_match_goals_for_team   = expected_team_goals,
                    assumed_minutes                 = 70,
                )
                if prior is None:
                    continue  # insufficient sample for this player
                prior_prob = prior.get("anytime_scorer_prob")
                if prior_prob is None:
                    continue

                book_prob = _american_to_implied_prob(float(price))
                edge_pp = prior_prob - book_prob
                if edge_pp < EDGE_THRESHOLD:
                    continue  # not enough edge to act on

                signals.append({
                    "market":         "player_goal_scorer_anytime",
                    "bet_side":       "yes",
                    "player_name":    prior.get("player_name") or player_name_raw,
                    "api_player_id":  pid,
                    "prior_prob":     prior_prob,
                    "book":           book,
                    "book_prob":      book_prob,
                    "book_odds":      float(price),
                    "edge_pp":        edge_pp,
                })

    return signals


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


def _is_in_closing_window(commence_time: str) -> bool:
    """True when commence_time is within the closing-line snapshot window:
    from CLOSING_WINDOW_PRE_MIN before kickoff to CLOSING_WINDOW_POST_MIN after.
    """
    try:
        start = datetime.fromisoformat(commence_time.replace("Z", "+00:00"))
    except Exception:
        return False
    delta = (start - datetime.now(timezone.utc)).total_seconds()
    return -CLOSING_WINDOW_POST_MIN * 60 <= delta <= CLOSING_WINDOW_PRE_MIN * 60


def _build_closing_snapshot(
    game: Dict[str, Any],
    pin_h2h:    Optional[Dict[str, float]],
    pin_totals: Optional[Dict[str, Any]],
) -> tuple[Dict[str, float], Dict[tuple, float]]:
    """
    Build the two dicts update_closing_lines() expects from the current
    Odds API snapshot for one game:

      pinnacle_probs_by_side: per-side sharp truth probability (de-vigged)
      book_odds_by_side_book: per-(book, side) current American odds

    Covers h2h ('home'/'draw'/'away') and totals ('over'/'under'). AH/spreads
    are intentionally omitted — closing-line CLV for AH is line-based, not
    prob-based, and we'd need a different math path. Punt for now.
    """
    home_name = game["home_team"]
    away_name = game["away_team"]

    pinnacle_probs: Dict[str, float] = {}
    if pin_h2h:
        pinnacle_probs.update({
            "home": pin_h2h.get("home", 0.0),
            "draw": pin_h2h.get("draw", 0.0),
            "away": pin_h2h.get("away", 0.0),
        })
    if pin_totals:
        pinnacle_probs.update({
            "over":  pin_totals.get("over_prob",  0.0),
            "under": pin_totals.get("under_prob", 0.0),
        })

    odds_by_book_side: Dict[tuple, float] = {}
    for bm in game.get("bookmakers", []):
        book_key = bm["key"]
        h2h_odds = _extract_h2h_odds(game["bookmakers"], book_key, home_name, away_name)
        if h2h_odds:
            for side in ("home", "draw", "away"):
                if h2h_odds.get(side):
                    odds_by_book_side[(book_key, side)] = h2h_odds[side]
        tot = _extract_totals_probs(game["bookmakers"], book_key)
        if tot:
            odds_by_book_side[(book_key, "over")]  = tot["over_odds"]
            odds_by_book_side[(book_key, "under")] = tot["under_odds"]

    return pinnacle_probs, odds_by_book_side


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
# Asian Handicap extraction
# ---------------------------------------------------------------------------

def _extract_ah_line(
    bookmakers: List[Dict[str, Any]],
    book_key: str,
    home_name: str,
) -> Optional[Dict[str, Any]]:
    """
    Returns {'home_line': float, 'home_odds': float, 'away_odds': float}
    for the spreads (Asian Handicap) market, or None if not available.
    home_line convention: negative = home favored (same as NBA).
    """
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
                return {"home_line": home_line, "home_odds": home_odds, "away_odds": away_odds}
    return None


def _detect_ah_divergence(
    game: Dict[str, Any],
    pin_ah: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    """
    Asian Handicap divergence: compare soft book's AH line against Pinnacle's.
    Fires when a soft book gives a meaningfully different line (same as NBA spreads logic).
    Threshold: 0.5 points difference (half-ball AH units).
    """
    home_name = game["home_team"]
    pin_line  = pin_ah["home_line"]
    best: Optional[Dict[str, Any]] = None
    AH_DIVERGENCE_MIN = 0.5  # half a goal = meaningful in AH

    for bm in game.get("bookmakers", []):
        book_key = bm["key"]
        if book_key == "pinnacle":
            continue

        soft = _extract_ah_line(game["bookmakers"], book_key, home_name)
        if soft is None:
            continue

        divergence = soft["home_line"] - pin_line  # positive → soft book is more generous to home bettors
        if abs(divergence) < AH_DIVERGENCE_MIN:
            continue

        bet_side = "home" if divergence > 0 else "away"
        # De-vig to get edge in probability terms for storage
        pin_probs  = devig([pin_ah["home_odds"], pin_ah["away_odds"]])
        soft_probs = devig([soft["home_odds"],   soft["away_odds"]])
        idx        = 0 if bet_side == "home" else 1
        edge_pp    = pin_probs[idx] - soft_probs[idx]

        if best is None or abs(divergence) > abs(best.get("_raw_div", 0)):
            best = {
                "market":        "asian_handicap",
                "bet_side":      bet_side,
                "pinnacle_prob": pin_probs[idx],
                "book":          book_key,
                "book_prob":     soft_probs[idx],
                "book_odds":     soft["home_odds"] if bet_side == "home" else soft["away_odds"],
                "edge_pp":       edge_pp,
                "total_line":    pin_line,  # store the Pinnacle AH line
                "_raw_div":      divergence,
            }

    if best:
        best.pop("_raw_div", None)
    return best


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
            # Pinnacle prob > soft book prob → soft book has longer odds on this
            # outcome than the sharp reference → value betting it at the soft book.
            edge = pin_probs.get(side, 0.0) - soft_probs[side]
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
            edge = pin_totals[f"{side}_prob"] - soft[prob_key]
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

        # Extract Pinnacle reference lines — skip game if Pinnacle has nothing
        pin_h2h    = _extract_h2h_probs(game["bookmakers"], "pinnacle", home_name, away_name)
        pin_ah     = _extract_ah_line(game["bookmakers"], "pinnacle", home_name)
        pin_totals = _extract_totals_probs(game["bookmakers"], "pinnacle")

        if pin_h2h is None and pin_ah is None and pin_totals is None:
            continue  # no Pinnacle line — no edge reference

        # ── Closing-line snapshot ────────────────────────────────────────
        # If kickoff is imminent (or just happened), stamp closing odds onto
        # every still-open signal for this game so we can compute CLV later.
        # Only updates rows where closing_pinnacle_prob is still NULL.
        if _is_in_closing_window(game["commence_time"]):
            pin_probs, odds_map = _build_closing_snapshot(game, pin_h2h, pin_totals)
            if pin_probs:
                updated = update_closing_lines(game_id, pin_probs, odds_map)
                if updated:
                    print(f"  [closing] {away_name} @ {home_name}: stamped {updated} signal(s)")

        if snapshot_only:
            continue

        # Pull game context (dead rubber, suspension risk, lineup status)
        ctx = get_game_context(home_name, away_name, game_date)
        ctx_notes = "; ".join(ctx["notes"]) if ctx["notes"] else ""
        # Full context snapshot for future training data — captured at detection
        # time so we know exactly what we knew when the signal fired.
        reasoning_json = json.dumps(ctx, default=str)

        # 1X2 divergence (draw market is the key structural edge vs US books)
        if pin_h2h:
            sig = _detect_h2h_divergence(game, pin_h2h)
            if sig:
                row_id = log_signal(
                    game_id       = game_id,
                    game_date     = game_date,
                    home_team     = home_name,
                    away_team     = away_name,
                    commence_time  = game["commence_time"],
                    notes          = ctx_notes,
                    reasoning_json = reasoning_json,
                    **sig,
                )
                if row_id:
                    signals_fired += 1
                    pct = sig["edge_pp"] * 100
                    flag = " ⚠ " + ctx_notes if ctx_notes else ""
                    print(
                        f"  [SIGNAL] {away_name} @ {home_name}  "
                        f"h2h/{sig['bet_side'].upper()}  "
                        f"pin={sig['pinnacle_prob']:.1%}  "
                        f"{sig['book']}={sig['book_prob']:.1%}  "
                        f"edge={pct:.1f}pp{flag}"
                    )
                else:
                    signals_skipped += 1

        # Asian Handicap divergence (cleanest 2-way market)
        if pin_ah:
            sig = _detect_ah_divergence(game, pin_ah)
            if sig:
                row_id = log_signal(
                    game_id       = game_id,
                    game_date     = game_date,
                    home_team     = home_name,
                    away_team     = away_name,
                    commence_time  = game["commence_time"],
                    notes          = ctx_notes,
                    reasoning_json = reasoning_json,
                    **sig,
                )
                if row_id:
                    signals_fired += 1
                    div  = (sig["total_line"] or 0)
                    flag = " ⚠ " + ctx_notes if ctx_notes else ""
                    print(
                        f"  [SIGNAL] {away_name} @ {home_name}  "
                        f"AH/{sig['bet_side'].upper()} {div:+.1f}  "
                        f"{sig['book']}  edge={sig['edge_pp']*100:.1f}pp{flag}"
                    )
                else:
                    signals_skipped += 1

        # Totals divergence (goal over/under)
        if pin_totals:
            sig = _detect_totals_divergence(game, pin_totals)
            if sig:
                row_id = log_signal(
                    game_id       = game_id,
                    game_date     = game_date,
                    home_team     = home_name,
                    away_team     = away_name,
                    commence_time  = game["commence_time"],
                    notes          = ctx_notes,
                    reasoning_json = reasoning_json,
                    **sig,
                )
                if row_id:
                    signals_fired += 1
                    pct  = sig["edge_pp"] * 100
                    flag = " ⚠ " + ctx_notes if ctx_notes else ""
                    print(
                        f"  [SIGNAL] {away_name} @ {home_name}  "
                        f"totals/{sig['bet_side'].upper()} {sig['total_line']}  "
                        f"pin={sig['pinnacle_prob']:.1%}  "
                        f"{sig['book']}={sig['book_prob']:.1%}  "
                        f"edge={pct:.1f}pp{flag}"
                    )
                else:
                    signals_skipped += 1

    # ── Player-prop divergence (the headline WC feature) ────────────────────
    # Separate Odds API call because player markets are 1 credit each.
    # Auto-enables when the daily market probe detects markets going live;
    # env var override remains for manual force-on / kill-switch.
    if not snapshot_only and _player_props_enabled():
        try:
            prop_games = fetch_wc_player_props()
        except Exception as e:
            print(f"  [player-props] fetch error: {e}", file=sys.stderr)
            prop_games = []

        # Build a {game_id → game} map from the prop response, then iterate
        # the upcoming games we already loaded to apply player-prop scanning.
        by_id = {g.get("id"): g for g in prop_games}
        for game in upcoming:
            propgame = by_id.get(game["id"])
            if not propgame:
                continue
            home_name = game["home_team"]
            away_name = game["away_team"]
            game_date = _et_game_date(game["commence_time"])

            # Heuristic: use the totals line / 2 as the team's expected goals
            # when Pinnacle has a totals line. Falls back to 1.40 otherwise.
            pin_tot = _extract_totals_probs(game["bookmakers"], "pinnacle")
            expected_team_goals = 1.40
            if pin_tot and pin_tot.get("line"):
                expected_team_goals = (pin_tot["line"] or 2.8) / 2.0

            prop_sigs = _detect_player_prop_signals(propgame, expected_team_goals)
            for sig in prop_sigs:
                row_id = log_player_prop_signal(
                    game_id        = game["id"],
                    game_date      = game_date,
                    home_team      = home_name,
                    away_team      = away_name,
                    commence_time  = game["commence_time"],
                    notes          = "",
                    reasoning_json = None,
                    **sig,
                )
                if row_id:
                    signals_fired += 1
                    print(
                        f"  [SIGNAL] {away_name} @ {home_name}  "
                        f"anytime/{sig['player_name']}  "
                        f"prior={sig['prior_prob']:.1%}  "
                        f"{sig['book']}={sig['book_prob']:.1%}  "
                        f"edge={sig['edge_pp']*100:.1f}pp"
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
