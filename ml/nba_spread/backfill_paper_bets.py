#!/usr/bin/env python3
"""
backfill_paper_bets.py

One-off script: for every graded signal that has no paper execution,
create the paper bet and immediately grade it.

Run once on Railway to sync the execution_log with historical signals:
    railway run python3 -m ml.nba_spread.backfill_paper_bets
"""
from __future__ import annotations

from pathlib import Path

from .signal_logger import DB_PATH, get_db, init_db, log_paper_execution, grade_executions


def run(db_path: Path = DB_PATH) -> None:
    init_db(db_path)
    conn = get_db(db_path)

    rows = conn.execute(
        """
        SELECT id, bet_side, line_at_signal, execution_source, covered, game_date,
               home_team, away_team
        FROM signal_log
        WHERE status = 'graded'
          AND covered IS NOT NULL
        ORDER BY game_date ASC
        """
    ).fetchall()
    conn.close()

    backfilled = 0
    for row in rows:
        signal_id = row["id"]
        exec_id = log_paper_execution(
            signal_id,
            row["execution_source"] or "",
            row["line_at_signal"],
            row["bet_side"],
            notes="auto-backfill",
            db_path=db_path,
        )
        if exec_id:
            n = grade_executions(signal_id, row["covered"], db_path=db_path)
            if n:
                side = row["bet_side"].upper()
                covered_str = {1: "covered", 0: "missed"}.get(row["covered"], "push")
                print(
                    f"  backfilled #{signal_id}  {row['game_date']}  "
                    f"{row['away_team']} @ {row['home_team']}  "
                    f"{side}  → {covered_str}"
                )
                backfilled += 1

    print(f"\n  Done. {backfilled} paper bet(s) backfilled.")


if __name__ == "__main__":
    run()
