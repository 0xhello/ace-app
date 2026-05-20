#!/usr/bin/env python3
"""
market_probe.py — daily Odds API probe for FIFA World Cup markets.

What it does:
  1. Calls /sports/soccer_fifa_world_cup/odds with a configurable list
     of market keys (h2h / spreads / totals / btts / corners / cards /
     player_goal_scorer_anytime / etc.)
  2. Parses the response: which markets returned data, how many games
     per market, which bookmakers offer them
  3. Persists the result to wc_market_probe_log (same table the Next.js
     /api/ops/wc-market-probe endpoint writes to)
  4. Sets meta keys when something interesting happens:
       wc:player_props_first_seen_at — first time player_goal_scorer_anytime
       has > 0 games. The fetch_signals run loop reads this to auto-enable
       player-prop scanning without an env-flag flip.

Designed to be called daily from the worker (~6:45 AM ET) so the system
self-detects when WC markets open. ~10 credits per probe.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx

from .signal_logger import DB_PATH, get_db, init_db, update_meta

ODDS_BASE = "https://api.the-odds-api.com/v4"
SPORT     = "soccer_fifa_world_cup"

# Default markets the probe checks for. Mirrors the TS probe endpoint —
# both write to the same wc_market_probe_log table.
PROBE_MARKETS: List[str] = [
    # Game-level
    "h2h", "spreads", "totals", "btts",
    "alternate_totals_corners", "alternate_totals_cards",
    # Player props
    "player_goal_scorer_anytime",
    "player_goal_scorer_first",
    "player_shots_on_target",
    "player_to_be_carded",
]

# Markets whose first appearance flips a behavior. When the probe sees
# any of these go from 0 → N games, we set the corresponding meta key
# so other code (fetch_signals run loop, ops dashboard) can react.
_FLIP_MARKETS: Dict[str, str] = {
    "player_goal_scorer_anytime":   "wc:player_props_first_seen_at",
    "player_goal_scorer_first":     "wc:player_props_first_first_at",
    "alternate_totals_corners":     "wc:corners_first_seen_at",
    "alternate_totals_cards":       "wc:cards_first_seen_at",
}


def _ensure_probe_log_table(conn) -> None:
    """Idempotent table create — same shape as the TS endpoint's writer."""
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS wc_market_probe_log (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            probed_at         TEXT NOT NULL,
            total_games       INTEGER NOT NULL,
            credit_cost       INTEGER,
            credits_remaining INTEGER,
            markets_json      TEXT NOT NULL
        )
        """,
    )
    conn.commit()


def _summarize(games: List[Dict[str, Any]], markets: List[str]) -> List[Dict[str, Any]]:
    """Per-market availability map matching the TS endpoint's shape."""
    entries: Dict[str, Dict[str, Any]] = {
        m: {
            "market": m,
            "games_with_market": 0,
            "total_outcomes": 0,
            "bookmakers_offering": [],
            "sample_event": None,
        }
        for m in markets
    }
    for g in games:
        present_here: set = set()
        for bm in g.get("bookmakers") or []:
            for mkt in bm.get("markets") or []:
                e = entries.get(mkt.get("key"))
                if not e:
                    continue
                present_here.add(mkt["key"])
                e["total_outcomes"] += len(mkt.get("outcomes") or [])
                if bm.get("key") and bm["key"] not in e["bookmakers_offering"]:
                    e["bookmakers_offering"].append(bm["key"])
                if not e["sample_event"]:
                    e["sample_event"] = {
                        "home": g.get("home_team", ""),
                        "away": g.get("away_team", ""),
                    }
        for k in present_here:
            entries[k]["games_with_market"] += 1
    return list(entries.values())


def run_probe(
    markets: Optional[List[str]] = None,
    path: Path = DB_PATH,
) -> Dict[str, Any]:
    """Execute one probe pass. Returns the same shape as the TS endpoint
    so consumers can swap freely.

    Raises on missing API key. Returns a degraded-but-valid payload on
    HTTP errors (so the daily worker job doesn't blow up if Odds API
    has a transient outage).
    """
    api_key = os.getenv("ODDS_API_KEY", "")
    if not api_key:
        raise EnvironmentError("ODDS_API_KEY not set")

    market_list = markets or PROBE_MARKETS
    probed_at = datetime.now(timezone.utc).isoformat()

    params = {
        "apiKey":     api_key,
        "regions":    "us",
        "oddsFormat": "american",
        "markets":    ",".join(market_list),
    }
    try:
        resp = httpx.get(f"{ODDS_BASE}/sports/{SPORT}/odds", params=params, timeout=15)
    except Exception as e:
        return {
            "ok": False, "error": f"network: {e}",
            "total_games": 0, "credit_cost": None, "credits_remaining": None,
            "markets": [],
            "probed_at": probed_at,
        }

    remaining = resp.headers.get("x-requests-remaining")
    last_cost = resp.headers.get("x-requests-last")

    # 422 means "sport not active right now" — common pre-tournament. Log
    # the empty result so we can see the timeline of when it goes live.
    if resp.status_code == 422:
        games = []
    elif resp.status_code in (401, 429):
        return {
            "ok": False, "error": f"HTTP {resp.status_code}",
            "total_games": 0, "credit_cost": None,
            "credits_remaining": int(remaining) if remaining else None,
            "markets": [],
            "probed_at": probed_at,
        }
    else:
        try:
            resp.raise_for_status()
            games = resp.json()
        except Exception as e:
            return {
                "ok": False, "error": str(e),
                "total_games": 0, "credit_cost": None,
                "credits_remaining": int(remaining) if remaining else None,
                "markets": [],
                "probed_at": probed_at,
            }

    summary = _summarize(games, market_list)
    payload = {
        "ok": True,
        "total_games": len(games),
        "credit_cost":       int(last_cost) if last_cost else None,
        "credits_remaining": int(remaining) if remaining else None,
        "markets": summary,
        "probed_at": probed_at,
    }

    _persist(payload, path)
    _detect_market_flips(summary, path)
    return payload


def _persist(payload: Dict[str, Any], path: Path) -> None:
    """Write the probe result to wc_market_probe_log. Best-effort —
    never raise to the caller. The daily worker tick depends on this
    not breaking the rest of the pipeline."""
    try:
        init_db(path)
        conn = get_db(path)
        _ensure_probe_log_table(conn)
        conn.execute(
            "INSERT INTO wc_market_probe_log "
            "(probed_at, total_games, credit_cost, credits_remaining, markets_json) "
            "VALUES (?, ?, ?, ?, ?)",
            (
                payload["probed_at"],
                payload["total_games"],
                payload["credit_cost"],
                payload["credits_remaining"],
                json.dumps(payload["markets"]),
            ),
        )
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"  [probe] persist error: {e}", file=sys.stderr)


def _detect_market_flips(summary: List[Dict[str, Any]], path: Path) -> None:
    """When a watched market goes from never-seen → ≥1 game, stamp the
    corresponding meta key. fetch_signals reads these to auto-enable
    behaviors without an env-flag flip. Once stamped, the key stays set —
    we don't unstamp on a transient back-to-zero (markets close briefly
    between matchdays, that's not a regression).
    """
    try:
        for entry in summary:
            mk = entry.get("market")
            if mk not in _FLIP_MARKETS:
                continue
            games = entry.get("games_with_market", 0) or 0
            if games <= 0:
                continue
            meta_key = _FLIP_MARKETS[mk]
            # Only stamp on the first detection
            conn = get_db(path)
            existing = conn.execute(
                "SELECT value FROM meta WHERE key = ?", (meta_key,)
            ).fetchone()
            conn.close()
            if existing and existing["value"]:
                continue
            update_meta(meta_key, datetime.now(timezone.utc).isoformat(), path)
            update_meta(f"{meta_key}:game_count", str(games), path)
            print(
                f"  [probe] 🎯 {mk} first detected on {games} game(s) — "
                f"meta '{meta_key}' set",
                flush=True,
            )
    except Exception as e:
        print(f"  [probe] flip-detection error: {e}", file=sys.stderr)


def is_player_props_live(path: Optional[Path] = None) -> bool:
    """True if player_goal_scorer_anytime has been detected on Odds API
    at any prior probe. Used by fetch_signals to gate the player-prop
    scan path without an env-flag flip.

    Path resolved at call time (not function-definition) so monkeypatched
    DB_PATH in tests routes correctly.
    """
    if path is None:
        path = DB_PATH
    try:
        conn = get_db(path)
        row = conn.execute(
            "SELECT value FROM meta WHERE key = 'wc:player_props_first_seen_at'"
        ).fetchone()
        conn.close()
        return bool(row and row["value"])
    except Exception:
        return False


# ── CLI: `python3 -m ml.world_cup.market_probe` for manual ops use ────────────

if __name__ == "__main__":
    payload = run_probe()
    print(json.dumps(payload, indent=2, default=str))
