#!/usr/bin/env python3
"""
signal_logger.py — World Cup signal tracking DB.

Schema is soccer-native: probability-based divergence, 3-way h2h outcomes,
and goal totals. Intentionally separate from the NBA signal_log.db.

Tables:
  soccer_signals — one row per signal fired
  meta           — key/value store for job tracking (same pattern as NBA)
"""
from __future__ import annotations

import math
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

# Store in the same volume-backed directory as the NBA data so no second
# Railway volume is needed — ml/nba_spread/data/ is already persistent.
DB_PATH = Path(__file__).resolve().parents[1] / "nba_spread" / "data" / "wc_signal_log.db"


def _null_float(v: Any) -> Optional[float]:
    if v is None or v == "":
        return None
    try:
        f = float(v)
        return None if math.isnan(f) else f
    except (TypeError, ValueError):
        return None


def get_db(path: Path = DB_PATH) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db(path: Path = DB_PATH) -> None:
    conn = get_db(path)
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS soccer_signals (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,

            -- Game identification
            game_id         TEXT NOT NULL,
            game_date       DATE NOT NULL,
            home_team       TEXT NOT NULL,
            away_team       TEXT NOT NULL,
            commence_time   TEXT,
            tournament      TEXT DEFAULT 'FIFA World Cup',

            -- Signal
            market          TEXT NOT NULL,   -- 'h2h' | 'totals'
            bet_side        TEXT NOT NULL,   -- 'home'|'draw'|'away' | 'over'|'under'
            total_line      REAL,            -- goals line for totals signals (e.g. 2.5)
            signal_type     TEXT NOT NULL DEFAULT 'divergence',

            -- Odds & edge
            pinnacle_prob   REAL,            -- de-vigged Pinnacle prob for bet_side
            book            TEXT NOT NULL,   -- soft book that triggered
            book_prob       REAL,            -- de-vigged soft book prob for bet_side
            book_odds       REAL,            -- American odds at soft book for bet_side
            edge_pp         REAL,            -- book_prob - pinnacle_prob (decimal, e.g. 0.04)

            -- Outcome (filled after game)
            home_score      INTEGER,
            away_score      INTEGER,
            result          TEXT,            -- actual: 'home'|'draw'|'away'|'over'|'under'
            correct         INTEGER,         -- 1=won, 0=lost, NULL=pending/void

            -- Lifecycle
            status          TEXT NOT NULL DEFAULT 'open',  -- 'open'|'graded'|'void'
            notes           TEXT,
            detected_at     TEXT NOT NULL,
            created_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE UNIQUE INDEX IF NOT EXISTS uidx_soccer_signal
            ON soccer_signals(game_id, market, bet_side);

        CREATE INDEX IF NOT EXISTS idx_soccer_game_id ON soccer_signals(game_id);
        CREATE INDEX IF NOT EXISTS idx_soccer_status  ON soccer_signals(status);
        CREATE INDEX IF NOT EXISTS idx_soccer_date    ON soccer_signals(game_date);

        CREATE TABLE IF NOT EXISTS meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL DEFAULT ''
        );
    """)
    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# Meta helpers (same pattern as NBA — used by ops job-status strip)
# ---------------------------------------------------------------------------

def update_meta(key: str, value: str, path: Path = DB_PATH) -> None:
    init_db(path)
    conn = get_db(path)
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
        (key, value),
    )
    conn.commit()
    conn.close()


def read_meta(path: Path = DB_PATH) -> Dict[str, str]:
    try:
        conn = get_db(path)
        rows = conn.execute("SELECT key, value FROM meta").fetchall()
        conn.close()
        return {r["key"]: r["value"] for r in rows}
    except Exception:
        return {}


# ---------------------------------------------------------------------------
# De-vig utilities
# ---------------------------------------------------------------------------

def _american_to_raw_prob(odds: float) -> float:
    if odds < 0:
        return abs(odds) / (abs(odds) + 100)
    return 100 / (odds + 100)


def devig(odds_list: List[float]) -> List[float]:
    """Multiplicative de-vig: returns true probabilities that sum to 1.0."""
    raw = [_american_to_raw_prob(o) for o in odds_list]
    total = sum(raw)
    if total == 0:
        return [1.0 / len(raw)] * len(raw)
    return [p / total for p in raw]


# ---------------------------------------------------------------------------
# Signal CRUD
# ---------------------------------------------------------------------------

def log_signal(
    game_id: str,
    game_date: str,
    home_team: str,
    away_team: str,
    commence_time: str,
    market: str,
    bet_side: str,
    pinnacle_prob: float,
    book: str,
    book_prob: float,
    book_odds: float,
    edge_pp: float,
    total_line: Optional[float] = None,
    notes: str = "",
    path: Path = DB_PATH,
) -> int:
    """
    Insert a new signal. Silently ignores duplicates (same game_id + market + bet_side).
    Returns the new row id, or 0 if duplicate.
    """
    init_db(path)
    conn = get_db(path)
    detected_at = datetime.now(timezone.utc).isoformat()
    cursor = conn.execute(
        """
        INSERT OR IGNORE INTO soccer_signals
            (game_id, game_date, home_team, away_team, commence_time,
             market, bet_side, total_line,
             pinnacle_prob, book, book_prob, book_odds, edge_pp,
             notes, detected_at)
        VALUES (?,?,?,?,?, ?,?,?, ?,?,?,?,?, ?,?)
        """,
        (
            game_id, game_date, home_team, away_team, commence_time,
            market, bet_side, _null_float(total_line),
            _null_float(pinnacle_prob), book, _null_float(book_prob),
            _null_float(book_odds), _null_float(edge_pp),
            notes, detected_at,
        ),
    )
    row_id = cursor.lastrowid or 0
    conn.commit()
    conn.close()
    return row_id


def get_open_signals(path: Path = DB_PATH) -> List[Dict[str, Any]]:
    try:
        init_db(path)
        conn = get_db(path)
        rows = conn.execute(
            "SELECT * FROM soccer_signals WHERE status = 'open' ORDER BY detected_at DESC"
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]
    except Exception:
        return []


def get_all_signals(path: Path = DB_PATH) -> List[Dict[str, Any]]:
    try:
        init_db(path)
        conn = get_db(path)
        rows = conn.execute(
            "SELECT * FROM soccer_signals ORDER BY detected_at DESC"
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]
    except Exception:
        return []


def grade_signal(
    game_id: str,
    home_score: int,
    away_score: int,
    path: Path = DB_PATH,
) -> List[Dict[str, Any]]:
    """
    Grade all open signals for game_id based on final scores.
    Returns list of graded signal dicts with 'correct' field set.
    """
    init_db(path)
    conn = get_db(path)
    signals = conn.execute(
        "SELECT * FROM soccer_signals WHERE game_id = ? AND status = 'open'",
        (game_id,),
    ).fetchall()

    graded = []
    for sig in signals:
        market   = sig["market"]
        bet_side = sig["bet_side"]

        # Determine actual result
        if market == "h2h":
            if home_score > away_score:
                result = "home"
            elif home_score == away_score:
                result = "draw"
            else:
                result = "away"
            correct = 1 if result == bet_side else 0

        elif market == "asian_handicap":
            ah_line = sig["total_line"]  # Pinnacle's home line (e.g. -0.5, +1.5)
            if ah_line is None:
                result = None
                correct = None
            else:
                margin = (home_score - away_score) + ah_line
                if margin > 0:
                    result = "home"
                elif margin < 0:
                    result = "away"
                else:
                    result = "void"  # exact push (half-ball lines make this rare)
                correct = (1 if result == bet_side else 0) if result != "void" else None

        elif market == "totals":
            total_line = sig["total_line"]
            goals = home_score + away_score
            if total_line is None:
                result = None
                correct = None
            elif goals > total_line:
                result = "over"
                correct = 1 if bet_side == "over" else 0
            elif goals < total_line:
                result = "under"
                correct = 1 if bet_side == "under" else 0
            else:
                result = "void"   # exact push on total
                correct = None
        else:
            result = None
            correct = None

        status = "graded" if correct is not None else "void"
        conn.execute(
            """
            UPDATE soccer_signals
            SET home_score = ?, away_score = ?, result = ?,
                correct = ?, status = ?
            WHERE id = ?
            """,
            (home_score, away_score, result, correct, status, sig["id"]),
        )
        graded.append({**dict(sig), "result": result, "correct": correct})

    conn.commit()
    conn.close()
    return graded
