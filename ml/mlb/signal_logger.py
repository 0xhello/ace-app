#!/usr/bin/env python3
"""
signal_logger.py — MLB signal tracking DB.

MLB-native schema: probability-based divergence vs the sharp benchmark
across three markets — moneyline (h2h, 2-way), run line (±1.5 standard),
and totals (runs over/under). Intentionally separate from NBA and WC
signal logs.

Tables:
  mlb_signals — one row per signal fired
  meta        — key/value store for job tracking (same pattern as WC)
"""
from __future__ import annotations

import math
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

# Store on the same Railway volume as NBA + WC so we don't need a 3rd volume.
DB_PATH = Path(__file__).resolve().parents[1] / "nba_spread" / "data" / "mlb_signal_log.db"


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


_PICK_COLUMNS: List[tuple] = [
    # Additive only — never remove or rename a deployed column.
    ("confidence_tier",       "TEXT"),
    ("kelly_fraction",        "REAL"),
    ("reasoning_json",        "TEXT"),
    ("closing_pinnacle_prob", "REAL"),
    ("closing_book_odds",     "REAL"),
    ("clv_pp",                "REAL"),
]


def _migrate(conn: sqlite3.Connection) -> None:
    """Idempotently add new columns to mlb_signals. Safe to run repeatedly."""
    existing = {row["name"] for row in conn.execute("PRAGMA table_info(mlb_signals)").fetchall()}
    added = False
    for col, typ in _PICK_COLUMNS:
        if col not in existing:
            conn.execute(f"ALTER TABLE mlb_signals ADD COLUMN {col} {typ}")
            added = True
    if added:
        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
            ("schema:last_migration_at", datetime.now(timezone.utc).isoformat()),
        )
    conn.commit()


def init_db(path: Path = DB_PATH) -> None:
    conn = get_db(path)
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS mlb_signals (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,

            -- Game identification
            game_id         TEXT NOT NULL,
            game_date       DATE NOT NULL,
            home_team       TEXT NOT NULL,
            away_team       TEXT NOT NULL,
            commence_time   TEXT,
            league          TEXT DEFAULT 'MLB',

            -- Signal
            market          TEXT NOT NULL,   -- 'h2h' | 'run_line' | 'totals'
            bet_side        TEXT NOT NULL,   -- 'home'|'away' | 'over'|'under'
            line            REAL,            -- run_line spread (e.g. -1.5) or totals line (e.g. 8.5)
            signal_type     TEXT NOT NULL DEFAULT 'divergence',

            -- Odds & edge
            pinnacle_prob   REAL,            -- sharp benchmark de-vigged prob for bet_side
            book            TEXT NOT NULL,   -- soft book that triggered
            book_prob       REAL,            -- de-vigged soft book prob for bet_side
            book_odds       REAL,            -- American odds at soft book for bet_side
            edge_pp         REAL,            -- pinnacle_prob - book_prob

            -- Outcome (filled after game)
            home_score      INTEGER,
            away_score      INTEGER,
            result          TEXT,            -- actual: 'home'|'away'|'over'|'under'|'push'
            correct         INTEGER,         -- 1=won, 0=lost, NULL=pending/push/void

            -- Lifecycle
            status          TEXT NOT NULL DEFAULT 'open',  -- 'open'|'graded'|'void'
            notes           TEXT,
            detected_at     TEXT NOT NULL,
            created_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE UNIQUE INDEX IF NOT EXISTS uidx_mlb_signal
            ON mlb_signals(game_id, market, bet_side);

        CREATE INDEX IF NOT EXISTS idx_mlb_game_id ON mlb_signals(game_id);
        CREATE INDEX IF NOT EXISTS idx_mlb_status  ON mlb_signals(status);
        CREATE INDEX IF NOT EXISTS idx_mlb_date    ON mlb_signals(game_date);

        CREATE TABLE IF NOT EXISTS meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL DEFAULT ''
        );
    """)
    _migrate(conn)
    conn.close()


# ---------------------------------------------------------------------------
# Meta helpers
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
# De-vig + pick-quality helpers
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


def _american_to_decimal(odds: float) -> float:
    if odds == 0:
        return 1.0
    return odds / 100.0 + 1.0 if odds > 0 else 100.0 / abs(odds) + 1.0


def confidence_tier(edge_pp: float) -> str:
    """A (>=7pp) / B (>=4pp) / C (>=3pp). Matches WC tier thresholds for now."""
    if edge_pp is None:
        return "C"
    if edge_pp >= 0.07:
        return "A"
    if edge_pp >= 0.04:
        return "B"
    return "C"


def kelly_fraction(true_prob: float, book_odds: float, kelly_mult: float = 0.5, cap: float = 0.05) -> float:
    """Half-Kelly with 5% cap. Same math as WC — divergence-driven sizing."""
    if true_prob is None or true_prob <= 0 or true_prob >= 1:
        return 0.0
    decimal = _american_to_decimal(book_odds)
    b = decimal - 1.0
    if b <= 0:
        return 0.0
    q = 1.0 - true_prob
    f_star = (b * true_prob - q) / b
    if f_star <= 0:
        return 0.0
    return min(f_star * kelly_mult, cap)


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
    line: Optional[float] = None,
    notes: str = "",
    reasoning_json: Optional[str] = None,
    path: Path = DB_PATH,
) -> int:
    """Insert a new signal-as-pick. Returns row id, or 0 on duplicate."""
    init_db(path)
    conn = get_db(path)
    detected_at = datetime.now(timezone.utc).isoformat()

    tier  = confidence_tier(edge_pp)
    kelly = kelly_fraction(_null_float(pinnacle_prob) or 0.0, _null_float(book_odds) or 0.0)

    cursor = conn.execute(
        """
        INSERT OR IGNORE INTO mlb_signals
            (game_id, game_date, home_team, away_team, commence_time,
             market, bet_side, line,
             pinnacle_prob, book, book_prob, book_odds, edge_pp,
             confidence_tier, kelly_fraction, reasoning_json,
             notes, detected_at)
        VALUES (?,?,?,?,?, ?,?,?, ?,?,?,?,?, ?,?,?, ?,?)
        """,
        (
            game_id, game_date, home_team, away_team, commence_time,
            market, bet_side, _null_float(line),
            _null_float(pinnacle_prob), book, _null_float(book_prob),
            _null_float(book_odds), _null_float(edge_pp),
            tier, kelly, reasoning_json,
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
            "SELECT * FROM mlb_signals WHERE status = 'open' ORDER BY detected_at DESC"
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
            "SELECT * FROM mlb_signals ORDER BY detected_at DESC"
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]
    except Exception:
        return []


def update_closing_lines(
    game_id: str,
    pinnacle_probs_by_side: Dict[str, float],
    book_odds_by_side_book: Dict[tuple, float],
    path: Path = DB_PATH,
) -> int:
    """Stamp closing snapshots onto open signals. First capture wins."""
    init_db(path)
    conn = get_db(path)
    open_rows = conn.execute(
        """SELECT id, market, bet_side, book, book_prob
           FROM mlb_signals
           WHERE game_id = ? AND status = 'open' AND closing_pinnacle_prob IS NULL""",
        (game_id,),
    ).fetchall()

    updated = 0
    for row in open_rows:
        side = row["bet_side"]
        closing_pin = _null_float(pinnacle_probs_by_side.get(side))
        closing_odds = _null_float(book_odds_by_side_book.get((row["book"], side)))
        if closing_pin is None:
            continue
        book_prob = _null_float(row["book_prob"])
        clv = (closing_pin - book_prob) if book_prob is not None else None
        conn.execute(
            """UPDATE mlb_signals
               SET closing_pinnacle_prob = ?, closing_book_odds = ?, clv_pp = ?
               WHERE id = ?""",
            (closing_pin, closing_odds, clv, row["id"]),
        )
        updated += 1
    conn.commit()
    conn.close()
    return updated


def grade_signal(
    game_id: str,
    home_score: int,
    away_score: int,
    path: Path = DB_PATH,
) -> List[Dict[str, Any]]:
    """
    Grade all open signals for game_id based on final scores.

    MLB market settlement:
      h2h:      home wins if home_score > away_score, else away (no draws in baseball)
      run_line: home covers if (home_score - away_score) + line > 0; push if exact 0
                  line is stored as the home spread (e.g. -1.5 means home favored by 1.5)
      totals:   over if home+away > line, under if <, push if exact equal
    """
    init_db(path)
    conn = get_db(path)
    signals = conn.execute(
        "SELECT * FROM mlb_signals WHERE game_id = ? AND status = 'open'",
        (game_id,),
    ).fetchall()

    graded = []
    for sig in signals:
        market   = sig["market"]
        bet_side = sig["bet_side"]
        result: Optional[str] = None
        correct: Optional[int] = None

        if market == "h2h":
            result = "home" if home_score > away_score else "away"
            correct = 1 if result == bet_side else 0

        elif market == "run_line":
            line = sig["line"]
            if line is None:
                pass
            else:
                # `line` stored as home spread convention
                margin = (home_score - away_score) + line
                if margin > 0:
                    result = "home"; correct = 1 if bet_side == "home" else 0
                elif margin < 0:
                    result = "away"; correct = 1 if bet_side == "away" else 0
                else:
                    result = "push"; correct = None  # rare with ±1.5 lines

        elif market == "totals":
            line = sig["line"]
            total = home_score + away_score
            if line is None:
                pass
            elif total > line:
                result = "over";  correct = 1 if bet_side == "over"  else 0
            elif total < line:
                result = "under"; correct = 1 if bet_side == "under" else 0
            else:
                result = "push";  correct = None

        status = "graded" if correct is not None else ("void" if result == "push" else "open")
        conn.execute(
            """UPDATE mlb_signals
               SET home_score = ?, away_score = ?, result = ?, correct = ?, status = ?
               WHERE id = ?""",
            (home_score, away_score, result, correct, status, sig["id"]),
        )
        graded.append({**dict(sig), "result": result, "correct": correct})
    conn.commit()
    conn.close()
    return graded
