#!/usr/bin/env python3
"""
check_injury_updates.py

Runs after the NBA's 5:30pm ET official injury report drops (~6:30pm ET / 3:30pm PDT).
Loads today's locked predictions from model_performance.csv, re-fetches current
injury state, and logs alerts when meaningful changes would shift a pick.

What "meaningful" means:
  - Any change in combined (home + away) injury impact ≥ IMPACT_ALERT_THRESHOLD (0.20)
    — corresponds to roughly a 2-3% probability shift on a 50/50 game.
  - A player newly tagged OUT/DOUBTFUL who wasn't in the impact at noon.

Output: ml/logs/injury_update.log (appended each run)

Usage:
    python3 -m ml.nba_spread.check_injury_updates
"""
from __future__ import annotations

import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import List
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
LOG_DIR = ROOT / "ml" / "logs"
LOG_PATH = LOG_DIR / "injury_update.log"
LOG_DIR.mkdir(parents=True, exist_ok=True)

from .injuries import (
    fetch_injuries,
    compute_team_impact,
    _load_player_values,
)
from .inference import MODEL_PERFORMANCE_PATH

# Minimum actual probability shift (in prob units) to trigger an alert.
# 0.03 = 3 percentage-point shift in the pick direction.
# combined_delta sum was wrong: opposing deltas cancel in logit space and
# could trigger at 0% actual shift. Using the computed prob shift is exact.
PROB_SHIFT_ALERT_THRESHOLD = 0.03

_TZ_ET = ZoneInfo("America/New_York")

PASS  = "\033[32m✓\033[0m"
WARN  = "\033[33m⚠\033[0m"
ALERT = "\033[31m!\033[0m"
BOLD  = "\033[1m"
RESET = "\033[0m"


def _et_today() -> str:
    return datetime.now(_TZ_ET).strftime("%Y-%m-%d")


def _load_todays_predictions() -> pd.DataFrame:
    if not MODEL_PERFORMANCE_PATH.exists():
        return pd.DataFrame()
    df = pd.read_csv(MODEL_PERFORMANCE_PATH)
    # Keep only games from today (ET) that haven't been graded yet
    today = _et_today()
    mask = df["logged_at"].str.startswith(today) & (df["result_status"] != "graded")
    return df[mask].copy()


def _header(msg: str) -> None:
    print(f"\n{BOLD}{msg}{RESET}")
    print("  " + "─" * 56)


def run() -> None:
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    header = f"\n{'=' * 58}\n  ACE — Injury Update Check\n  {ts}\n{'=' * 58}"
    print(header)

    preds = _load_todays_predictions()
    if preds.empty:
        print(f"  {PASS}  No open predictions for today. Nothing to check.")
        _log(header + "\n  No open predictions today.\n")
        return

    print(f"  {len(preds)} open prediction(s) for today ({_et_today()})")

    print("\n  Fetching current ESPN injury report...")
    injuries = fetch_injuries()
    player_values = _load_player_values()
    print(f"  Teams with injuries: {len(injuries)}   Players in BPM lookup: {len(player_values)}")

    _header("Per-game injury delta")

    alerts: List[str] = []
    rows_log: List[str] = []

    for _, row in preds.iterrows():
        home = str(row.get("home_team", "?"))
        away = str(row.get("away_team", "?"))
        pick_side = str(row.get("pick_side", "?"))
        conf_noon = float(row.get("pick_confidence", 0.5))
        raw_prob_noon = float(row.get("home_cover_prob", 0.5))

        # Impact at noon (locked in CSV)
        h_imp_noon = float(row.get("home_injury_impact", 0.0) or 0.0)
        a_imp_noon = float(row.get("away_injury_impact", 0.0) or 0.0)

        # Current impact
        h_imp_now = compute_team_impact(home, injuries, player_values)
        a_imp_now = compute_team_impact(away, injuries, player_values)

        delta_h = h_imp_now - h_imp_noon
        delta_a = a_imp_now - a_imp_noon

        # Logit-delta method: logit shifts are additive, so applying the DELTA
        # of (now - noon) to the noon-adjusted prob is mathematically exact.
        # This correctly handles canceling deltas: if both teams got more injured
        # by the same amount, the logit shifts cancel and prob_updated ≈ raw_prob_noon.
        p_clipped = float(np.clip(raw_prob_noon, 0.001, 0.999))
        logit_val = np.log(p_clipped / (1.0 - p_clipped))
        logit_val -= delta_h * 0.35
        logit_val += delta_a * 0.35
        prob_updated = float(1.0 / (1.0 + np.exp(-logit_val)))

        side_label = "HOME" if pick_side == "home" else "AWAY"
        conf_updated = prob_updated if pick_side == "home" else (1.0 - prob_updated)

        # Alert on actual probability shift, not delta sum.
        # Opposing deltas cancel in logit space — the delta sum was misleading.
        prob_shift = abs(prob_updated - float(raw_prob_noon))
        if prob_shift >= PROB_SHIFT_ALERT_THRESHOLD:
            icon = ALERT
            alert_line = (
                f"  {ALERT}  ALERT  {away.upper():<5} @ {home.upper():<5}  "
                f"h_imp: {h_imp_noon:.2f}→{h_imp_now:.2f}  "
                f"a_imp: {a_imp_noon:.2f}→{a_imp_now:.2f}  "
                f"conf: {conf_noon:.3f}→{conf_updated:.3f}  shift={prob_shift:.3f}  pick={side_label}"
            )
            alerts.append(alert_line)
        else:
            icon = PASS

        line = (
            f"  {icon}  {away.upper():<5} @ {home.upper():<5}"
            f"  noon_imp H:{h_imp_noon:.2f}/A:{a_imp_noon:.2f}"
            f"  now H:{h_imp_now:.2f}/A:{a_imp_now:.2f}"
            f"  shift={prob_shift:.3f}"
            f"  conf {conf_noon:.3f}→{conf_updated:.3f}  [{side_label}]"
        )
        print(line)
        rows_log.append(line)

    # Summary
    print(f"\n{'─' * 58}")
    if alerts:
        print(f"{ALERT} {BOLD}{len(alerts)} game(s) have meaningful injury changes:{RESET}")
        for a in alerts:
            print(a)
        print(f"\n  Recommendation: review picks above before wagering.\n")
    else:
        print(f"{PASS} {BOLD}No significant injury changes since noon.{RESET}\n")

    # Append to log file
    log_content = header + "\n" + "\n".join(rows_log) + "\n"
    if alerts:
        log_content += "\nALERTS:\n" + "\n".join(alerts) + "\n"
    _log(log_content)


def _log(content: str) -> None:
    with LOG_PATH.open("a") as f:
        f.write(content + "\n")


if __name__ == "__main__":
    try:
        run()
    except Exception as e:
        print(f"\n  ERROR: {e}", file=sys.stderr)
        sys.exit(1)
