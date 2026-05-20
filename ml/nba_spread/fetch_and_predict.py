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

import json
import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

import httpx
import pandas as pd
from dotenv import load_dotenv

from .inference import predict_games, log_prediction, MODEL_PERFORMANCE_PATH, normalize_team_code
from .signal_logger import (
    save_snapshot, record_closing_proxy, detect_line_movements,
    save_book_lines, get_book_divergences,
    check_and_save_divergence_alerts, log_signal, get_model_probs,
    get_divergence_first_seen, _rest_days_for_code, _regime_for_date,
    get_db, DB_PATH, log_paper_execution,
)
from .steam_detector import detect_steam, log_steam_signals
from .train_spread_model import BACKTEST_METRICS_PATH

# Load ODDS_API_KEY from .env.local (same file the Next.js app uses)
_ENV_PATH = Path(__file__).resolve().parents[2] / ".env.local"
load_dotenv(_ENV_PATH)

ODDS_API_KEY = os.getenv("ODDS_API_KEY", "")
ODDS_BASE = "https://api.the-odds-api.com/v4"
SPORT = "basketball_nba"
MARKETS = "spreads,totals"
# Pinnacle must be requested explicitly — it's not in the default book set.
# Soft books ordered by execution priority (US-licensed first, offshore last).
# All are tracked for divergence detection; execution preference uses _PREFERRED_BOOKS.
BOOKS = "pinnacle,fanduel,draftkings,betmgm,williamhill_us,betrivers"

# Minimum divergence from Pinnacle's de-vigged probability to count as a bet.
# 0.04 = model must disagree with Pinnacle by ≥4 percentage points in our pick's direction.
# No Pinnacle line = no bet. Model confidence alone is not an edge signal.
EDGE_THRESHOLD = 0.04


_PREFERRED_BOOKS = ("pinnacle", "fanduel", "draftkings", "betmgm", "williamhill_us", "betrivers", "lowvig", "fanatics")
_DIVERGENCE_LOG = Path(__file__).resolve().parents[2] / "ml" / "logs" / "divergence_alerts.log"

# Model veto thresholds for soft_book_divergence signals.
# If the model strongly disagrees with the divergence direction we still log
# the signal (paper trading — track everything) but annotate it as vetoed so
# we can compare vetoed vs non-vetoed CLV during analysis.
_VETO_HOME_BELOW = 0.40   # skip home bet if home_cover_prob < this
_VETO_AWAY_ABOVE = 0.60   # skip away bet if home_cover_prob > this

_TZ_ET = ZoneInfo("America/New_York")


def _log_divergence_signals(alerts: List[Dict[str, Any]]) -> None:
    """
    Insert a soft_book_divergence signal into signal_log for each newly fired alert.

    Deduplicates by game_id: when multiple books diverge on the same game we only
    log the single largest-gap alert. All books are still tracked in divergence_alerts.

    entry line  = the SOFT BOOK's line (book_line), not Pinnacle's.
    execution_source = the soft book name (e.g. 'fanduel').
    bet_side    = 'home' if divergence > 0 else 'away'.

    If a model prediction already exists for the game and strongly disagrees
    with the divergence direction, the signal is still logged (paper trading —
    we track everything for CLV comparison) but the notes field flags the veto.
    """
    try:
        from .compute_archetypes import describe_matchup, load as load_archetypes
        _archetypes = load_archetypes()
    except Exception:
        _archetypes = {}

    # One signal per game: pick the largest-gap alert per game_id, skip the rest.
    best_per_game: Dict[str, Dict[str, Any]] = {}
    for a in alerts:
        gid = a["game_id"]
        if gid not in best_per_game or abs(a["divergence"]) > abs(best_per_game[gid]["divergence"]):
            best_per_game[gid] = a

    # Also skip games that already have a soft_book_divergence signal logged today.
    conn = get_db(DB_PATH)
    already_logged = set(
        row[0] for row in conn.execute(
            "SELECT DISTINCT game_id FROM signal_log WHERE signal_type = 'soft_book_divergence'"
        ).fetchall()
    )
    conn.close()

    for a in [v for v in best_per_game.values() if v["game_id"] not in already_logged]:
        bet_side  = "home" if a["divergence"] > 0 else "away"
        book_line = a["book_line"]
        book      = a["book"]

        veto_note = ""
        model_endorses = False   # True only when model+edge agree with divergence direction
        probs = get_model_probs(a["game_id"])
        if probs:
            hcp  = probs.get("home_cover_prob") or 0.5
            edge = probs.get("edge_vs_pinnacle")
            # Direction-consistent: home bet needs positive edge, away bet needs negative edge
            if edge is not None:
                dir_ok = (bet_side == "home" and edge > 0) or (bet_side == "away" and edge < 0)
                model_endorses = dir_ok and abs(edge) >= EDGE_THRESHOLD
            # Veto note for logging/analysis when model clearly disagrees
            if bet_side == "home" and hcp < _VETO_HOME_BELOW:
                veto_note = f"model_veto: home_cover_prob={hcp:.3f} < {_VETO_HOME_BELOW}"
            elif bet_side == "away" and hcp > _VETO_AWAY_ABOVE:
                veto_note = f"model_veto: home_cover_prob={hcp:.3f} > {_VETO_AWAY_ABOVE}"
            elif not model_endorses and edge is not None:
                veto_note = (
                    f"model_veto: edge={edge:+.3f} not in {'home' if bet_side=='home' else 'away'} direction"
                    f" (need {'>' if bet_side=='home' else '<'}0, |edge|>={EDGE_THRESHOLD})"
                )

        # Gap age: time since this (game_id, book) divergence was first detected.
        # 0 for brand-new gaps; non-zero for widened alerts seen in prior cron runs.
        first_seen = get_divergence_first_seen(a["game_id"], a["book"], a["game_date"])
        gap_age_mins = (
            round((datetime.now(timezone.utc) - first_seen).total_seconds() / 60)
            if first_seen else None
        )
        age_note = f"  age={gap_age_mins}m" if gap_age_mins is not None else ""

        home_code = normalize_team_code(a["home_team"])
        away_code = normalize_team_code(a["away_team"])
        matchup_ctx = describe_matchup(home_code, away_code, _archetypes) if _archetypes else ""

        detail = (
            f"{book} {book_line:+.1f} vs pinnacle {a['pinnacle_line']:+.1f} "
            f"(gap={a['divergence']:+.2f}{age_note})"
            + (f" | {veto_note}" if veto_note else "")
            + (f"\n      matchup: {matchup_ctx}" if matchup_ctx else "")
        )

        h_rest = _rest_days_for_code(home_code)
        a_rest = _rest_days_for_code(away_code)
        b_rest = h_rest if bet_side == "home" else a_rest
        o_rest = a_rest if bet_side == "home" else h_rest

        row_id = log_signal(
            game_id=a["game_id"],
            game_date=a["game_date"],
            home_team=a["home_team"],
            away_team=a["away_team"],
            signal_type="soft_book_divergence",
            line_at_signal=book_line,
            bet_side=bet_side,
            execution_source=book,
            signal_detail=detail,
            notes=veto_note,
            regime=_regime_for_date(a["game_date"]),
            bet_rest_days=b_rest,
            opp_rest_days=o_rest,
        )

        # Only auto-log paper bet when model direction + edge both agree with the divergence.
        # Vetoed or low-edge divergences are still logged for CLV tracking but not paper-traded.
        if row_id > 0 and model_endorses:
            try:
                log_paper_execution(
                    signal_id=row_id,
                    book=book,
                    signal_line=book_line,
                    bet_side=bet_side,
                )
            except Exception:
                pass

        direction   = "HOME" if bet_side == "home" else "AWAY"
        status_flag = " *** BET" if model_endorses else " [no bet — model veto]"
        print(
            f"    → Signal #{row_id}  {a['away_team']} @ {a['home_team']}  "
            f"bet={direction} at {book}={book_line:+.1f}{status_flag}"
        )


def _fire_divergence_alerts(alerts: List[Dict[str, Any]], label: str) -> None:
    """Print, log, and send a macOS notification for newly detected divergences."""
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    lines = []
    for a in alerts:
        direction = "HOME" if a["divergence"] > 0 else "AWAY"
        tag = "WIDER" if a.get("is_widened") else "NEW"
        line = (
            f"  [{tag}] {a['away_team']} @ {a['home_team']}  "
            f"{a['book']}={a['book_line']:+.1f}  pin={a['pinnacle_line']:+.1f}  "
            f"gap={a['divergence']:+.2f}  bet={direction}  ({label})"
        )
        lines.append(line)
        print(line)

    _DIVERGENCE_LOG.parent.mkdir(parents=True, exist_ok=True)
    with _DIVERGENCE_LOG.open("a") as f:
        f.write(f"[{ts}]\n" + "\n".join(lines) + "\n\n")

    try:
        import subprocess
        summary = "; ".join(
            f"{a['book']} {a['away_team']}@{a['home_team']} {a['divergence']:+.1f}"
            for a in alerts[:3]
        )
        if len(alerts) > 3:
            summary += f" +{len(alerts) - 3} more"
        subprocess.run(
            ["osascript", "-e",
             f'display notification "{summary}" with title "ACE: Soft Book Gap" sound name "Glass"'],
            capture_output=True, timeout=5,
        )
    except Exception:
        pass


def _et_game_date(commence_time: str) -> str:
    """Return the ET calendar date for a UTC ISO commence_time string."""
    dt = datetime.fromisoformat(commence_time.replace("Z", "+00:00"))
    return dt.astimezone(_TZ_ET).strftime("%Y-%m-%d")


def _et_today() -> str:
    """Return today's date in ET."""
    return datetime.now(_TZ_ET).strftime("%Y-%m-%d")


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
    """Auto-detect snapshot label from current ET time."""
    if override:
        return override
    et_hour = datetime.now(_TZ_ET).hour
    if et_hour >= 18:
        return "6pm_proxy"
    if et_hour >= 12:
        return "afternoon"
    return "morning"


def _extract_all_books(game: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Extract spread lines from every bookmaker present in the raw API response.
    Returns a list of dicts, one per book that has a spreads market:
      {"book": str, "home_line": float, "home_price": float|None,
       "away_price": float|None, "over_under": float|None}
    """
    home_name = game["home_team"]
    results = []
    for bm in game.get("bookmakers", []):
        home_line: Optional[float] = None
        home_price: Optional[float] = None
        away_price: Optional[float] = None
        over_under: Optional[float] = None
        for market in bm.get("markets", []):
            if market["key"] == "spreads":
                for oc in market["outcomes"]:
                    if oc["name"] == home_name:
                        home_line = float(oc["point"])
                        home_price = float(oc["price"]) if "price" in oc else None
                    else:
                        away_price = float(oc["price"]) if "price" in oc else None
            elif market["key"] == "totals" and market.get("outcomes"):
                over_under = float(market["outcomes"][0]["point"])
        if home_line is not None:
            results.append({
                "book": bm["key"],
                "home_line": home_line,
                "home_price": home_price,
                "away_price": away_price,
                "over_under": over_under,
            })
    return results


def _save_all_book_lines(upcoming: List[Dict[str, Any]], label: str) -> int:
    """Save every book's spread line for each upcoming game. Returns total rows inserted."""
    total = 0
    for game in upcoming:
        lines = _extract_all_books(game)
        if not lines:
            continue
        game_date = _et_game_date(game["commence_time"])
        total += save_book_lines(
            game_id=game["id"],
            game_date=game_date,
            home_team=game["home_team"],
            away_team=game["away_team"],
            snapshot_label=label,
            lines=lines,
        )
    return total


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


def _record_closing_proxies(
    upcoming: List[Dict[str, Any]],
    force: bool = False,
    only_within_hours: Optional[float] = None,
) -> int:
    """
    For every open signal whose game_id is in the current odds fetch,
    record the current spread as the closing-line proxy.

    force=True         — overwrite closing_line if already set (used by pregame and
                         closing crons to replace earlier proxies with truer closes).
    only_within_hours  — when set, only update signals for games tipping within this
                         many hours. Used by closing_early/closing_late crons so they
                         stamp only the games that are actually close to tip.
    """
    updated_total = 0
    now_utc = datetime.now(timezone.utc)
    for game in upcoming:
        if only_within_hours is not None:
            try:
                tip = datetime.fromisoformat(game["commence_time"].replace("Z", "+00:00"))
                if (tip - now_utc).total_seconds() / 3600 > only_within_hours:
                    continue
            except Exception:
                pass
        game_id = game["id"]
        # Close should always be Pinnacle for canonical CLV — execution source
        # only matters for the entry line, not the benchmark close.
        home_line, _, book = _extract_spread(game, preferred_book="pinnacle")
        if home_line is None:
            continue
        if book != "pinnacle":
            source = f"{book}_no_pinnacle"
        else:
            source = "pinnacle"
        updated_total += record_closing_proxy(
            game_id=game_id,
            closing_line=home_line,
            source=source,
            force=force,
        )
    return updated_total


_DEFAULT_THRESHOLD = 0.58

def _load_best_threshold() -> float:
    """Pull the threshold from the last training run if available."""
    try:
        import json
        metrics = json.loads(BACKTEST_METRICS_PATH.read_text())
        return float(metrics.get("best_threshold", _DEFAULT_THRESHOLD))
    except Exception:
        return _DEFAULT_THRESHOLD


def fetch_nba_odds() -> List[Dict[str, Any]]:
    # Use web-frontend Redis cache when available — zero API credits consumed
    from ml.common.odds_cache import try_get_odds
    cached = try_get_odds("__raw_odds_nba__")
    if cached is not None:
        return cached

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
    try:
        from ml.common.odds_cache import write_quota
        write_quota(remaining, used, resp.headers.get("x-requests-last"),
                    source="python-nba", endpoint=f"/sports/{SPORT}/odds")
    except Exception:
        pass

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


def filter_upcoming(games: List[Dict[str, Any]], horizon_hours: int = 24) -> List[Dict[str, Any]]:
    """Keep only games starting within the next horizon_hours (default 24h).
    Prevents locking in predictions for games whose lines and rosters may still
    move significantly before tip. Tomorrow's games get fresher data tomorrow."""
    now = datetime.now(timezone.utc)
    cutoff = now + timedelta(hours=horizon_hours)
    upcoming = []
    for g in games:
        try:
            start = datetime.fromisoformat(g["commence_time"].replace("Z", "+00:00"))
            if now < start <= cutoff:
                upcoming.append(g)
        except Exception:
            continue
    return upcoming


def run(
    threshold: Optional[float] = None,
    snapshot_only: bool = False,
    label_override: Optional[str] = None,
) -> List[Dict[str, Any]]:
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
        return []

    # Always save snapshots — morning run gets 'morning', 6pm run gets '6pm_proxy'
    label = _snapshot_label(label_override)
    n_saved = _save_snapshots(upcoming, label)
    print(f"  Snapshots saved: {n_saved} games  (label={label!r})")

    n_book_lines = _save_all_book_lines(upcoming, label)
    print(f"  Book lines saved: {n_book_lines} rows across all books")

    # Check for soft book divergences vs Pinnacle and alert on new/widened gaps.
    # Runs on every snapshot label so windows are caught as soon as they open.
    _et_tomorrow = (datetime.now(_TZ_ET) + timedelta(days=1)).strftime("%Y-%m-%d")
    all_divs = (
        get_book_divergences(game_date=_et_today(), min_divergence=0.5)
        + get_book_divergences(game_date=_et_tomorrow, min_divergence=0.5)
    )
    new_alerts = check_and_save_divergence_alerts(all_divs, label)
    if new_alerts:
        print(f"\n  *** {len(new_alerts)} new divergence alert(s):")
        _fire_divergence_alerts(new_alerts, label)
        _log_divergence_signals(new_alerts)

    # Stamp open signals with closing-line proxy.
    # - 6pm_proxy (3pm PDT): first proxy capture for all games.
    # - pregame (4:15pm PDT): force-overwrites with truer close; good for 7:30pm ET tips.
    # - closing_early (5:15pm PDT): tip-aware, only games within 3h of tip (~8:30-9pm ET).
    # - closing_late  (7:00pm PDT): tip-aware, only games within 3h of tip (~10pm ET).
    # The last cron to fire before each game's specific tip becomes the effective close.
    if label in ("6pm_proxy", "pregame", "closing_early", "closing_late"):
        force = label in ("pregame", "closing_early", "closing_late")
        only_within = 3.0 if label in ("closing_early", "closing_late") else None
        n_updated = _record_closing_proxies(upcoming, force=force, only_within_hours=only_within)
        if n_updated:
            print(f"  Closing proxies recorded: {n_updated} signal row(s) updated")

    # Steam detection — runs on every snapshot so we catch moves as they happen
    for gd in (_et_today(), _et_tomorrow):
        steam_moves = detect_steam(game_date=gd)
        if steam_moves:
            steam_ids = log_steam_signals(steam_moves)
            print(f"  Steam signals logged: {len(steam_ids)} for {gd}")
            for s in steam_moves:
                direction = "HOME" if s["direction"] == 1 else "AWAY"
                books_str = ", ".join(s["books"][:4])
                print(f"    [STEAM] {s['away_team']} @ {s['home_team']}  "
                      f"bet={direction}  {len(s['books'])} books  avg {s['move_size']:+.2f}pts  ({books_str})")

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
        return upcoming

    if threshold is None:
        threshold = _load_best_threshold()
    print(f"  Confidence threshold: {threshold}")

    already_logged = load_logged_game_ids()
    new_games = [g for g in upcoming if g.get("id") not in already_logged]
    print(f"  {len(new_games)} new (not yet logged)")

    if not new_games:
        print("  All games already logged. Nothing to add.")
        return upcoming

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
            is_pinnacle_bet = is_bet
        else:
            # No Pinnacle line — no bet. Model confidence alone is not an edge signal.
            # Without a sharp-line benchmark there is nothing to diverge from.
            edge = None
            is_bet = False
            is_pinnacle_bet = False

        log_prediction(row.to_dict(), is_bet=is_bet, is_pinnacle_bet=is_pinnacle_bet, threshold_used=threshold)
        logged += 1
        if is_bet:
            bets += 1

        direction = "HOME" if side == "home" else "AWAY"
        flag = " *** BET" if is_bet else ""
        inj_note = ""
        if h_imp > 0 or a_imp > 0:
            inj_note = f"  inj=H:{h_imp:.2f}/A:{a_imp:.2f}"
        edge_note = f"  edge={edge:+.3f}" if edge is not None else "  edge=n/a"
        matchup_ctx = str(row.get("matchup_context") or "")
        print(f"  LOG   {away} @ {home}  line={line:+.1f}  → {direction}  conf={conf:.3f}{edge_note}{flag}{inj_note}")
        if matchup_ctx:
            print(f"        {matchup_ctx}")

    print()
    print(f"  Logged {logged} prediction(s).  High-confidence bets: {bets} (threshold={threshold})")
    print(f"  Log file: {MODEL_PERFORMANCE_PATH}")
    return upcoming


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
