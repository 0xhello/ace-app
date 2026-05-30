#!/usr/bin/env python3
"""
ACE Worker — production server daemon.

Runs on Railway as a worker service. Owns all time-based tasks that were
previously split across cron jobs and the local LaunchAgent watcher.

Schedule (all times ET):
  Every 60s (within 6h of tip) / every 10min (otherwise) — odds snapshot + divergence check
  08:00 daily  — update_team_state
  09:00 daily  — grade_results (NBA)
  09:30 daily  — fetch_and_predict (full model run)
  15:30 daily  — check_injury_updates
  Sun 05:00    — player_values
  Sun 05:30    — fetch_team_styles + compute_archetypes + segment_model_performance

  World Cup (active window: May 18 – Jul 20; tournament Jun 11 – Jul 19):
  Every poll tick  — wc_fetch_signals (divergence scan; no-op when API
                     returns 422 for inactive sport keys)
  09:00 daily      — wc_grade_results

  MLB (active window: Mar 1 – Nov 15):
  Every poll tick  — mlb_fetch_signals (ML / run line / totals divergence)
  06:00 daily      — mlb_grade_results (covers west-coast late games)

Usage:
    python3 -m ml.nba_spread.worker         # production (blocking)
    python3 -m ml.nba_spread.worker --once  # single snapshot + exit (smoke test)
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import sqlite3
import subprocess
import sys
import time
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

from .fetch_and_predict import run as _snapshot_run
from .signal_logger import update_meta

# World Cup module — imported lazily so a missing dep doesn't kill the NBA worker
try:
    from ml.world_cup.fetch_signals import run as _wc_fetch_run
    from ml.world_cup.signal_logger import update_meta as _wc_update_meta
    from ml.world_cup.context import sync_all as _wc_sync_context, sync_lineups as _wc_sync_lineups
    from ml.world_cup.players import sync_all_players as _wc_sync_players
    from ml.world_cup.market_probe import run_probe as _wc_market_probe
    # Sportmonks-based WC squad sync — replaces the suspended API-Football path
    # when SPORTMONKS_API_TOKEN is available (which it always is on prod).
    from ml.world_cup.sportmonks_squads import sync_wc_2026_squads as _wc_sync_squads_sportmonks
    # Sportmonks topscorers → wc_player_form. Pairs with sportmonks_squads
    # above: squads give us "who's in the WC pool", topscorers give us
    # "how many goals each has this season" — together they drive
    # compute_all_priors().
    from ml.world_cup.sportmonks_form import sync_topscorers_for_all_leagues as _wc_sync_form_sportmonks
    from ml.world_cup.players import compute_all_priors as _wc_compute_priors
    _WC_AVAILABLE = True
except Exception:
    _WC_AVAILABLE = False

# European club leagues + UCL — same divergence engine as WC, different sport
# keys. Loaded lazily so a missing dep doesn't kill the rest of the worker.
try:
    from ml.soccer.leagues import run_active_leagues as _soccer_leagues_run
    _SOCCER_LEAGUES_AVAILABLE = True
except Exception:
    _SOCCER_LEAGUES_AVAILABLE = False

# Soccer live-pick bridge: Odds fixture -> Sportmonks state -> prop prices.
# Runs inside this Railway worker, not via external cron.
try:
    from ml.soccer.live_pipeline import run as _soccer_live_pipeline_run
    _SOCCER_LIVE_PIPELINE_AVAILABLE = True
except Exception:
    _SOCCER_LIVE_PIPELINE_AVAILABLE = False

try:
    from ml.soccer.sportmonks_inventory import run as _sportmonks_inventory_run
    _SPORTMONKS_INVENTORY_AVAILABLE = True
except Exception:
    _SPORTMONKS_INVENTORY_AVAILABLE = False

# Understat / soccerdata xG ingest — feeds the M9 xG-prior adjustment.
# soccerdata package is optional; if not installed, the ingest will fail
# gracefully and xG priors will no-op until somebody runs the ingest.
try:
    from ml.soccer.understat_cache import (
        ingest as _understat_ingest,
        BIG_FIVE_UNDERSTAT as _UNDERSTAT_LEAGUES,
        DEFAULT_SEASON as _UNDERSTAT_SEASON,
    )
    _UNDERSTAT_INGEST_AVAILABLE = True
except Exception:
    _UNDERSTAT_INGEST_AVAILABLE = False

# Soccer grading — settles game-level model candidates + player-prop cards
# once matches complete. Daily 9am ET tick so all weekend games settle by
# Monday morning.
try:
    from ml.soccer.candidates import grade_candidates as _soccer_grade_candidates
    from ml.soccer.candidates import scan as _soccer_candidates_scan
    from ml.soccer.candidates import backfill_from_form as _soccer_backfill_candidates
    from ml.soccer.live_state import grade_prop_cards as _soccer_grade_prop_cards
    _SOCCER_GRADING_AVAILABLE = True
    _SOCCER_CANDIDATES_AVAILABLE = True
    _SOCCER_BACKFILL_AVAILABLE = True
except Exception:
    _SOCCER_GRADING_AVAILABLE = False
    _SOCCER_CANDIDATES_AVAILABLE = False
    _SOCCER_BACKFILL_AVAILABLE = False

# M19 — Approved-pick CLV capture + post-match grading. Runs every tick:
# captures closing line at ±30 min from kickoff and grades approved picks
# whose games have settled. Both helpers are no-ops when there's nothing
# to do (no open picks, no quotes available) so the tick cost is bounded.
try:
    from ml.soccer.approved_picks import (
        capture_closing_prices as _ap_capture_closing,
        grade_approved_picks as _ap_grade,
    )
    from ml.soccer.leagues import LEAGUES as _SOCCER_LEAGUES_CONST
    from ml.soccer.leagues import fetch_league_odds as _fetch_league_odds
    _APPROVED_PICKS_AVAILABLE = True
except Exception:
    _APPROVED_PICKS_AVAILABLE = False


def _approved_picks_close_lookup(game_id: str, market: str, side: str) -> Optional[Dict[str, Any]]:
    """Callback for capture_closing_prices: find the best current quote
    for (game_id, market, side) across all our cached league feeds.

    Walks every cached sport_key (Big-5 + UCL) looking for the matching
    game_id, then scans the bookmakers' h2h/totals/btts markets. Returns
    the side's highest American price + book, or None if not findable.
    """
    market_lower = market.lower()
    side_lower = side.lower()
    for sport_key, _league, _active_until in _SOCCER_LEAGUES_CONST:
        try:
            games = _fetch_league_odds(sport_key) or []
        except Exception:
            continue
        game = next((g for g in games if g.get("id") == game_id), None)
        if not game:
            continue
        best_price: Optional[float] = None
        best_book: Optional[str] = None
        for bm in game.get("bookmakers") or []:
            book = bm.get("key")
            for mkt in bm.get("markets") or []:
                mk = mkt.get("key") or ""
                if market_lower == "1x2" and mk != "h2h":
                    continue
                if market_lower.startswith("totals") and mk != "totals":
                    continue
                if market_lower == "btts" and mk != "btts":
                    continue
                for o in (mkt.get("outcomes") or []):
                    name = (o.get("name") or "").lower()
                    matches = False
                    if market_lower == "1x2":
                        # name is the team name or "Draw"
                        if side_lower == "draw" and name == "draw":
                            matches = True
                        elif side_lower in ("home", "away"):
                            # need to know home/away to match — derive from game
                            home = (game.get("home_team") or "").lower()
                            away = (game.get("away_team") or "").lower()
                            if side_lower == "home" and name == home:
                                matches = True
                            elif side_lower == "away" and name == away:
                                matches = True
                    elif market_lower.startswith("totals"):
                        if name == side_lower and o.get("point") in (2.5, 2):
                            matches = True
                    elif market_lower == "btts":
                        if name == side_lower:
                            matches = True
                    if not matches:
                        continue
                    price = o.get("price")
                    if price is None:
                        continue
                    if best_price is None or float(price) > best_price:
                        best_price = float(price)
                        best_book = book
        if best_price is not None:
            return {"price": best_price, "book": best_book}
    return None


def _approved_picks_result_lookup(game_id: str) -> Optional[Dict[str, Any]]:
    """Callback for grade_approved_picks: return final score + status.

    Reads from soccer_team_form (final scores written by the form ingestor)
    AND from the live Odds API game data when available. None if no result.

    M43: also pulls goal_scorers from the Sportmonks fixture cache when
    the bundle includes events. The list is matched to game_id via the
    persisted fixture_label (we stored fixture_label='PSG vs Arsenal'
    on the approved pick — we re-use it here to look up the cached
    bundle by home/away team names). When goal_scorers is None,
    player-prop markets stay 'open'; when it's a list (possibly empty),
    they grade.
    """
    try:
        from ml.world_cup.signal_logger import DB_PATH as _WC_DB
        conn = sqlite3.connect(str(_WC_DB))
        conn.row_factory = sqlite3.Row
        try:
            # 1. Final score from soccer_model_candidates
            row = conn.execute(
                "SELECT home_score, away_score "
                "FROM soccer_model_candidates "
                "WHERE game_id = ? AND home_score IS NOT NULL "
                "LIMIT 1",
                (game_id,),
            ).fetchone()
            if not row or row["home_score"] is None or row["away_score"] is None:
                return None

            result: Dict[str, Any] = {
                "home_score": int(row["home_score"]),
                "away_score": int(row["away_score"]),
                "status": "final",
            }

            # 2. M43 — goal_scorers via Sportmonks cache. Look up the
            #    approved pick's home/away team names (denormalized on the
            #    cache) to find the right fixture without needing a
            #    fixture_id map.
            try:
                # Look up the bet's fixture team names from approved picks
                ap_row = conn.execute(
                    "SELECT fixture_label, commence_time "
                    "FROM soccer_approved_picks "
                    "WHERE game_id = ? LIMIT 1",
                    (game_id,),
                ).fetchone()
                if ap_row and ap_row["fixture_label"]:
                    label = ap_row["fixture_label"]
                    # Labels are 'Home vs Away · League' — split on ' vs '
                    home_away = label.split(" · ")[0]
                    if " vs " in home_away:
                        h, a = home_away.split(" vs ", 1)
                        from ml.soccer.sportmonks_fixture import (
                            get_cached_bundle_by_teams, get_goal_scorers,
                        )
                        bundle = get_cached_bundle_by_teams(
                            h.strip(), a.strip(),
                            commence_time_iso=ap_row["commence_time"],
                        )
                        scorers = get_goal_scorers(bundle)
                        if scorers is not None:
                            result["goal_scorers"] = scorers
            except Exception:
                # If anything in the goal-scorer lookup breaks, fall back
                # to the score-only result — player-prop picks will stay
                # open and a follow-up run can settle them.
                pass

            return result
        finally:
            conn.close()
    except Exception:
        pass
    return None

# FBref team-form ingestor — daily HTML scrape of Big 5 + UCL schedules.
# Free, no API key. Feeds the pick explainer with real recent-form data
# instead of statistical filler.
try:
    from ml.soccer.form import sync_all as _soccer_form_sync
    _SOCCER_FORM_AVAILABLE = True
except Exception:
    _SOCCER_FORM_AVAILABLE = False

# MLB module — same lazy-load pattern. Divergence-only pipeline (no model yet).
try:
    from ml.mlb.fetch_signals import run as _mlb_fetch_run
    from ml.mlb.signal_logger import update_meta as _mlb_update_meta
    _MLB_AVAILABLE = True
except Exception:
    _MLB_AVAILABLE = False

# World Cup active window — start polling early to collect pre-tournament
# data and shake out the pipeline well before kickoff. The Odds API returns
# 422 for sports without active markets, so polling early is essentially
# free until the pre-tournament books open (~2 weeks out from June 11).
_WC_START = date(2026, 5, 18)
_WC_END   = date(2026, 7, 20)

# MLB regular season + postseason window. Update annually.
# (Spring training opens late Feb; World Series typically wraps early Nov.)
_MLB_START = date(2026, 3, 1)
_MLB_END   = date(2026, 11, 15)

_TZ_ET = ZoneInfo("America/New_York")
_RUNNING = True


# ── Signal handling ────────────────────────────────────────────────────────────

def _handle_signal(sig: int, _frame: object) -> None:
    global _RUNNING
    print(f"\n  [worker] Signal {sig} — shutting down gracefully", flush=True)
    _RUNNING = False


# ── Self-healing soccer-readiness bootstrap ───────────────────────────────────
# The squad/priors data is the prerequisite for player-prop scanning. It was
# previously only refreshed by a daily 7:30am ET tick — which meant a missing
# API_FOOTBALL_KEY (or any transient failure) silently left the system in an
# unusable state for up to 24h with no surfaced error.
#
# This bootstrap runs once on container startup AND retries on each tick if
# the data is still missing (rate-limited to once per hour). The result: a
# fresh container will self-populate within minutes, and any transient
# failure self-heals within the hour — no manual button-clicking required.

_last_squad_attempt: Optional[datetime] = None
_squad_thread: Optional[object] = None  # threading.Thread — typed as object to keep imports lazy


def _squad_count(path: object) -> int:
    """Count rows in wc_players. Returns 0 if the table doesn't exist yet."""
    try:
        from ml.world_cup.signal_logger import get_db  # type: ignore
        conn = get_db(path)
        row = conn.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='wc_players'"
        ).fetchone()
        if not row or row[0] == 0:
            conn.close()
            return 0
        n = conn.execute("SELECT COUNT(*) FROM wc_players").fetchone()[0]
        conn.close()
        return int(n)
    except Exception:
        return 0


def _form_row_count(path: object) -> int:
    """Count rows in wc_player_form. Returns 0 if the table doesn't exist yet.

    Used by the bootstrap gate to detect when squads are populated but form
    is not — the M12/M13 ordering means prod can land with wc_players full
    and wc_player_form empty if Sportmonks lands the squad sync first but
    the topscorers chain fails (or, more commonly, if a prior deploy
    populated only the squads).
    """
    try:
        from ml.world_cup.signal_logger import get_db  # type: ignore
        conn = get_db(path)
        row = conn.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='wc_player_form'"
        ).fetchone()
        if not row or row[0] == 0:
            conn.close()
            return 0
        n = conn.execute("SELECT COUNT(*) FROM wc_player_form").fetchone()[0]
        conn.close()
        return int(n)
    except Exception:
        return 0


def _maybe_bootstrap_soccer_squads(reason: str = "tick") -> None:
    """Ensure wc_players is populated. Idempotent — does nothing when already
    populated. Rate-limited to once per hour on retry to avoid hammering
    API-Football if the key is missing.

    Auto-chains compute_all_priors so the squad data is immediately useful.
    Writes job:players_sync:last_run_at / last_error meta so the ops API can
    surface any failure (missing API_FOOTBALL_KEY, quota, etc.) instead of
    hiding it behind a silent "0 squads" state.

    Runs in a daemon thread so the main worker tick loop keeps polling for
    signals while sync_all_players (~80 throttled API calls = ~10 min on
    Free tier) runs in the background.
    """
    global _last_squad_attempt, _squad_thread
    if not _WC_AVAILABLE:
        return
    # Skip when we're well outside the WC window AND no soccer leagues are
    # being scanned — saves API-Football calls in the offseason.
    today = datetime.now(_TZ_ET).date()
    in_wc_window = _WC_START <= today <= _WC_END
    if not in_wc_window and not _SOCCER_LEAGUES_AVAILABLE:
        return

    # Resolve DB path the same way the rest of the WC code does.
    try:
        from ml.world_cup.signal_logger import DB_PATH as _WC_DB
    except Exception:
        return

    # Bootstrap runs whenever EITHER squads or form is empty. This lets us
    # land M13 (Sportmonks topscorers → wc_player_form) on prod even when
    # wc_players was already populated by an earlier M12 deploy. The chain
    # itself is idempotent (ON CONFLICT UPDATE on every table) so re-running
    # the squad sync just refreshes player metadata — no duplicates.
    n_squads = _squad_count(_WC_DB)
    n_form = _form_row_count(_WC_DB)
    if n_squads > 0 and n_form > 0:
        return  # both populated — nothing to do

    # Don't spawn a second thread if one is already running.
    import threading
    t = _squad_thread
    if isinstance(t, threading.Thread) and t.is_alive():
        return

    # Rate-limit retries — once per hour. Boot attempts always proceed.
    now = datetime.now(timezone.utc)
    if reason == "tick" and _last_squad_attempt is not None:
        if (now - _last_squad_attempt).total_seconds() < 3600:
            return
    _last_squad_attempt = now

    print(f"  [worker] Soccer squads empty — bootstrapping ({reason}) in background…", flush=True)

    new_thread = threading.Thread(
        target=_run_squad_bootstrap_blocking,
        name=f"soccer-bootstrap-{reason}",
        daemon=True,
    )
    _squad_thread = new_thread
    new_thread.start()


def _check_api_football_budget() -> tuple[int, Optional[str]]:
    """One cheap GET to /status — returns (remaining_today, error).
    A full bootstrap needs ~130 calls; if remaining is below that, skip
    the run instead of burning the residual quota on a doomed partial sync.
    """
    try:
        import os, httpx
        api_key = os.getenv("API_FOOTBALL_KEY", "").strip()
        if not api_key:
            return (0, "API_FOOTBALL_KEY not set")
        via_rapid = os.getenv("API_FOOTBALL_VIA_RAPIDAPI", "").lower() in ("1", "true", "yes")
        if via_rapid:
            url = "https://api-football-v3.p.rapidapi.com/v3/status"
            headers = {"X-RapidAPI-Key": api_key,
                       "X-RapidAPI-Host": "api-football-v3.p.rapidapi.com"}
        else:
            url = "https://v3.football.api-sports.io/status"
            headers = {"x-apisports-key": api_key}
        r = httpx.get(url, headers=headers, timeout=8)
        if r.status_code != 200:
            return (0, f"status check returned {r.status_code}")
        body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
        req = (body.get("response", {}) or {}).get("requests", {}) or {}
        current  = int(req.get("current", 0))
        limit    = int(req.get("limit_day", 100))
        return (max(0, limit - current), None)
    except Exception as e:
        return (0, f"status check failed: {str(e)[:200]}")


def _run_squad_bootstrap_blocking() -> None:
    """The actual sync work, run inside the daemon thread spawned above.

    Provider selection:
      • If SPORTMONKS_API_TOKEN is set → use Sportmonks (preferred path; our
        API-Football account has been suspended in the past and Sportmonks
        already covers WC 2026 under our existing paid plan).
      • Otherwise fall back to API-Football (the original path).
    """
    started_at = datetime.now(timezone.utc).isoformat()
    error: Optional[str] = None

    sportmonks_token = (
        os.getenv("SPORTMONKS_API_TOKEN")
        or os.getenv("SPORTMONKS_TOKEN")
        or ""
    ).strip()

    # ── Path A: Sportmonks (preferred when token present) ────────────────────
    if sportmonks_token:
        try:
            print("  [worker] WC squad bootstrap via Sportmonks (season 26618)…", flush=True)
            squad_summary = _wc_sync_squads_sportmonks()
            n_players = int(squad_summary.get("players_synced", 0))
            teams = int(squad_summary.get("teams_seen", 0))
            print(
                f"  [worker] Sportmonks WC squads: {n_players} players across {teams} teams",
                flush=True,
            )

            # Chain topscorers ingest + prior compute so the squad data is
            # immediately useful for player-prop picks. Non-fatal: if topscorers
            # fails (network blip, plan limit), the squad sync still counts as
            # a success and we surface a warning rather than throwing.
            form_summary: Dict[str, object] = {}
            priors_written = 0
            chain_error: Optional[str] = None
            try:
                print("  [worker] WC form via Sportmonks topscorers…", flush=True)
                form_summary = _wc_sync_form_sportmonks()
                print(
                    f"  [worker] Sportmonks topscorers: "
                    f"{form_summary.get('rows_written', 0)} form rows across "
                    f"{form_summary.get('leagues_scanned', 0)} leagues",
                    flush=True,
                )
                priors_written = _wc_compute_priors()
                print(f"  [worker] Goalscorer priors written: {priors_written}", flush=True)
            except Exception as ce:
                chain_error = f"form/priors chain failed: {str(ce)[:240]}"
                print(f"  [worker] {chain_error}", file=sys.stderr, flush=True)

            try:
                _wc_update_meta("job:players_sync:last_run_at", started_at)
                _wc_update_meta("job:players_sync:last_error", chain_error or "")
                _wc_update_meta(
                    "bootstrap:last_stdout",
                    f"[sportmonks] {n_players} players / {teams} teams / "
                    f"{form_summary.get('rows_written', 0)} form / "
                    f"{priors_written} priors",
                )
                _wc_update_meta("bootstrap:last_stderr", chain_error or "")
                _wc_update_meta("job:players_sync:last_provider", "sportmonks")
            except Exception:
                pass
            return
        except Exception as e:
            # Sportmonks failed — fall through to API-Football. Capture the
            # error so we can surface it if the fallback also fails.
            sportmonks_error = f"sportmonks bootstrap failed: {str(e)[:240]}"
            print(f"  [worker] {sportmonks_error}", file=sys.stderr, flush=True)
            error = sportmonks_error

    # ── Path B: API-Football fallback (original path) ────────────────────────
    # Pre-flight quota check — don't waste residual quota on a partial sync.
    remaining, qerr = _check_api_football_budget()
    # Trimmed budget (Free tier): 25 countries + 25 squads + 20 club form +
    # 6 intl form + 1 league call + 1 status = ~78 calls. Add 10 for
    # retry buffer / readiness probes.
    REQUIRED = 90
    if qerr:
        error = qerr if not error else f"{error}; api-football: {qerr}"
    elif remaining < REQUIRED:
        error = (
            f"insufficient API-Football quota: {remaining} calls remaining, "
            f"need ~{REQUIRED} for full sync. Upgrade plan or wait for daily reset."
        )

    if error:
        try:
            _wc_update_meta("job:players_sync:last_run_at", started_at)
            _wc_update_meta("job:players_sync:last_error", error)
            _wc_update_meta("bootstrap:last_stdout", "(pre-flight check failed)\n" + error)
            _wc_update_meta("bootstrap:last_stderr", "")
        except Exception:
            pass
        print(f"  [worker] Bootstrap skipped: {error}", file=sys.stderr, flush=True)
        return

    captured_stdout: list[str] = []
    captured_stderr: list[str] = []

    # Tee print()/stderr output so the next readiness probe can see what
    # the sync chain actually printed (plan-restriction messages, country
    # discovery output, per-team errors). The previous "0 squads → key
    # missing" hint was guesswork; this captures the truth.
    import io, contextlib
    out_buf, err_buf = io.StringIO(), io.StringIO()
    try:
        with contextlib.redirect_stdout(out_buf), contextlib.redirect_stderr(err_buf):
            result = _wc_sync_players()
    except Exception as e:
        error = str(e)
        result = {}

    captured_stdout = out_buf.getvalue().splitlines()
    captured_stderr = err_buf.getvalue().splitlines()

    # Replay to real stdout/stderr so Railway logs still see it.
    for line in captured_stdout:
        print(line, flush=True)
    for line in captured_stderr:
        print(line, file=sys.stderr, flush=True)

    if result and result.get("squads", 0) > 0:
        print(
            f"  [worker] Bootstrap sync: "
            f"{result.get('squads', 0)} squads, "
            f"{result.get('form', 0)} form, "
            f"{result.get('priors', 0)} priors",
            flush=True,
        )
    elif not error:
        # No exception but 0 squads — the captured stderr will tell us why.
        # Pull the most informative line (first 'restriction' / 'error' / 'plan' line).
        for line in captured_stderr:
            if any(kw in line.lower() for kw in ("restriction", "error", "plan", "quota")):
                error = line.strip()[:300]
                break
        if not error:
            error = "sync returned 0 squads (see bootstrap:last_stderr for details)"

    try:
        _wc_update_meta("job:players_sync:last_run_at", started_at)
        _wc_update_meta("job:players_sync:last_error", error or "")
        # Stash the captured streams so /api/ops/wc-readiness can surface them
        _wc_update_meta("bootstrap:last_stdout", "\n".join(captured_stdout)[-4000:])
        _wc_update_meta("bootstrap:last_stderr", "\n".join(captured_stderr)[-4000:])
    except Exception:
        pass


# ── Task scheduler (simple time-window approach, no external deps) ─────────────
# Each task has a window (±minutes from scheduled time) and a last-run tracker.
# The main loop fires every 60s so we'll always land inside a 5-minute window.

_last_daily:  Dict[str, date] = {}   # task → last date it ran
_last_weekly: Dict[str, date] = {}   # task → last date it ran
_last_interval: Dict[str, datetime] = {}  # task → last UTC datetime it ran


def _daily_due(task: str, hour: int, minute: int = 0, window: int = 4) -> bool:
    """True if we're within `window` minutes of the scheduled time and haven't run today."""
    now = datetime.now(_TZ_ET)
    today = now.date()
    if _last_daily.get(task) == today:
        return False
    target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if abs((now - target).total_seconds()) <= window * 60:
        _last_daily[task] = today
        return True
    return False


def _weekly_due(task: str, weekday: int, hour: int, minute: int = 0, window: int = 4) -> bool:
    """True if today is the right weekday, within window minutes, and hasn't run this week."""
    now = datetime.now(_TZ_ET)
    today = now.date()
    if _last_weekly.get(task) == today:
        return False
    if now.weekday() != weekday:  # 6 = Sunday
        return False
    target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if abs((now - target).total_seconds()) <= window * 60:
        _last_weekly[task] = today
        return True
    return False


def _interval_due(task: str, minutes: int) -> bool:
    """True when a server-side interval task is due in this worker process."""
    now = datetime.now(timezone.utc)
    last = _last_interval.get(task)
    if last is not None and (now - last).total_seconds() < minutes * 60:
        return False
    _last_interval[task] = now
    return True


def _run_task(module: str, *extra_args: str) -> None:
    """Run a pipeline module as a subprocess, streaming output to stdout."""
    task_name = module.split(".")[-1]
    cmd = [sys.executable, "-m", module, *extra_args]
    print(f"  [worker] Running: {' '.join(cmd)}", flush=True)
    started_at = datetime.now(timezone.utc).isoformat()
    error: Optional[str] = None
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if result.stdout:
            print(result.stdout, end="", flush=True)
        if result.stderr:
            print(result.stderr, end="", file=sys.stderr, flush=True)
        if result.returncode != 0:
            err_lines = [l.strip() for l in result.stderr.splitlines() if l.strip()]
            error = err_lines[-1] if err_lines else f"exit code {result.returncode}"
            print(f"  [worker] {module} exited {result.returncode}", flush=True)
    except subprocess.TimeoutExpired:
        error = "timed out after 120s"
        print(f"  [worker] {module} timed out after 120s", flush=True)
    except Exception as e:
        error = str(e)
        print(f"  [worker] {module} error: {e}", flush=True)
    try:
        update_meta(f"job:{task_name}:last_run_at", started_at)
        update_meta(f"job:{task_name}:last_error", error or "")
    except Exception:
        pass


def _run_scheduled_tasks() -> None:
    """Check and fire any tasks that are due. Called once per main-loop tick."""

    # ── Daily tasks ────────────────────────────────────────────────────────────
    if _daily_due("update_team_state", hour=8):
        _run_task("ml.nba_spread.update_team_state")

    if _daily_due("grade_results", hour=9):
        _run_task("ml.nba_spread.grade_results", "--days", "2", "--void-stale")

    # Evening passes so results appear same night (11pm and 1am ET cover all game windows)
    if _daily_due("grade_results_evening", hour=23):
        _run_task("ml.nba_spread.grade_results", "--days", "2")

    if _daily_due("grade_results_latenight", hour=1):
        _run_task("ml.nba_spread.grade_results", "--days", "2")

    if _daily_due("fetch_and_predict", hour=9, minute=30):
        _run_task("ml.nba_spread.fetch_and_predict")

    if _daily_due("check_injury_updates", hour=15, minute=30):
        _run_task("ml.nba_spread.check_injury_updates")

    # ── World Cup tasks (active May 18 – Jul 20) ──────────────────────────────
    if _WC_AVAILABLE and _WC_START <= datetime.now(_TZ_ET).date() <= _WC_END:
        if _daily_due("wc_grade_results", hour=9):
            _run_task("ml.world_cup.grade_results", "--days", "3")

        # Daily market probe at 6:45am ET — before the rest of the WC sync
        # so the run loop knows whether player-prop scanning is live for
        # the day. ~10 credits per probe. Auto-flips meta keys when new
        # markets are detected (e.g. wc:player_props_first_seen_at).
        if _daily_due("wc_market_probe", hour=6, minute=45):
            started_at = datetime.now(timezone.utc).isoformat()
            error: Optional[str] = None
            try:
                result = _wc_market_probe()
                live = [m["market"] for m in result.get("markets", []) if m.get("games_with_market", 0) > 0]
                print(f"  [worker] WC market probe: {result.get('total_games', 0)} games, "
                      f"live markets: {', '.join(live) if live else 'none'}", flush=True)
            except Exception as e:
                error = str(e)
                print(f"  [worker] WC market probe error: {e}", file=sys.stderr, flush=True)
            try:
                _wc_update_meta("job:market_probe:last_run_at", started_at)
                _wc_update_meta("job:market_probe:last_error",  error or "")
            except Exception:
                pass

        # Refresh fixtures + standings + card counts once per day at 7am ET
        if _daily_due("wc_context_sync", hour=7):
            try:
                _wc_sync_context()
                _wc_update_meta("job:context_sync:last_error", "")
            except Exception as e:
                print(f"  [worker] WC context sync error: {e}", file=sys.stderr, flush=True)
                try:
                    _wc_update_meta("job:context_sync:last_error", str(e)[:200])
                except Exception:
                    pass

        # Refresh WC squads + club form + intl tournaments (~84 calls).
        # Daily WC squad refresh — keeps player rosters current as managers
        # finalize/swap players in the run-up to kickoff. Prefers Sportmonks
        # (paid, includes WC 2026); falls back to API-Football if SPORTMONKS
        # token is missing.
        if _daily_due("wc_players_sync", hour=7, minute=30):
            started_at = datetime.now(timezone.utc).isoformat()
            error: Optional[str] = None
            sportmonks_token = (
                os.getenv("SPORTMONKS_API_TOKEN")
                or os.getenv("SPORTMONKS_TOKEN")
                or ""
            ).strip()
            if sportmonks_token:
                try:
                    squad_summary = _wc_sync_squads_sportmonks()
                    print(
                        f"  [worker] WC squad sync (sportmonks): "
                        f"{squad_summary.get('players_synced', 0)} players across "
                        f"{squad_summary.get('teams_seen', 0)} teams",
                        flush=True,
                    )
                    # Chain form + priors (best-effort; non-fatal if either fails)
                    try:
                        form_summary = _wc_sync_form_sportmonks()
                        priors_n = _wc_compute_priors()
                        print(
                            f"  [worker] WC form (sportmonks): "
                            f"{form_summary.get('rows_written', 0)} form rows, "
                            f"{priors_n} priors",
                            flush=True,
                        )
                    except Exception as ce:
                        print(f"  [worker] form/priors chain failed: {ce}",
                              file=sys.stderr, flush=True)
                    _wc_update_meta("job:players_sync:last_provider", "sportmonks")
                except Exception as e:
                    error = f"sportmonks sync failed: {str(e)[:240]}"
                    print(f"  [worker] {error}", file=sys.stderr, flush=True)
            else:
                # Fall back to API-Football if Sportmonks token isn't set.
                try:
                    result = _wc_sync_players()
                    print(f"  [worker] WC players sync (api-football): "
                          f"{result.get('squads', 0)} squads, "
                          f"{result.get('form', 0)} form rows, "
                          f"{result.get('priors', 0)} priors", flush=True)
                except Exception as e:
                    error = str(e)
                    print(f"  [worker] WC players sync error: {e}",
                          file=sys.stderr, flush=True)
            try:
                _wc_update_meta("job:players_sync:last_run_at", started_at)
                _wc_update_meta("job:players_sync:last_error", error or "")
            except Exception:
                pass

    # ── Soccer live-pick bridge / inventory (server-side worker, no cron) ─────
    # Inventory runs once daily so we know what the Sportmonks trial actually
    # exposes. The live pipeline runs every 30 minutes: map upcoming Odds
    # fixtures to Sportmonks, sync live state, then price/generate prop cards.
    if _SPORTMONKS_INVENTORY_AVAILABLE and _daily_due("sportmonks_inventory", hour=6, minute=10):
        started_at = datetime.now(timezone.utc).isoformat()
        error = None
        try:
            result = _sportmonks_inventory_run()
            print(f"  [worker] Sportmonks inventory: {len(result.get('probes', {}))} probes", flush=True)
        except Exception as e:
            error = str(e)
            print(f"  [worker] Sportmonks inventory error: {e}", file=sys.stderr, flush=True)
        try:
            _wc_update_meta("job:sportmonks_inventory:last_run_at", started_at)
            _wc_update_meta("job:sportmonks_inventory:last_error", error or "")
        except Exception:
            pass

    # ── FBref team-form refresh (daily 6 AM ET, free) ─────────────────────────
    # One HTTP pull per Big 5 + UCL league = 6 requests. Polite-paced.
    # Feeds the explainer with real recent-form data + xG.
    if _SOCCER_FORM_AVAILABLE and _daily_due("soccer_form_sync", hour=6, minute=0):
        started_at = datetime.now(timezone.utc).isoformat()
        error = None
        try:
            result = _soccer_form_sync()
            print(f"  [worker] FBref form sync: {result}", flush=True)
        except Exception as e:
            error = str(e)
            print(f"  [worker] FBref form sync error: {e}", file=sys.stderr, flush=True)
        try:
            _wc_update_meta("job:form_sync:last_run_at", started_at)
            _wc_update_meta("job:form_sync:last_error", error or "")
        except Exception:
            pass

    # ── MLB tasks (active during season) ──────────────────────────────────────
    if _MLB_AVAILABLE and _MLB_START <= datetime.now(_TZ_ET).date() <= _MLB_END:
        # MLB schedules games every day during the season; grade at 6am ET
        # so all west-coast late games are settled before the morning poll.
        if _daily_due("mlb_grade_results", hour=6):
            _run_task("ml.mlb.grade_results", "--days", "3")

    # ── Weekly tasks (Sunday) ─────────────────────────────────────────────────
    if _weekly_due("player_values", weekday=6, hour=5):
        _run_task("ml.nba_spread.player_values")

    if _weekly_due("weekly_refresh", weekday=6, hour=5, minute=30):
        _run_task("ml.nba_spread.fetch_team_styles")
        _run_task("ml.nba_spread.compute_archetypes")
        _run_task("ml.nba_spread.segment_model_performance")


# ── Tip time cache ─────────────────────────────────────────────────────────────

_tip_cache: List[datetime] = []
_tip_cache_date: str = ""


def _cache_tips(upcoming: Optional[List]) -> None:
    global _tip_cache, _tip_cache_date
    if not upcoming:
        return
    today = datetime.now(_TZ_ET).strftime("%Y-%m-%d")
    tips = []
    for g in upcoming:
        try:
            tips.append(datetime.fromisoformat(g["commence_time"].replace("Z", "+00:00")))
        except Exception:
            pass
    _tip_cache = sorted(tips)
    _tip_cache_date = today


def _first_upcoming_tip() -> Optional[datetime]:
    today = datetime.now(_TZ_ET).strftime("%Y-%m-%d")
    if _tip_cache_date != today:
        return None
    now = datetime.now(timezone.utc)
    future = [t for t in _tip_cache if t > now]
    return min(future) if future else None


# ── Adaptive poll interval ─────────────────────────────────────────────────────

def _seconds_until_6am() -> int:
    now = datetime.now(_TZ_ET)
    target = now.replace(hour=6, minute=0, second=0, microsecond=0)
    if now >= target:
        target += timedelta(days=1)
    return max(60, int((target - now).total_seconds()))


def _poll_interval() -> tuple[int, str]:
    now_et = datetime.now(_TZ_ET)

    if now_et.hour < 6:
        secs = _seconds_until_6am()
        return secs, f"before 6am ET — sleeping until morning ({secs//3600}h {(secs%3600)//60}m)"

    tip = _first_upcoming_tip()

    if tip is None:
        secs = _seconds_until_6am()
        return secs, f"no games cached — sleeping until 6am ET ({secs//3600}h {(secs%3600)//60}m)"

    now_utc = datetime.now(timezone.utc)
    hours_to_tip = (tip - now_utc).total_seconds() / 3600

    if hours_to_tip > 2:
        return 900, f"{hours_to_tip:.1f}h to tip — 15 min poll"
    elif hours_to_tip > 0:
        return 300, f"{hours_to_tip:.1f}h to tip — 5 min poll"
    else:
        return 900, "games in progress — 15 min poll"


# ── Interruptible sleep ────────────────────────────────────────────────────────

def _sleep(seconds: int) -> None:
    elapsed = 0
    while elapsed < seconds and _RUNNING:
        chunk = min(30, seconds - elapsed)
        time.sleep(chunk)
        elapsed += chunk


# ── Main loop ──────────────────────────────────────────────────────────────────

def run_loop(once: bool = False) -> None:
    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    print("=" * 55, flush=True)
    print("  ACE Worker — started", flush=True)
    print(f"  {datetime.now(_TZ_ET).strftime('%Y-%m-%d %H:%M:%S ET')}", flush=True)
    print("=" * 55, flush=True)

    # Boot-time self-heal: if soccer squad data is missing (e.g. fresh
    # container, or a previous deploy where sync failed), populate it now
    # rather than waiting for the 7:30am ET daily tick. Idempotent.
    try:
        _maybe_bootstrap_soccer_squads(reason="boot")
    except Exception as e:
        print(f"  [worker] Bootstrap hook error (non-fatal): {e}",
              file=sys.stderr, flush=True)

    # Boot-time team-form sync — only if the table is empty. ~15s, free.
    # Without this, fresh containers wait until 6 AM ET for form data to
    # appear, which means picks fired in the interim get generic narratives
    # instead of "Liverpool last 5 home: 3W-2D-0L" context.
    if _SOCCER_FORM_AVAILABLE:
        try:
            from ml.world_cup.signal_logger import DB_PATH as _WC_DB
            from ml.soccer.form import get_db as _form_db  # type: ignore
            conn = _form_db(_WC_DB)
            try:
                row = conn.execute(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='soccer_team_form'"
                ).fetchone()
                form_rows = 0
                if row and row[0] > 0:
                    form_rows = int(
                        conn.execute("SELECT COUNT(*) FROM soccer_team_form").fetchone()[0]
                    )
            finally:
                conn.close()
            if form_rows == 0:
                print("  [worker] Soccer team-form table empty — bootstrapping…", flush=True)
                _soccer_form_sync()
        except Exception as e:
            print(f"  [worker] Form bootstrap error (non-fatal): {e}",
                  file=sys.stderr, flush=True)

    # Boot-time soccer pick backfill — populates the ops dashboard with a
    # 45-day track record on first deploy. Idempotent: skips if any
    # backfilled rows already exist. Refits the model out-of-sample so the
    # ROI numbers shown are honest (no leakage).
    # The user sees real picks + real graded results immediately instead
    # of staring at an empty table during the between-seasons gap.
    if _SOCCER_BACKFILL_AVAILABLE:
        try:
            from ml.world_cup.signal_logger import DB_PATH as _WC_DB2
            conn2 = sqlite3.connect(str(_WC_DB2))
            try:
                row = conn2.execute(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' "
                    "AND name='soccer_model_candidates'"
                ).fetchone()
                # Count rows that the ops UI will ACTUALLY surface (excludes
                # the legacy book='pinnacle' rows that list_candidates filters
                # out because US subscribers can't bet there). If 0 visible
                # rows, re-run the backfill — it self-cleans legacy pinnacle
                # rows + reinserts under book='market_close'.
                visible_rows = 0
                if row and row[0] > 0:
                    visible_rows = int(conn2.execute(
                        "SELECT COUNT(*) FROM soccer_model_candidates "
                        "WHERE rationale_json LIKE '%backfill%' "
                        "AND book = 'market_close'"
                    ).fetchone()[0])
            finally:
                conn2.close()
            if visible_rows == 0:
                print("  [worker] No visible backfilled candidates — running 45-day backfill…", flush=True)
                bf = _soccer_backfill_candidates(days_back=45)
                print(f"  [worker] Backfill complete: {bf}", flush=True)
            else:
                print(f"  [worker] {visible_rows} backfilled candidates already in DB — skipping backfill",
                      flush=True)
        except Exception as e:
            print(f"  [worker] Soccer candidate backfill error (non-fatal): {e}",
                  file=sys.stderr, flush=True)

    # Boot-time Understat xG ingest — fills soccer_source_team_match_stats so
    # M9 xG priors actually fire on prod predictions. Runs in a daemon thread
    # because soccerdata pulls 5 leagues × per-team HTTP fetches (~30-60s); we
    # don't want to block the worker tick startup or the scheduled jobs.
    # Idempotent: skips if the table already has rows.
    if _UNDERSTAT_INGEST_AVAILABLE:
        try:
            from ml.world_cup.signal_logger import DB_PATH as _WC_DB3
            conn3 = sqlite3.connect(str(_WC_DB3))
            try:
                row = conn3.execute(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' "
                    "AND name='soccer_source_team_match_stats'"
                ).fetchone()
                xg_rows = 0
                if row and row[0] > 0:
                    xg_rows = int(conn3.execute(
                        "SELECT COUNT(*) FROM soccer_source_team_match_stats"
                    ).fetchone()[0])
            finally:
                conn3.close()
            if xg_rows == 0:
                print("  [worker] Understat xG table empty — bootstrapping in background…",
                      flush=True)
                import threading

                def _understat_bootstrap_thread():
                    try:
                        n = _understat_ingest(_UNDERSTAT_LEAGUES, season=_UNDERSTAT_SEASON)
                        print(f"  [worker] Understat bootstrap complete: {n} rows ingested",
                              flush=True)
                    except Exception as e:
                        print(f"  [worker] Understat bootstrap thread error (non-fatal): {e}",
                              file=sys.stderr, flush=True)

                threading.Thread(
                    target=_understat_bootstrap_thread,
                    name="understat-bootstrap",
                    daemon=True,
                ).start()
            else:
                print(f"  [worker] Understat xG table has {xg_rows} rows — skipping bootstrap",
                      flush=True)
        except Exception as e:
            print(f"  [worker] Understat bootstrap error (non-fatal): {e}",
                  file=sys.stderr, flush=True)

    while _RUNNING:
        # Scheduled tasks first (non-blocking time checks)
        _run_scheduled_tasks()

        # Per-tick self-heal — retries every hour while squads remain empty.
        # No-op once squad data is populated. Surfaces the underlying error
        # (missing API_FOOTBALL_KEY etc.) via job:players_sync:last_error.
        try:
            _maybe_bootstrap_soccer_squads(reason="tick")
        except Exception as e:
            print(f"  [worker] Bootstrap hook error (non-fatal): {e}",
                  file=sys.stderr, flush=True)

        # Snapshot poll — returns upcoming games for tip-time caching
        try:
            upcoming = _snapshot_run(snapshot_only=True)
            _cache_tips(upcoming)
            update_meta("last_poll_at", datetime.now(timezone.utc).isoformat())
            update_meta("last_poll_ok", "1")
        except Exception as e:
            print(f"  [worker] Snapshot error: {e}", file=sys.stderr, flush=True)
            try:
                update_meta("last_poll_at", datetime.now(timezone.utc).isoformat())
                update_meta("last_poll_ok", "0")
            except Exception:
                pass

        # World Cup signal scan (when active window)
        if _WC_AVAILABLE and _WC_START <= datetime.now(_TZ_ET).date() <= _WC_END:
            try:
                _wc_fetch_run(snapshot_only=False)
                _wc_update_meta("last_poll_at", datetime.now(timezone.utc).isoformat())
                _wc_update_meta("last_poll_ok", "1")
            except Exception as e:
                print(f"  [worker] WC scan error: {e}", file=sys.stderr, flush=True)
                try:
                    _wc_update_meta("last_poll_at", datetime.now(timezone.utc).isoformat())
                    _wc_update_meta("last_poll_ok", "0")
                except Exception:
                    pass

        # M38 — Sportmonks pre-match fixture bundle sync. Discovers Big-5,
        # UCL and WC fixtures over the next 3 days and pulls each one's
        # projected lineup + 28 prediction markets into the local cache
        # at soccer_sportmonks_fixture_cache. Downstream prop-card builds
        # use this to replace the assumed_minutes=74 heuristic with real
        # XI minutes (zero regression vs the legacy path when the cache
        # misses — see player_props._minutes_from_lineup).
        #
        # Gated to once per hour because:
        #   - The /fixtures/between discovery call costs 1 credit regardless
        #     of whether anything changed, and rate-limit-friendly cadence
        #     is what we want.
        #   - Individual fixture refreshes inside sync_slate() are gated by
        #     the module's own refresh policy (24h far / 6h near to kickoff),
        #     so calling more often wouldn't burn extra fixture credits but
        #     would burn a discovery credit per call.
        if _interval_due("sportmonks_fixture_sync", minutes=60):
            try:
                from ml.soccer.sportmonks_fixture import sync_slate
                summary = sync_slate(days=3)
                print(
                    f"  [worker] sportmonks slate: discovered={summary['discovered']} "
                    f"fetched={summary['fetched']} skipped={summary['skipped']} "
                    f"errors={len(summary['errors'])}",
                    flush=True,
                )
                _wc_update_meta(
                    "job:sportmonks_fixture_sync:last_run_at",
                    datetime.now(timezone.utc).isoformat(),
                )
                _wc_update_meta("job:sportmonks_fixture_sync:last_error", "")
            except Exception as e:
                print(
                    f"  [worker] sportmonks fixture sync error: {e}",
                    file=sys.stderr, flush=True,
                )
                try:
                    _wc_update_meta(
                        "job:sportmonks_fixture_sync:last_error", str(e)[:200],
                    )
                except Exception:
                    pass

        # European club leagues + UCL — same divergence engine as WC, just
        # different sport keys. Each league's active_until date gates whether
        # it runs (we skip Bundesliga after May 17, EPL after May 25, etc.).
        # Signals land in soccer_signals tagged with `tournament` so the ops
        # dashboard can slice or aggregate per league.
        if _SOCCER_LEAGUES_AVAILABLE:
            try:
                summary = _soccer_leagues_run(snapshot_only=False)
                fired = sum(s.get("signals_fired", 0) for s in summary.values())
                if fired > 0:
                    print(f"  [worker] soccer leagues: {fired} signals across {len(summary)} active", flush=True)
                # Re-use the WC meta keys so the ops dashboard treats all
                # soccer scans uniformly. (Could split per-league later if
                # we want separate freshness signals per competition.)
                _wc_update_meta("job:soccer_leagues:last_run_at",
                                datetime.now(timezone.utc).isoformat())
                _wc_update_meta("job:soccer_leagues:last_error", "")
            except Exception as e:
                print(f"  [worker] soccer leagues scan error: {e}", file=sys.stderr, flush=True)
                try:
                    _wc_update_meta("job:soccer_leagues:last_error", str(e)[:200])
                except Exception:
                    pass

        # Soccer model-pick grading. Daily 9am ET — weekend games settle in
        # by Monday morning. Both game-level model candidates AND player-prop
        # cards get graded; either failure stays isolated.
        if _SOCCER_GRADING_AVAILABLE and _daily_due("soccer_grade_picks", hour=9, minute=15):
            started_at = datetime.now(timezone.utc).isoformat()
            try:
                cand_res = _soccer_grade_candidates(days_back=5)
                print(f"  [worker] soccer grade candidates: {cand_res}", flush=True)
                _wc_update_meta("job:soccer_grade_candidates:last_run_at", started_at)
                _wc_update_meta("job:soccer_grade_candidates:last_error", "")
            except Exception as e:
                print(f"  [worker] soccer grade candidates error: {e}", file=sys.stderr, flush=True)
                try: _wc_update_meta("job:soccer_grade_candidates:last_error", str(e)[:200])
                except Exception: pass
            try:
                prop_res = _soccer_grade_prop_cards()
                print(f"  [worker] soccer grade prop cards: {prop_res}", flush=True)
                _wc_update_meta("job:soccer_grade_prop_cards:last_run_at", started_at)
                _wc_update_meta("job:soccer_grade_prop_cards:last_error", "")
            except Exception as e:
                print(f"  [worker] soccer grade prop cards error: {e}", file=sys.stderr, flush=True)
                try: _wc_update_meta("job:soccer_grade_prop_cards:last_error", str(e)[:200])
                except Exception: pass

        # Game-level model candidate scan — produces soccer_model_candidates
        # rows when our DC+shrunk model probability diverges from de-vigged
        # book by enough. Same 30-min cadence as live_pipeline so the two
        # stay in lockstep. Failure here doesn't block prop cards.
        if _SOCCER_CANDIDATES_AVAILABLE and _interval_due("soccer_candidates", minutes=30):
            started_at = datetime.now(timezone.utc).isoformat()
            try:
                cs = _soccer_candidates_scan(horizon_hours=72)
                print(f"  [worker] soccer candidates scan: {cs}", flush=True)
                _wc_update_meta("job:soccer_candidates:last_run_at", started_at)
                _wc_update_meta("job:soccer_candidates:last_error", "")
            except Exception as e:
                print(f"  [worker] soccer candidates scan error: {e}", file=sys.stderr, flush=True)
                try: _wc_update_meta("job:soccer_candidates:last_error", str(e)[:200])
                except Exception: pass

        # Soccer live prop-pick bridge. Server-side interval, not OpenClaw cron.
        # Bounded to 4 per-event prop-price fetches/run to control Odds API spend.
        if _SOCCER_LIVE_PIPELINE_AVAILABLE and _interval_due("soccer_live_pipeline", minutes=30):
            try:
                result = _soccer_live_pipeline_run(
                    horizon_hours=168,
                    with_market=True,
                    max_market_events=4,
                    limit_per_team=4,
                    sync_limit=12,
                )
                props = result.get("prop_cards", {})
                mapping = result.get("mapping", {})
                live_state = result.get("live_state", {})
                print(
                    f"  [worker] soccer live pipeline: mapped={mapping.get('mapped', 0)} "
                    f"synced={live_state.get('synced', 0)} cards={props.get('cards', 0)} "
                    f"priced={props.get('priced_cards', 0)}",
                    flush=True,
                )
            except Exception as e:
                print(f"  [worker] soccer live pipeline error: {e}", file=sys.stderr, flush=True)
                try:
                    _wc_update_meta("job:soccer_live_pipeline:last_error", str(e)[:200])
                except Exception:
                    pass

        # M19 — Approved-pick closing-line capture + grading. Every 10 min.
        # Cheap: only acts on picks within ±30min of kickoff. Closing capture
        # walks our cached league odds (read-through Redis — no API spend).
        if _APPROVED_PICKS_AVAILABLE and _interval_due("approved_picks_clv", minutes=10):
            try:
                clv = _ap_capture_closing(open_odds_lookup=_approved_picks_close_lookup)
                if clv.get("captured", 0) > 0:
                    print(
                        f"  [worker] approved-picks CLV capture: {clv['captured']} closed, "
                        f"{clv['skipped_no_quote']} no-quote, "
                        f"{clv['skipped_not_in_window']} not-in-window",
                        flush=True,
                    )
                graded = _ap_grade(result_lookup=_approved_picks_result_lookup)
                if graded.get("graded", 0) > 0:
                    print(f"  [worker] approved-picks graded: {graded['graded']}", flush=True)
                try:
                    _wc_update_meta(
                        "job:approved_picks:last_run_at",
                        datetime.now(timezone.utc).isoformat(),
                    )
                    _wc_update_meta(
                        "job:approved_picks:last_summary",
                        json.dumps({"clv": clv, "graded": graded}),
                    )
                except Exception:
                    pass
            except Exception as e:
                print(f"  [worker] approved-picks error: {e}", file=sys.stderr, flush=True)

        # MLB signal scan (when active window)
        if _MLB_AVAILABLE and _MLB_START <= datetime.now(_TZ_ET).date() <= _MLB_END:
            try:
                _mlb_fetch_run(snapshot_only=False)
                _mlb_update_meta("last_poll_at", datetime.now(timezone.utc).isoformat())
                _mlb_update_meta("last_poll_ok", "1")
            except Exception as e:
                print(f"  [worker] MLB scan error: {e}", file=sys.stderr, flush=True)
                try:
                    _mlb_update_meta("last_poll_at", datetime.now(timezone.utc).isoformat())
                    _mlb_update_meta("last_poll_ok", "0")
                except Exception:
                    pass

        if once:
            break

        secs, reason = _poll_interval()
        ts = datetime.now(_TZ_ET).strftime("%H:%M:%S ET")
        print(f"  [worker] {ts} — {reason}", flush=True)
        _sleep(secs)

    print("  [worker] Stopped.", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="ACE production worker daemon")
    parser.add_argument("--once", action="store_true", help="Single poll then exit")
    args = parser.parse_args()
    try:
        run_loop(once=args.once)
    except Exception as e:
        print(f"\n  [worker] Fatal: {e}", file=sys.stderr)
        sys.exit(1)
