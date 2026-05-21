#!/usr/bin/env python3
"""
leagues.py — game-level signal scanner for European club leagues + UCL.

Reuses the WC divergence engine wholesale. The math is identical
(Pinnacle vs soft-book divergence ≥ 3pp on h2h / spreads / totals);
only the sport key + tournament label changes. Signals land in the
SAME soccer_signals table as WC, tagged by the `tournament` column —
ops dashboard can filter or aggregate per league.

Why one engine, many leagues:
  - Player rosters and form data overlap heavily — most WC qualifiers
    play their club football here. Building league signals NOW means
    we accumulate calibration data before WC opens.
  - When WC starts June 11, the same code path simply adds another
    sport key. No new pipeline.

Each league has an `active_until` date (season end). The worker calls
run_league() once per tick per active league. After active_until, the
league is silently skipped — no spend, no errors.

Usage (worker.py):
    from ml.soccer.leagues import run_active_leagues
    run_active_leagues()         # iterates LEAGUES, scans the ones in window
"""
from __future__ import annotations

import json
import os
import sys
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx
from dotenv import load_dotenv

# Reuse the WC divergence engine — single source of truth for the math.
from ml.world_cup.fetch_signals import (
    _detect_ah_divergence,
    _detect_h2h_divergence,
    _detect_totals_divergence,
    _extract_ah_line,
    _extract_h2h_probs,
    _extract_totals_probs,
    filter_upcoming,
    _et_game_date,
    _is_in_closing_window,
    _build_closing_snapshot,
)
from ml.world_cup.signal_logger import log_signal, log_player_prop_signal, update_closing_lines
from ml.world_cup.fetch_signals import _detect_player_prop_signals

_ENV_PATH = Path(__file__).resolve().parents[2] / ".env.local"
load_dotenv(_ENV_PATH)

ODDS_API_KEY = os.getenv("ODDS_API_KEY", "")
ODDS_BASE    = "https://api.the-odds-api.com/v4"

MARKETS = "h2h,spreads,totals"
PLAYER_PROP_MARKETS = "player_goal_scorer_anytime"
BOOKS   = "pinnacle,fanduel,draftkings,betmgm,williamhill_us,betrivers"

# Player-prop scanning is opt-in per call. Costs 1 extra credit per league
# per tick, so the worker calls it on a slower cadence than game-level
# (handled via the SCAN_PROPS env flag — default off until we're confident
# the priors layer is populated enough to fire signals).
SCAN_PLAYER_PROPS_DEFAULT = os.getenv("WC_PLAYER_PROPS_CLUB_LEAGUES", "").lower() in ("1", "true", "yes")


# ── League catalog ───────────────────────────────────────────────────────────
# Each entry: (sport_key, tournament_label, active_until). After active_until,
# the league is silently skipped. Update annually as seasons shift.
#
# Sport keys verified against https://api.the-odds-api.com/v4/sports
# Season-end dates are the LAST scheduled matchday; final cup matches may
# extend further but the league's regular slate is done.

LEAGUES: List[Tuple[str, str, date]] = [
    # European Big 5 — most of WC's UEFA qualifier players are here
    ("soccer_epl",                  "Premier League",  date(2026, 5, 25)),
    ("soccer_spain_la_liga",        "La Liga",          date(2026, 5, 25)),
    ("soccer_germany_bundesliga",   "Bundesliga",       date(2026, 5, 17)),
    ("soccer_italy_serie_a",        "Serie A",          date(2026, 5, 25)),
    ("soccer_france_ligue_one",     "Ligue 1",          date(2026, 5, 17)),
    # UEFA Champions League — final June 1 (one-off; high signal density)
    ("soccer_uefa_champs_league",   "UCL",              date(2026, 6, 7)),
]


def _is_league_active(active_until: date, now: Optional[date] = None) -> bool:
    """League is active up to and including the active_until date."""
    today = now or datetime.now().date()
    return today <= active_until


# ── Odds fetch (per sport key) ───────────────────────────────────────────────

def fetch_league_odds(sport_key: str) -> List[Dict[str, Any]]:
    """Pull odds for one sport key. Read-through Redis cache so we don't
    double-spend with the Next.js board fetcher (same pattern as the WC
    and NBA fetchers).

    Returns [] on 422 (sport not currently active per Odds API), 401, etc.
    """
    from ml.common.odds_cache import try_get_odds
    cached = try_get_odds(f"__raw_odds_{sport_key}__")
    if cached is not None:
        return cached

    if not ODDS_API_KEY:
        raise EnvironmentError("ODDS_API_KEY not set.")

    url = f"{ODDS_BASE}/sports/{sport_key}/odds"
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
        print(f"  [quota] ({sport_key}) {used} used / {remaining} remaining")
    try:
        from ml.common.odds_cache import write_quota
        write_quota(remaining, used, resp.headers.get("x-requests-last"),
                    source=f"python-soccer-{sport_key[:10]}",
                    endpoint=f"/sports/{sport_key}/odds")
    except Exception:
        pass

    if resp.status_code == 401:
        raise EnvironmentError("ODDS_API_KEY invalid or expired.")
    if resp.status_code == 422:
        return []  # off-season / unavailable
    if resp.status_code == 429:
        raise RuntimeError("Odds API quota exceeded.")
    resp.raise_for_status()
    return resp.json()


def fetch_league_player_props(sport_key: str) -> List[Dict[str, Any]]:
    """Separate Odds API call for player_goal_scorer_anytime markets per
    league. Costs 1 credit per call (one market). Returns [] when the
    market isn't posted yet (422 from Odds API).
    """
    if not ODDS_API_KEY:
        return []
    url = f"{ODDS_BASE}/sports/{sport_key}/odds"
    params = {
        "apiKey":     ODDS_API_KEY,
        "regions":    "us",
        "markets":    PLAYER_PROP_MARKETS,
        "bookmakers": BOOKS,
        "oddsFormat": "american",
    }
    resp = httpx.get(url, params=params, timeout=15)
    if resp.status_code in (401, 422):
        return []  # not posted yet for this league / sport
    if resp.status_code == 429:
        raise RuntimeError("Odds API quota exceeded.")
    resp.raise_for_status()
    return resp.json()


# ── Per-league signal scan ───────────────────────────────────────────────────

def run_league(
    sport_key: str,
    tournament: str,
    snapshot_only: bool = False,
    scan_player_props: Optional[bool] = None,
) -> Dict[str, int]:
    """Scan one league's odds, fire divergence signals into soccer_signals
    tagged with `tournament`. Returns {signals_fired, signals_skipped, games,
    prop_signals}.

    snapshot_only=True (worker tip-time path) skips signal logging but still
    refreshes the closing-line snapshot for any open signals on imminent
    kickoffs.

    scan_player_props controls whether we ALSO scan player_goal_scorer_anytime
    markets (costs 1 extra credit per call). Defaults to the env-driven
    SCAN_PLAYER_PROPS_DEFAULT — start with off, flip on when priors are populated.
    """
    if scan_player_props is None:
        scan_player_props = SCAN_PLAYER_PROPS_DEFAULT
    print("=" * 55)
    print(f"  ACE — {tournament} ({sport_key}) Signal Scan")
    print(f"  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 55)

    if not ODDS_API_KEY:
        print(f"  ERROR: ODDS_API_KEY not set", file=sys.stderr)
        return {"signals_fired": 0, "signals_skipped": 0, "games": 0}

    try:
        raw_games = fetch_league_odds(sport_key)
    except RuntimeError as e:
        print(f"  ERROR: {e}", file=sys.stderr)
        return {"signals_fired": 0, "signals_skipped": 0, "games": 0}

    if not raw_games:
        print(f"  No games returned — {sport_key} may not be active.")
        return {"signals_fired": 0, "signals_skipped": 0, "games": 0}

    upcoming = filter_upcoming(raw_games, horizon_hours=72)
    print(f"  {len(raw_games)} total games, {len(upcoming)} upcoming (72h window)")

    if not upcoming:
        return {"signals_fired": 0, "signals_skipped": 0, "games": len(raw_games)}

    signals_fired = 0
    signals_skipped = 0

    for game in upcoming:
        home_name = game["home_team"]
        away_name = game["away_team"]
        game_id   = game["id"]
        game_date = _et_game_date(game["commence_time"])

        # Pinnacle is the sharp reference. No Pinnacle line → no signal —
        # we don't fire divergence on books-only matches because we'd have
        # nothing honest to compare to.
        pin_h2h    = _extract_h2h_probs(game["bookmakers"], "pinnacle", home_name, away_name)
        pin_ah     = _extract_ah_line(game["bookmakers"], "pinnacle", home_name)
        pin_totals = _extract_totals_probs(game["bookmakers"], "pinnacle")

        if pin_h2h is None and pin_ah is None and pin_totals is None:
            continue

        # Closing-line snapshot — same code path as WC.
        if _is_in_closing_window(game["commence_time"]):
            pin_probs, odds_map = _build_closing_snapshot(game, pin_h2h, pin_totals)
            if pin_probs:
                updated = update_closing_lines(game_id, pin_probs, odds_map)
                if updated:
                    print(f"  [closing] {away_name} @ {home_name}: stamped {updated} signal(s)")

        if snapshot_only:
            continue

        # No context layer for non-WC leagues yet (no dead-rubber detection,
        # no suspension data). The reasoning_json is None — that's fine; we
        # can layer in MLS / EPL context as a follow-up if it improves CLV.
        reasoning_json: Optional[str] = None

        # 1X2 divergence
        if pin_h2h:
            sig = _detect_h2h_divergence(game, pin_h2h)
            if sig:
                row_id = log_signal(
                    game_id        = game_id,
                    game_date      = game_date,
                    home_team      = home_name,
                    away_team      = away_name,
                    commence_time  = game["commence_time"],
                    notes          = "",
                    reasoning_json = reasoning_json,
                    tournament     = tournament,
                    **sig,
                )
                if row_id:
                    signals_fired += 1
                    print(
                        f"  [SIGNAL] {away_name} @ {home_name}  "
                        f"h2h/{sig['bet_side'].upper()}  "
                        f"pin={sig['pinnacle_prob']:.1%}  "
                        f"{sig['book']}={sig['book_prob']:.1%}  "
                        f"edge={sig['edge_pp']*100:.1f}pp"
                    )
                else:
                    signals_skipped += 1

        # Asian Handicap divergence
        if pin_ah:
            sig = _detect_ah_divergence(game, pin_ah)
            if sig:
                row_id = log_signal(
                    game_id        = game_id,
                    game_date      = game_date,
                    home_team      = home_name,
                    away_team      = away_name,
                    commence_time  = game["commence_time"],
                    notes          = "",
                    reasoning_json = reasoning_json,
                    tournament     = tournament,
                    **sig,
                )
                if row_id:
                    signals_fired += 1
                    div = (sig["total_line"] or 0)
                    print(
                        f"  [SIGNAL] {away_name} @ {home_name}  "
                        f"AH/{sig['bet_side'].upper()} {div:+.1f}  "
                        f"{sig['book']}  edge={sig['edge_pp']*100:.1f}pp"
                    )
                else:
                    signals_skipped += 1

        # Totals divergence
        if pin_totals:
            sig = _detect_totals_divergence(game, pin_totals)
            if sig:
                row_id = log_signal(
                    game_id        = game_id,
                    game_date      = game_date,
                    home_team      = home_name,
                    away_team      = away_name,
                    commence_time  = game["commence_time"],
                    notes          = "",
                    reasoning_json = reasoning_json,
                    tournament     = tournament,
                    **sig,
                )
                if row_id:
                    signals_fired += 1
                    print(
                        f"  [SIGNAL] {away_name} @ {home_name}  "
                        f"totals/{sig['bet_side'].upper()} {sig['total_line']}  "
                        f"pin={sig['pinnacle_prob']:.1%}  "
                        f"{sig['book']}={sig['book_prob']:.1%}  "
                        f"edge={sig['edge_pp']*100:.1f}pp"
                    )
                else:
                    signals_skipped += 1

    # ── Player-prop divergence (opt-in via scan_player_props) ────────────────
    # 1 extra credit per league per call. Reads from club_players via the
    # existing _detect_player_prop_signals → find_wc_player → club_players
    # fallback chain. Compares each player's anytime-scorer market against
    # our prior; logs +EV divergences tagged with `tournament`.
    prop_signals = 0
    if not snapshot_only and scan_player_props:
        try:
            prop_games = fetch_league_player_props(sport_key)
        except Exception as e:
            print(f"  [{tournament}] player-prop fetch error: {e}", file=sys.stderr)
            prop_games = []

        by_id = {g.get("id"): g for g in prop_games}
        for game in upcoming:
            pg = by_id.get(game["id"])
            if not pg:
                continue
            home_name = game["home_team"]
            away_name = game["away_team"]
            game_date = _et_game_date(game["commence_time"])

            # Use Pinnacle's totals line / 2 as expected team goals when
            # available, otherwise the 1.40 international-tournament default
            # (a reasonable club-league baseline too).
            pin_tot = _extract_totals_probs(game["bookmakers"], "pinnacle")
            expected_team_goals = 1.40
            if pin_tot and pin_tot.get("line"):
                expected_team_goals = (pin_tot["line"] or 2.8) / 2.0

            for sig in _detect_player_prop_signals(pg, expected_team_goals):
                row_id = log_player_prop_signal(
                    game_id        = game["id"],
                    game_date      = game_date,
                    home_team      = home_name,
                    away_team      = away_name,
                    commence_time  = game["commence_time"],
                    notes          = "",
                    reasoning_json = None,
                    tournament     = tournament,
                    **sig,
                )
                if row_id:
                    prop_signals += 1
                    print(
                        f"  [SIGNAL] {away_name} @ {home_name}  "
                        f"anytime/{sig['player_name']}  "
                        f"prior={sig['prior_prob']:.1%}  "
                        f"{sig['book']}={sig['book_prob']:.1%}  "
                        f"edge={sig['edge_pp']*100:.1f}pp"
                    )

    print(f"  Signals fired: {signals_fired}  Skipped (dup): {signals_skipped}  Prop signals: {prop_signals}")
    return {
        "signals_fired":   signals_fired,
        "signals_skipped": signals_skipped,
        "prop_signals":    prop_signals,
        "games":           len(raw_games),
    }


# ── Orchestrator — called from the worker tick ───────────────────────────────

def run_active_leagues(snapshot_only: bool = False) -> Dict[str, Dict[str, int]]:
    """Iterate LEAGUES, skip the ones past season-end, scan the active ones.
    One Odds API call per active league per tick (each is ~3 credits).

    Returns per-league summary so the worker can log a single line of
    aggregate activity instead of N noisy ones.
    """
    summary: Dict[str, Dict[str, int]] = {}
    today = datetime.now().date()
    for sport_key, tournament, active_until in LEAGUES:
        if not _is_league_active(active_until, today):
            continue
        try:
            summary[tournament] = run_league(sport_key, tournament, snapshot_only=snapshot_only)
        except Exception as e:
            print(f"  [{tournament}] scan error: {e}", file=sys.stderr)
            summary[tournament] = {"signals_fired": 0, "signals_skipped": 0, "games": 0}
    return summary


# ── CLI for manual testing / ad-hoc runs ─────────────────────────────────────

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--sport-key",   help="Single sport key to scan (e.g. soccer_epl)")
    parser.add_argument("--tournament",  help="Tournament label when using --sport-key")
    parser.add_argument("--snapshot-only", action="store_true",
                        help="Refresh closing-line snapshots but don't log new signals")
    args = parser.parse_args()

    if args.sport_key and args.tournament:
        run_league(args.sport_key, args.tournament, snapshot_only=args.snapshot_only)
    else:
        results = run_active_leagues(snapshot_only=args.snapshot_only)
        print(json.dumps(results, indent=2))
