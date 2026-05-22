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
import signal
import subprocess
import sys
import time
from datetime import date, datetime, timedelta, timezone
from typing import Dict, List, Optional
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


def _maybe_bootstrap_soccer_squads(reason: str = "tick") -> None:
    """Ensure wc_players is populated. Idempotent — does nothing when already
    populated. Rate-limited to once per hour on retry to avoid hammering
    API-Football if the key is missing.

    Auto-chains compute_all_priors so the squad data is immediately useful.
    Writes job:players_sync:last_run_at / last_error meta so the ops API can
    surface any failure (missing API_FOOTBALL_KEY, quota, etc.) instead of
    hiding it behind a silent "0 squads" state.
    """
    global _last_squad_attempt
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

    if _squad_count(_WC_DB) > 0:
        return  # already populated — nothing to do

    # Rate-limit retries — once per hour. Boot attempts always proceed.
    now = datetime.now(timezone.utc)
    if reason == "tick" and _last_squad_attempt is not None:
        if (now - _last_squad_attempt).total_seconds() < 3600:
            return
    _last_squad_attempt = now

    print(f"  [worker] Soccer squads empty — bootstrapping ({reason})…", flush=True)
    started_at = now.isoformat()
    error: Optional[str] = None
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
        # Auto-chains compute_all_priors at the end so the freshly-synced
        # squad data immediately has priors ready for the next fetch tick.
        # Runs at 7:30am ET so it doesn't collide with sync_context.
        if _daily_due("wc_players_sync", hour=7, minute=30):
            started_at = datetime.now(timezone.utc).isoformat()
            error = None
            try:
                result = _wc_sync_players()
                print(f"  [worker] WC players sync: "
                      f"{result.get('squads', 0)} squads, "
                      f"{result.get('form', 0)} form rows, "
                      f"{result.get('priors', 0)} priors", flush=True)
            except Exception as e:
                error = str(e)
                print(f"  [worker] WC players sync error: {e}", file=sys.stderr, flush=True)
            try:
                _wc_update_meta("job:players_sync:last_run_at", started_at)
                _wc_update_meta("job:players_sync:last_error",  error or "")
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
