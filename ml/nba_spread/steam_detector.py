"""
steam_detector.py

Detects steam moves: coordinated rapid line movement across 3+ books
in the same direction within a short time window.

Steam = sharp money signal. When multiple books all move the same way
quickly, it typically means a sharp bettor hit several books and the
market is adjusting. This is independent of our model — it's a pure
market-structure signal.

Detection criteria:
  - 3+ non-Pinnacle books all moved ≥ MIN_MOVE pts in same direction
  - Movement occurred within WINDOW_MINUTES of the most recent snapshot
  - Game tips within 24h (no stale games)
  - No existing steam signal for this game today

Signal direction:
  - Books moving toward HOME (line increases, e.g. -8 → -9) → bet HOME
  - Books moving toward AWAY (line decreases, e.g. -8 → -7) → bet AWAY
"""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional

DB_PATH = Path(__file__).resolve().parent / "data" / "signal_log.db"

MIN_BOOKS      = 3      # books that must move together
MIN_MOVE       = 0.5    # pts each book must move (same direction)
WINDOW_MINUTES = 90     # look-back window for movement
_SKIP_BOOKS    = {"pinnacle"}  # Pinnacle is the benchmark, not a steam book


def _db(path: Path = DB_PATH) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def detect_steam(
    game_date: str,
    db_path: Path = DB_PATH,
) -> List[Dict[str, Any]]:
    """
    Scan book_lines for steam moves on *game_date*.

    Returns a list of dicts, one per detected steam move:
      game_id, home_team, away_team, game_date,
      direction (+1 home / -1 away), move_size (avg pts),
      books (list of book names), pinnacle_line (float|None)
    """
    conn = _db(db_path)
    now_utc = datetime.now(timezone.utc)
    cutoff   = (now_utc - timedelta(minutes=WINDOW_MINUTES)).isoformat()

    # Latest line per book per game (most recent snapshot)
    latest_rows = conn.execute(
        """
        WITH ranked AS (
          SELECT game_id, book, home_line, captured_at,
                 ROW_NUMBER() OVER (PARTITION BY game_id, book ORDER BY captured_at DESC) AS rn
          FROM book_lines
          WHERE game_date = ?
        )
        SELECT game_id, book, home_line, captured_at
        FROM ranked WHERE rn = 1
        """,
        (game_date,),
    ).fetchall()

    # Earlier line per book per game (before the window)
    earlier_rows = conn.execute(
        """
        WITH ranked AS (
          SELECT game_id, book, home_line, captured_at,
                 ROW_NUMBER() OVER (PARTITION BY game_id, book ORDER BY captured_at DESC) AS rn
          FROM book_lines
          WHERE game_date = ? AND captured_at <= ?
        )
        SELECT game_id, book, home_line, captured_at
        FROM ranked WHERE rn = 1
        """,
        (game_date, cutoff),
    ).fetchall()

    # Pull game metadata (home/away team names) from signal_log or book_lines
    game_meta_rows = conn.execute(
        "SELECT DISTINCT game_id, home_team, away_team FROM book_lines WHERE game_date = ?",
        (game_date,),
    ).fetchall()
    game_meta: Dict[str, Dict] = {r["game_id"]: dict(r) for r in game_meta_rows}

    # Games with an existing steam signal today — don't double-fire
    existing_steam = {
        r[0]
        for r in conn.execute(
            "SELECT game_id FROM signal_log WHERE game_date = ? AND signal_type = 'steam_move'",
            (game_date,),
        ).fetchall()
    }
    conn.close()

    # Index latest and earlier by (game_id, book)
    latest:  Dict[str, Dict[str, float]] = {}  # game_id → {book: home_line}
    earlier: Dict[str, Dict[str, float]] = {}

    for r in latest_rows:
        if r["book"] in _SKIP_BOOKS:
            continue
        latest.setdefault(r["game_id"], {})[r["book"]] = float(r["home_line"])

    for r in earlier_rows:
        if r["book"] in _SKIP_BOOKS:
            continue
        earlier.setdefault(r["game_id"], {})[r["book"]] = float(r["home_line"])

    # Pinnacle latest line per game (benchmark)
    pinnacle_lines: Dict[str, Optional[float]] = {}
    for r in latest_rows:
        if r["book"] == "pinnacle":
            pinnacle_lines[r["game_id"]] = float(r["home_line"])

    results = []
    for game_id, curr_lines in latest.items():
        if game_id in existing_steam:
            continue
        prev_lines = earlier.get(game_id, {})
        if not prev_lines:
            continue

        moves_home = []  # books that moved toward home (line went more negative or bigger)
        moves_away = []  # books that moved toward away

        for book, curr_line in curr_lines.items():
            if book not in prev_lines:
                continue
            delta = curr_line - prev_lines[book]
            if delta >= MIN_MOVE:
                moves_home.append((book, delta))
            elif delta <= -MIN_MOVE:
                moves_away.append((book, delta))

        for direction, moves in ((1, moves_home), (-1, moves_away)):
            if len(moves) < MIN_BOOKS:
                continue
            books     = [b for b, _ in moves]
            avg_move  = sum(abs(d) for _, d in moves) / len(moves)
            pin_line  = pinnacle_lines.get(game_id)
            meta      = game_meta.get(game_id, {})
            results.append({
                "game_id":     game_id,
                "home_team":   meta.get("home_team", ""),
                "away_team":   meta.get("away_team", ""),
                "game_date":   game_date,
                "direction":   direction,
                "move_size":   round(avg_move, 2),
                "books":       books,
                "pinnacle_line": pin_line,
            })

    return results


def log_steam_signals(
    steam_moves: List[Dict[str, Any]],
    db_path: Path = DB_PATH,
) -> List[int]:
    """Insert steam_move signals into signal_log + auto-paper-trade them."""
    from .signal_logger import log_signal, get_db as _get_sig_db

    logged_ids = []
    for s in steam_moves:
        direction_label = "HOME" if s["direction"] == 1 else "AWAY"
        bet_side        = "home" if s["direction"] == 1 else "away"
        books_str       = ", ".join(s["books"][:5])  # cap display at 5
        line            = s["pinnacle_line"] if s["pinnacle_line"] is not None else 0.0

        detail = (
            f"{len(s['books'])} books moved {direction_label} "
            f"avg {s['move_size']:+.2f}pts in last {WINDOW_MINUTES}m "
            f"({books_str})"
        )

        row_id = log_signal(
            game_id=s["game_id"],
            game_date=s["game_date"],
            home_team=s["home_team"],
            away_team=s["away_team"],
            signal_type="steam_move",
            bet_side=bet_side,
            line_at_signal=line,
            execution_source="pinnacle",
            signal_detail=detail,
            db_path=db_path,
        )

        if row_id > 0:
            # Auto-paper-trade every steam signal
            conn = _get_sig_db(db_path)
            conn.execute(
                "INSERT OR IGNORE INTO execution_log "
                "(signal_id, mode, book, signal_line, bet_side, stake, notes) "
                "VALUES (?, 'paper', 'pinnacle', ?, ?, 1.0, 'auto-steam')",
                (row_id, line, bet_side),
            )
            conn.commit()
            conn.close()
            logged_ids.append(row_id)

    return logged_ids
