#!/usr/bin/env python3
"""
ACE Worker — production server daemon.

Runs on Railway as a worker service. Owns all time-based tasks that were
previously split across cron jobs and the local LaunchAgent watcher.

Schedule (all times ET):
  Every 60s (within 6h of tip) / every 10min (otherwise) — odds snapshot + divergence check
  08:00 daily  — update_team_state
  09:00 daily  — grade_results
  12:00 daily  — fetch_and_predict (full model run)
  15:30 daily  — check_injury_updates
  Sun 05:00    — player_values
  Sun 05:30    — fetch_team_styles + compute_archetypes + segment_model_performance

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

_TZ_ET = ZoneInfo("America/New_York")
_RUNNING = True


# ── Signal handling ────────────────────────────────────────────────────────────

def _handle_signal(sig: int, _frame: object) -> None:
    global _RUNNING
    print(f"\n  [worker] Signal {sig} — shutting down gracefully", flush=True)
    _RUNNING = False


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
        result = subprocess.run(cmd, capture_output=False, timeout=120)
        if result.returncode != 0:
            error = f"exit code {result.returncode}"
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

    if _daily_due("fetch_and_predict", hour=12):
        _run_task("ml.nba_spread.fetch_and_predict")

    if _daily_due("check_injury_updates", hour=15, minute=30):
        _run_task("ml.nba_spread.check_injury_updates")

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

    while _RUNNING:
        # Scheduled tasks first (non-blocking time checks)
        _run_scheduled_tasks()

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
