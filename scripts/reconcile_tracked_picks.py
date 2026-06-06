#!/usr/bin/env python3
"""Reconcile stale canonical tracked picks.

Local/operator tool for cleaning `tracked_picks.db` without mutating the
sport-specific source logs. It only updates canonical rows that are still open.

Current resolvers:
- MLB: official MLB Stats API schedule endpoint by game date.
- Soccer approved UCL pilot: explicit reviewed result override, because the
  production soccer DB did not cache the final score for that synthetic/pilot
  approved-picks game_id.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Optional, Tuple

APP_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = APP_ROOT / "ml" / "nba_spread" / "data" / "tracked_picks.db"

# Reviewed against public match reports on 2026-06-06.
# PSG 1-1 Arsenal; PSG won 4-3 on penalties. For totals/BTTS, penalties do not
# create additional goals. ACE approved rows were totals_2.5 over and BTTS yes.
SOCCER_RESULT_OVERRIDES: Dict[str, Dict[str, Any]] = {
    "ucl_final_2026_psg_arsenal": {
        "home_score": 1,
        "away_score": 1,
        "status": "final",
        "source": "manual_review: PSG 1-1 Arsenal, PSG 4-3 pens",
    }
}

@dataclass
class Grade:
    result: str
    result_detail: str
    home_score: int
    away_score: int
    pnl_units: float
    notes: str


def connect(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def american_profit(stake: float, odds: Optional[float]) -> float:
    if odds is None:
        return stake * (100 / 110)
    odds = float(odds)
    if odds > 0:
        return stake * (odds / 100)
    if odds < 0:
        return stake * (100 / abs(odds))
    return 0.0


def pnl_for(result: str, stake: Optional[float], odds: Optional[float]) -> float:
    s = float(stake if stake is not None else 1.0)
    if result == "win":
        return round(american_profit(s, odds), 6)
    if result == "loss":
        return round(-s, 6)
    return 0.0


def grade_market(row: sqlite3.Row, home_score: int, away_score: int, notes: str) -> Grade:
    market = str(row["market"])
    side = str(row["side"])
    line = row["line"]
    odds = row["odds_american"]
    stake = row["stake_units"]

    result_detail = "unknown"
    correct: Optional[bool] = None

    if market in ("h2h", "moneyline"):
        if home_score == away_score:
            result_detail = "push"
            correct = None
        else:
            winner = "home" if home_score > away_score else "away"
            result_detail = winner
            correct = side == winner
    elif market == "run_line":
        if line is None:
            result_detail = "void"
            correct = None
        else:
            if side == "home":
                margin = home_score + float(line) - away_score
            else:
                margin = away_score + float(line) - home_score
            if margin > 0:
                correct = True
                result_detail = side
            elif margin < 0:
                correct = False
                result_detail = "home" if side == "away" else "away"
            else:
                correct = None
                result_detail = "push"
    elif market in ("totals", "totals_2.5"):
        total = home_score + away_score
        threshold = float(line if line is not None else 2.5)
        if total > threshold:
            result_detail = "over"
            correct = side == "over"
        elif total < threshold:
            result_detail = "under"
            correct = side == "under"
        else:
            result_detail = "push"
            correct = None
    elif market == "btts":
        actual = "yes" if home_score > 0 and away_score > 0 else "no"
        result_detail = actual
        correct = side == actual
    else:
        result_detail = "void"
        correct = None

    if correct is True:
        result = "win"
    elif correct is False:
        result = "loss"
    else:
        result = "push"

    return Grade(
        result=result,
        result_detail=result_detail,
        home_score=home_score,
        away_score=away_score,
        pnl_units=pnl_for(result, stake, odds),
        notes=notes,
    )


def fetch_mlb_scores(date: str) -> Dict[Tuple[str, str], Tuple[int, int, str]]:
    url = f"https://statsapi.mlb.com/api/v1/schedule?sportId=1&date={date}&hydrate=linescore"
    with urllib.request.urlopen(url, timeout=30) as resp:
        data = json.load(resp)
    out: Dict[Tuple[str, str], Tuple[int, int, str]] = {}
    for day in data.get("dates", []):
        for game in day.get("games", []):
            if game.get("status", {}).get("detailedState") != "Final":
                continue
            home = game["teams"]["home"]["team"]["name"]
            away = game["teams"]["away"]["team"]["name"]
            home_score = int(game["teams"]["home"].get("score"))
            away_score = int(game["teams"]["away"].get("score"))
            out[(home, away)] = (home_score, away_score, f"mlb_statsapi:{game['gamePk']}")
    return out


def open_rows(conn: sqlite3.Connection) -> Iterable[sqlite3.Row]:
    return conn.execute(
        """
        SELECT * FROM tracked_picks
        WHERE lifecycle='open'
        ORDER BY COALESCE(commence_time, tracked_at), id
        """
    ).fetchall()


def update_row(conn: sqlite3.Connection, row: sqlite3.Row, grade: Grade, apply: bool) -> None:
    if not apply:
        return
    conn.execute(
        """
        UPDATE tracked_picks
           SET lifecycle='graded',
               result=?,
               result_detail=?,
               home_score=?,
               away_score=?,
               pnl_units=?,
               graded_at=?,
               notes=COALESCE(NULLIF(notes, ''), ?) || CASE WHEN notes IS NULL OR notes='' THEN '' ELSE ' | ' || ? END,
               updated_at=datetime('now')
         WHERE id=?
        """,
        (
            grade.result,
            grade.result_detail,
            grade.home_score,
            grade.away_score,
            grade.pnl_units,
            datetime.now(timezone.utc).isoformat(),
            grade.notes,
            grade.notes,
            row["id"],
        ),
    )


def reconcile(db_path: Path, apply: bool) -> Dict[str, Any]:
    conn = connect(db_path)
    rows = list(open_rows(conn))
    mlb_cache: Dict[str, Dict[Tuple[str, str], Tuple[int, int, str]]] = {}
    actions = []

    for row in rows:
        sport = row["sport"]
        grade: Optional[Grade] = None
        if sport == "mlb" and row["game_date"]:
            date = row["game_date"]
            if date not in mlb_cache:
                mlb_cache[date] = fetch_mlb_scores(date)
            key = (row["home_team"], row["away_team"])
            score = mlb_cache[date].get(key)
            if score:
                home_score, away_score, source = score
                grade = grade_market(row, home_score, away_score, source)
        elif sport == "soccer" and row["game_id"] in SOCCER_RESULT_OVERRIDES:
            info = SOCCER_RESULT_OVERRIDES[row["game_id"]]
            grade = grade_market(row, int(info["home_score"]), int(info["away_score"]), str(info["source"]))

        if grade:
            update_row(conn, row, grade, apply)
            actions.append({
                "id": row["id"],
                "sport": sport,
                "matchup": row["matchup_label"],
                "market": row["market"],
                "side": row["side"],
                "result": grade.result,
                "detail": grade.result_detail,
                "score": f"{grade.away_score}-{grade.home_score}",
                "pnl_units": grade.pnl_units,
                "notes": grade.notes,
            })

    if apply:
        conn.commit()
    remaining = conn.execute("SELECT COUNT(*) c FROM tracked_picks WHERE lifecycle='open'").fetchone()["c"]
    graded = conn.execute("SELECT COUNT(*) c FROM tracked_picks WHERE lifecycle='graded'").fetchone()["c"]
    conn.close()
    return {"apply": apply, "rows_seen": len(rows), "rows_graded": len(actions), "remaining_open": remaining, "graded_total": graded, "actions": actions}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    print(json.dumps(reconcile(args.db, args.apply), indent=2))

if __name__ == "__main__":
    main()
