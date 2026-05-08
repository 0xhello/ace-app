#!/usr/bin/env python3
"""
Thin wrapper used by the ops dashboard "Grade" / "Run Picks" buttons.
Runs a pipeline module as a subprocess, updates the meta table with
timing and error state so the ops job-status display reflects the run.

Usage:
    python3 -m ml.nba_spread.run_job <module> [extra args...]
    python3 -m ml.nba_spread.run_job ml.nba_spread.grade_results --days 2
"""
from __future__ import annotations

import subprocess
import sys
from datetime import datetime, timezone

from .signal_logger import update_meta


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: run_job <module> [args...]", file=sys.stderr)
        sys.exit(1)

    module = sys.argv[1]
    extra_args = sys.argv[2:]
    task = module.split(".")[-1]

    started_at = datetime.now(timezone.utc).isoformat()
    update_meta(f"job:{task}:last_run_at", started_at)
    update_meta(f"job:{task}:last_error", "")

    error = ""
    try:
        result = subprocess.run(
            [sys.executable, "-m", module, *extra_args],
            capture_output=True,
            text=True,
            timeout=90,
        )
        # Print output so it appears in Railway logs
        if result.stdout:
            print(result.stdout, end="")
        if result.stderr:
            print(result.stderr, end="", file=sys.stderr)

        if result.returncode != 0:
            # Store the last non-empty stderr line as the error snippet
            err_lines = [l.strip() for l in result.stderr.splitlines() if l.strip()]
            error = err_lines[-1] if err_lines else f"exit code {result.returncode}"
    except subprocess.TimeoutExpired:
        error = "timed out after 90s"
    except Exception as e:
        error = str(e)

    if error:
        update_meta(f"job:{task}:last_error", error)
        sys.exit(1)


if __name__ == "__main__":
    main()
