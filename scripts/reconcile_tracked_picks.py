#!/usr/bin/env python3
"""Compatibility wrapper for canonical tracked-picks grading.

Kept so older docs/commands that call scripts/reconcile_tracked_picks.py
still work. New code should use `python3 -m ml.ops.grade_tracked_picks`.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1]
if str(APP_ROOT) not in sys.path:
    sys.path.insert(0, str(APP_ROOT))

from ml.ops.grade_tracked_picks import DEFAULT_DB, reconcile


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    print(json.dumps(reconcile(args.db, apply=args.apply), indent=2))


if __name__ == "__main__":
    main()
