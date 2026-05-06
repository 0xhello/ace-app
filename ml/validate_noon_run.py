#!/usr/bin/env python3
"""
validate_noon_run.py

One-shot checkpoint for the daily noon prediction run.
Run this immediately after fetch_and_predict fires to confirm everything landed correctly.

Usage:
    python3 ml/validate_noon_run.py

Exit code 0 = all checks passed. Non-zero = at least one failure.
"""
from __future__ import annotations

import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

ROOT       = Path(__file__).resolve().parent.parent
CSV_PATH   = ROOT / "ml" / "nba_spread" / "data" / "model_performance.csv"
DB_PATH    = ROOT / "ml" / "nba_spread" / "data" / "signal_log.db"
FETCH_LOG  = ROOT / "ml" / "logs" / "fetch.log"

PASS = "\033[32m✓\033[0m"
FAIL = "\033[31m✗\033[0m"
WARN = "\033[33m⚠\033[0m"
BOLD = "\033[1m"
RESET = "\033[0m"

failures: list[str] = []
warnings: list[str] = []


def check(label: str, ok: bool, detail: str = "", warn_only: bool = False) -> None:
    icon = PASS if ok else (WARN if warn_only else FAIL)
    print(f"  {icon}  {label}" + (f"  — {detail}" if detail else ""))
    if not ok:
        (warnings if warn_only else failures).append(label)


def section(title: str) -> None:
    print(f"\n{BOLD}{title}{RESET}")
    print("  " + "─" * 52)


# ─────────────────────────────────────────────────────────────
# 1. Load today's predictions from CSV
# ─────────────────────────────────────────────────────────────
section("1. Today's predictions exist in CSV")

if not CSV_PATH.exists():
    check("CSV file exists", False, str(CSV_PATH))
    print(f"\n{FAIL} Cannot continue — CSV missing.\n")
    sys.exit(1)

df = pd.read_csv(CSV_PATH)
now_utc = datetime.now(timezone.utc)
today_utc = now_utc.strftime("%Y-%m-%d")

today_df = df[df["logged_at"].str.startswith(today_utc)].copy()
n = len(today_df)

check("CSV readable", True, f"{len(df)} total rows")
check("Predictions logged today", n > 0, f"{n} rows with logged_at={today_utc}")

if n == 0:
    print(f"\n{WARN}  No predictions logged today yet — run this after the noon cron fires.\n")
    sys.exit(0)

# ─────────────────────────────────────────────────────────────
# 2. Injury data populated
# ─────────────────────────────────────────────────────────────
section("2. Injury data")

inj_col = "injury_data_available"
if inj_col not in today_df.columns:
    check("injury_data_available column present", False, "column missing entirely")
else:
    vals = today_df[inj_col].apply(lambda x: str(x).strip() in ("1", "1.0")).sum()
    check(
        "injury_data_available = 1 on all rows",
        vals == n,
        f"{vals}/{n} rows have it set",
        warn_only=(vals == 0),
    )

# At least one game should have a non-zero impact if any known star is out
h_imp = pd.to_numeric(today_df.get("home_injury_impact", pd.Series(dtype=float)), errors="coerce").fillna(0)
a_imp = pd.to_numeric(today_df.get("away_injury_impact", pd.Series(dtype=float)), errors="coerce").fillna(0)
games_with_adj = ((h_imp > 0) | (a_imp > 0)).sum()
check(
    "At least one game has non-zero injury impact",
    games_with_adj > 0,
    f"{games_with_adj}/{n} games adjusted",
    warn_only=True,   # star players might all be healthy — not a hard failure
)

print()
print("  Game-level injury breakdown:")
for _, row in today_df.iterrows():
    hi = float(pd.to_numeric(row.get("home_injury_impact", 0), errors="coerce") or 0)
    ai = float(pd.to_numeric(row.get("away_injury_impact", 0), errors="coerce") or 0)
    home = str(row.get("home_team", "?")).upper()
    away = str(row.get("away_team", "?")).upper()
    note = f"  h_imp={hi:.2f}  a_imp={ai:.2f}"
    flag = f"  {WARN} adjusted" if (hi + ai) > 0 else ""
    print(f"    {away:<5} @ {home:<5}{note}{flag}")

# ─────────────────────────────────────────────────────────────
# 3. 24-hour cutoff enforced
# ─────────────────────────────────────────────────────────────
section("3. 24-hour horizon cutoff")

stale_games = []
for _, row in today_df.iterrows():
    try:
        logged_at = datetime.fromisoformat(str(row["logged_at"]).replace("Z", "+00:00"))
        if logged_at.tzinfo is None:
            logged_at = logged_at.replace(tzinfo=timezone.utc)
        commence = datetime.fromisoformat(str(row["commence_time"]).replace("Z", "+00:00"))
        delta_h = (commence - logged_at).total_seconds() / 3600
        if delta_h > 24:
            stale_games.append((row.get("home_team"), row.get("away_team"), round(delta_h, 1)))
    except Exception as e:
        warnings.append(f"Could not parse times for row: {e}")

check(
    "No games logged more than 24h before tipoff",
    len(stale_games) == 0,
    f"{len(stale_games)} game(s) outside window: {stale_games}" if stale_games else "all within 24h",
)

# Show time-to-tip for each logged game
print()
print("  Time-to-tip at prediction time:")
for _, row in today_df.iterrows():
    try:
        logged_at = datetime.fromisoformat(str(row["logged_at"]).replace("Z", "+00:00"))
        if logged_at.tzinfo is None:
            logged_at = logged_at.replace(tzinfo=timezone.utc)
        commence = datetime.fromisoformat(str(row["commence_time"]).replace("Z", "+00:00"))
        delta_h = (commence - logged_at).total_seconds() / 3600
        home = str(row.get("home_team", "?")).upper()
        away = str(row.get("away_team", "?")).upper()
        flag = f"  {FAIL} EXCEEDS 24H" if delta_h > 24 else ""
        print(f"    {away:<5} @ {home:<5}  {delta_h:.1f}h to tip{flag}")
    except Exception:
        pass

# ─────────────────────────────────────────────────────────────
# 4. Season column populated
# ─────────────────────────────────────────────────────────────
section("4. Season column")

if "season" not in today_df.columns:
    check("season column present", False, "column missing")
else:
    blank = today_df["season"].apply(lambda x: str(x).strip() in ("", "nan", "None")).sum()
    check(
        "season populated on all rows",
        blank == 0,
        f"{blank}/{n} rows have blank season",
    )
    if blank == 0:
        vals_str = today_df["season"].astype(str).unique().tolist()
        print(f"  season values: {vals_str}")

# ─────────────────────────────────────────────────────────────
# 5. SQLite predictions table in sync
# ─────────────────────────────────────────────────────────────
section("5. SQLite predictions table sync")

if not DB_PATH.exists():
    check("signal_log.db exists", False, str(DB_PATH))
else:
    check("signal_log.db exists", True)
    conn = sqlite3.connect(DB_PATH)
    try:
        today_game_ids = today_df["game_id"].tolist()
        placeholders = ",".join("?" * len(today_game_ids))
        found = conn.execute(
            f"SELECT COUNT(*) FROM predictions WHERE game_id IN ({placeholders})",
            today_game_ids,
        ).fetchone()[0]
        check(
            "All today's game_ids exist in SQLite",
            found == n,
            f"{found}/{n} game_ids found (INSERT OR IGNORE deduplicates repeated game_ids — expected)",
        )
        # Spot-check: season column populated in DB for today's game_ids
        blank_db = conn.execute(
            f"SELECT COUNT(*) FROM predictions WHERE game_id IN ({placeholders}) AND (season IS NULL OR season = '')",
            today_game_ids,
        ).fetchone()[0]
        check(
            "season populated in SQLite for today's games",
            blank_db == 0,
            f"{blank_db}/{found} rows have blank season in DB",
        )
    finally:
        conn.close()

# ─────────────────────────────────────────────────────────────
# 6. Fetch log tail
# ─────────────────────────────────────────────────────────────
section("6. fetch.log — last run output")

if not FETCH_LOG.exists():
    check("fetch.log exists", False)
else:
    check("fetch.log exists", True)
    lines = FETCH_LOG.read_text().splitlines()
    # Find the last run boundary (last occurrence of the header separator)
    last_sep = max((i for i, l in enumerate(lines) if l.startswith("=" * 20)), default=0)
    run_lines = lines[last_sep:]
    print()
    for line in run_lines[-30:]:   # cap at 30 lines
        print(f"    {line}")

# ─────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────
print(f"\n{'─' * 56}")
if failures:
    print(f"{FAIL} {BOLD}{len(failures)} check(s) FAILED:{RESET}")
    for f in failures:
        print(f"    • {f}")
    if warnings:
        print(f"{WARN}  {len(warnings)} warning(s): {', '.join(warnings)}")
    print()
    sys.exit(1)
elif warnings:
    print(f"{WARN} {BOLD}All hard checks passed — {len(warnings)} warning(s):{RESET}")
    for w in warnings:
        print(f"    • {w}")
    print()
    sys.exit(0)
else:
    print(f"{PASS} {BOLD}All checks passed.{RESET}")
    print()
    sys.exit(0)
