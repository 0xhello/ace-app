#!/usr/bin/env python3
"""
signal_logger.py

Measurement infrastructure for signal logging and CLV validation.
No predictions, no model output — just raw signal tracking.

Status lifecycle:
    open → proxy_captured → graded

Usage (CLI):
    # Log a signal manually
    python3 -m ml.nba_spread.signal_logger log \
        --game-id "abc123" \
        --date "2026-04-26" \
        --home "bos" --away "ny" \
        --commence "2026-04-26T23:30:00Z" \
        --type line_movement \
        --detail "BOS -4.5 → -7 in 3h (sharp action)" \
        --side home

    # Show open signals
    python3 -m ml.nba_spread.signal_logger status

    # Show CLV report grouped by signal_type
    python3 -m ml.nba_spread.signal_logger report

    # Record closing line proxy (called by 6pm cron via fetch_and_predict --snapshot-only)
    python3 -m ml.nba_spread.signal_logger close --game-id "abc123" --line -7.0

    # Grade a signal after the game
    python3 -m ml.nba_spread.signal_logger grade \
        --game-id "abc123" --home-score 112 --away-score 104
"""
from __future__ import annotations

import argparse
import math
import sqlite3
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

_TZ_ET = ZoneInfo("America/New_York")

DB_PATH = Path(__file__).resolve().parent / "data" / "signal_log.db"


def _null_float(v: Any) -> Optional[float]:
    """Convert NaN / None / empty-string to None for SQLite storage."""
    if v is None or v == "":
        return None
    try:
        f = float(v)
        return None if math.isnan(f) else f
    except (TypeError, ValueError):
        return None

# ---------------------------------------------------------------------------
# CLV computation — pure functions, no I/O, easy to unit-test
# ---------------------------------------------------------------------------

def compute_clv_points(
    line_at_signal: float,
    closing_line: float,
    bet_side: str,
) -> float:
    """
    Closing Line Value in spread points.

    Home_line convention: negative = home favored.
        -5.5  →  home must win by MORE than 5.5 to cover
        +3.5  →  home can lose by up to 3.5 and cover

    Positive CLV = you got a better number than where the market settled.

    Examples
    --------
    Home bet,  signal -3.5, close -5.5  →  +2.0  (easier line than close)
    Home bet,  signal -3.5, close -1.5  →  -2.0  (harder line than close)
    Away bet,  signal -3.5, close -5.5  →  -2.0  (away got +3.5, close gave +5.5 — worse)
    Away bet,  signal -3.5, close -1.5  →  +2.0  (away got +3.5, close only gave +1.5 — better)
    Home bet,  signal +2.5, close +4.5  →  -2.0  (home got fewer points than close offered)
    Away bet,  signal +2.5, close +4.5  →  +2.0  (away gave fewer points than close required)

    Formula
    -------
    direction = +1 (home bet) or -1 (away bet)
    clv_points = direction * (line_at_signal - closing_line)
    """
    if bet_side not in ("home", "away"):
        raise ValueError(f"bet_side must be 'home' or 'away', got {bet_side!r}")
    direction = 1 if bet_side == "home" else -1
    return round(direction * (line_at_signal - closing_line), 2)


def determine_covered(
    score_home: int,
    score_away: int,
    home_line: float,
) -> Optional[int]:
    """
    1  = home team covered
    0  = away team covered
    None = push (exact margin equals spread)

    cover_margin = (home - away) + home_line
    home covers when cover_margin > 0.
    """
    cover_margin = (score_home - score_away) + home_line
    if cover_margin > 0:
        return 1
    if cover_margin < 0:
        return 0
    return None


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

def get_db(path: Path = DB_PATH) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db(path: Path = DB_PATH) -> None:
    """Create tables if they don't exist. Safe to call on every startup."""
    conn = get_db(path)
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS signal_log (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,

            -- Game identification
            game_id          TEXT NOT NULL,
            game_date        DATE NOT NULL,
            home_team        TEXT NOT NULL,
            away_team        TEXT NOT NULL,
            commence_time    TEXT,                -- ISO-8601 UTC tipoff

            -- Signal
            signal_type      TEXT NOT NULL,
            -- 'line_movement' | 'reverse_line' | 'manual'
            signal_detail    TEXT,
            detected_at      TEXT NOT NULL,       -- ISO-8601 UTC

            -- Lines (home_line convention: negative = home favored)
            opening_line     REAL,                -- first posted line (optional)
            line_at_signal   REAL NOT NULL,       -- line at moment signal fired
            execution_source TEXT DEFAULT '',     -- which book provided line_at_signal
            closing_line     REAL,                -- ~6pm ET proxy  ← filled later
            closing_source   TEXT,                -- book that provided closing_line
            closing_captured_at TEXT,             -- when closing line was recorded

            -- Bet
            bet_side         TEXT NOT NULL,       -- 'home' | 'away'
            bet_odds         REAL DEFAULT -110,

            -- Outcome (filled after game)
            score_home       INTEGER,
            score_away       INTEGER,
            covered          INTEGER,             -- 1=bet_side covered, 0=didn't, NULL=push

            -- CLV (computed once closing_line is known)
            clv_points       REAL,               -- positive = beat the close

            -- Situational context (tagged at signal fire time)
            regime           TEXT DEFAULT '',   -- 'regular_season' | 'playoffs'
            bet_rest_days    INTEGER,           -- rest days for the bet side
            opp_rest_days    INTEGER,           -- rest days for the opponent

            -- Lifecycle
            status           TEXT NOT NULL DEFAULT 'open',
            -- 'open' | 'proxy_captured' | 'graded' | 'no_action'
            notes            TEXT,
            created_at       TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS line_snapshots (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            game_id        TEXT NOT NULL,
            game_date      DATE NOT NULL,
            home_team      TEXT NOT NULL,
            away_team      TEXT NOT NULL,
            home_line      REAL NOT NULL,
            over_under     REAL,
            snapshot_label TEXT NOT NULL,
            -- 'morning' (noon run) | '6pm_proxy' | 'manual'
            book           TEXT NOT NULL DEFAULT 'unknown',
            -- which bookmaker: 'pinnacle' | 'fanduel' | 'draftkings' | etc.
            source         TEXT NOT NULL DEFAULT 'odds_api',
            -- data provider: 'odds_api' | 'manual'
            captured_at    TEXT NOT NULL           -- ISO-8601 UTC
        );

        CREATE INDEX IF NOT EXISTS idx_signal_type    ON signal_log(signal_type);
        CREATE INDEX IF NOT EXISTS idx_signal_date    ON signal_log(game_date);
        CREATE INDEX IF NOT EXISTS idx_signal_status  ON signal_log(status);
        CREATE INDEX IF NOT EXISTS idx_signal_game_id ON signal_log(game_id);
        CREATE INDEX IF NOT EXISTS idx_snap_game      ON line_snapshots(game_id, captured_at);

        CREATE TABLE IF NOT EXISTS predictions (
            id                    INTEGER PRIMARY KEY AUTOINCREMENT,
            logged_at             TEXT NOT NULL,
            game_id               TEXT NOT NULL UNIQUE,
            commence_time         TEXT,
            season                TEXT,
            home_team             TEXT,
            away_team             TEXT,
            home_line             REAL,
            home_cover_prob       REAL,
            away_cover_prob       REAL,
            pick_side             TEXT,
            pick_confidence       REAL,
            is_bet                INTEGER DEFAULT 0,
            model_version         TEXT,
            threshold_used        REAL,
            actual_home_covered   INTEGER,
            result_status         TEXT NOT NULL DEFAULT 'pending',
            correct               INTEGER,
            notes                 TEXT DEFAULT '',
            home_injury_impact    REAL DEFAULT 0.0,
            away_injury_impact    REAL DEFAULT 0.0,
            injury_data_available INTEGER DEFAULT 0,
            pinnacle_prob         REAL,
            edge_vs_pinnacle      REAL,
            features_json         TEXT,
            matchup_context       TEXT DEFAULT '',
            created_at            TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_pred_game_id ON predictions(game_id);
        CREATE INDEX IF NOT EXISTS idx_pred_status  ON predictions(result_status);

        CREATE TABLE IF NOT EXISTS book_lines (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            game_id        TEXT NOT NULL,
            game_date      DATE NOT NULL,
            home_team      TEXT NOT NULL,
            away_team      TEXT NOT NULL,
            book           TEXT NOT NULL,
            home_line      REAL NOT NULL,
            home_price     REAL,
            away_price     REAL,
            over_under     REAL,
            snapshot_label TEXT NOT NULL,
            captured_at    TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS uidx_book_lines
            ON book_lines(game_id, book, captured_at);
        CREATE INDEX IF NOT EXISTS idx_book_lines_date
            ON book_lines(game_date, captured_at);

        CREATE TABLE IF NOT EXISTS divergence_alerts (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            game_id        TEXT NOT NULL,
            game_date      DATE NOT NULL,
            home_team      TEXT NOT NULL,
            away_team      TEXT NOT NULL,
            book           TEXT NOT NULL,
            divergence     REAL NOT NULL,      -- signed: book_line - pinnacle_line
            pinnacle_line  REAL NOT NULL,
            book_line      REAL NOT NULL,
            snapshot_label TEXT NOT NULL,      -- which cron label fired this
            fired_at       TEXT NOT NULL       -- ISO-8601 UTC
        );
        CREATE INDEX IF NOT EXISTS idx_div_alerts_game
            ON divergence_alerts(game_id, book, game_date);

        CREATE TABLE IF NOT EXISTS execution_log (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            signal_id     INTEGER NOT NULL REFERENCES signal_log(id),
            mode          TEXT NOT NULL CHECK(mode IN ('paper', 'real')),
            book          TEXT NOT NULL,
            signal_line   REAL NOT NULL,
            fill_line     REAL,
            fill_slippage REAL DEFAULT 0.0,
            stake         REAL NOT NULL DEFAULT 1.0,
            bet_side      TEXT NOT NULL,
            outcome       INTEGER,
            pnl_units     REAL,
            notes         TEXT DEFAULT '',
            created_at    TEXT NOT NULL DEFAULT (datetime('now')),
            graded_at     TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_exec_signal ON execution_log(signal_id);
        CREATE INDEX IF NOT EXISTS idx_exec_mode   ON execution_log(mode);

        CREATE TABLE IF NOT EXISTS meta (
            key        TEXT PRIMARY KEY,
            value      TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    """)
    # Migrate existing DBs that predate these columns
    _migrate(conn)
    conn.commit()
    conn.close()


def _migrate(conn: sqlite3.Connection) -> None:
    """Add new columns to existing DBs. Safe to call repeatedly — ignores 'already exists'."""
    migrations = [
        "ALTER TABLE signal_log      ADD COLUMN execution_source TEXT DEFAULT ''",
        "ALTER TABLE line_snapshots  ADD COLUMN book TEXT DEFAULT 'unknown'",
        "ALTER TABLE predictions     ADD COLUMN matchup_context TEXT DEFAULT ''",
        "ALTER TABLE signal_log      ADD COLUMN regime TEXT DEFAULT ''",
        "ALTER TABLE signal_log      ADD COLUMN bet_rest_days INTEGER",
        "ALTER TABLE signal_log      ADD COLUMN opp_rest_days INTEGER",
        # Prevents duplicate snapshots for the same game + label (e.g. running
        # the cron twice). First write wins; subsequent inserts are silently ignored.
        "CREATE UNIQUE INDEX IF NOT EXISTS uidx_snap_game_label ON line_snapshots(game_id, snapshot_label)",
        # One signal per (game, type) — prevents duplicate rows from repeated cron runs
        # or multiple books on the same game firing _log_divergence_signals.
        "CREATE UNIQUE INDEX IF NOT EXISTS uidx_signal_game_type ON signal_log(game_id, signal_type)",
    ]
    for sql in migrations:
        try:
            conn.execute(sql)
        except sqlite3.OperationalError:
            pass  # column/index already exists

    # Fix book_lines unique index: old DBs used (game_id, book, snapshot_label) which
    # blocked multiple intraday captures with the same label. New index uses captured_at
    # so full time-series is preserved (only same-second exact duplicates are blocked).
    idx = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='uidx_book_lines'"
    ).fetchone()
    if idx and "snapshot_label" in idx[0]:
        conn.execute("DROP INDEX uidx_book_lines")
        conn.execute(
            "CREATE UNIQUE INDEX uidx_book_lines ON book_lines(game_id, book, captured_at)"
        )
        conn.execute("DROP INDEX IF EXISTS idx_book_lines_date")
        conn.execute(
            "CREATE INDEX idx_book_lines_date ON book_lines(game_date, captured_at)"
        )


# ---------------------------------------------------------------------------
# Situational context helpers
# ---------------------------------------------------------------------------

_MODULE_DIR    = Path(__file__).resolve().parent
_STATE_PATH    = _MODULE_DIR / "artifacts" / "latest_team_state.json"

# NBA first-round playoff start dates by season-end year (keep in sync with inference.py)
_PLAYOFF_STARTS: Dict[int, str] = {
    2024: "2024-04-20",
    2025: "2025-04-19",
    2026: "2026-04-19",
}


def _regime_for_date(game_date: str) -> str:
    """Return 'playoffs' or 'regular_season' for a YYYY-MM-DD game date."""
    try:
        gd = datetime.strptime(game_date, "%Y-%m-%d")
        year = gd.year + 1 if gd.month >= 10 else gd.year
        start_str = _PLAYOFF_STARTS.get(year)
        if start_str:
            start = datetime.strptime(start_str, "%Y-%m-%d")
            if gd.date() >= start.date():
                return "playoffs"
        elif gd.month in (4, 5, 6) and (gd.month != 4 or gd.day >= 16):
            return "playoffs"
    except Exception:
        pass
    return "regular_season"


def _rest_days_for_code(team_code: str) -> Optional[int]:
    """Look up current rest days for a team code from latest_team_state.json."""
    try:
        import json as _json
        state = _json.loads(_STATE_PATH.read_text())
        entry = state.get(team_code, {})
        rd = entry.get("rest_days")
        return int(rd) if rd is not None else None
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Write operations
# ---------------------------------------------------------------------------

def log_signal(
    *,
    game_id: str,
    game_date: str,
    home_team: str,
    away_team: str,
    signal_type: str,
    line_at_signal: float,
    bet_side: str,
    execution_source: str = "",
    signal_detail: str = "",
    commence_time: str = "",
    opening_line: Optional[float] = None,
    bet_odds: float = -110.0,
    notes: str = "",
    regime: Optional[str] = None,
    bet_rest_days: Optional[int] = None,
    opp_rest_days: Optional[int] = None,
    db_path: Path = DB_PATH,
) -> int:
    """
    Insert a new signal. Returns the new row id.
    Automatically sets detected_at to now (UTC).

    execution_source — which bookmaker provided line_at_signal (e.g. 'pinnacle').
    regime / bet_rest_days / opp_rest_days — situational context; auto-derived from
        game_date and team_state if not provided.
    """
    if bet_side not in ("home", "away"):
        raise ValueError(f"bet_side must be 'home' or 'away', got {bet_side!r}")

    if regime is None:
        regime = _regime_for_date(game_date)

    init_db(db_path)
    conn = get_db(db_path)
    detected_at = datetime.now(timezone.utc).isoformat()
    cursor = conn.execute(
        """
        INSERT OR IGNORE INTO signal_log
            (game_id, game_date, home_team, away_team, commence_time,
             signal_type, signal_detail, detected_at,
             opening_line, line_at_signal, execution_source,
             bet_side, bet_odds, notes, status,
             regime, bet_rest_days, opp_rest_days)
        VALUES (?,?,?,?,?,  ?,?,?,  ?,?,?,  ?,?,?, 'open',  ?,?,?)
        """,
        (
            game_id, game_date, home_team, away_team, commence_time,
            signal_type, signal_detail, detected_at,
            opening_line, line_at_signal, execution_source,
            bet_side, bet_odds, notes,
            regime, bet_rest_days, opp_rest_days,
        ),
    )
    row_id = cursor.lastrowid or 0
    conn.commit()
    conn.close()
    if row_id:
        try:
            from ml.ops.tracked_picks import track_nba_signal
            track_nba_signal(row_id, db_path, origin="model_auto")
        except Exception:
            pass
    return row_id


def record_closing_proxy(
    game_id: str,
    closing_line: float,
    source: str = "odds_api_6pm",
    force: bool = False,
    db_path: Path = DB_PATH,
) -> int:
    """
    Update signals for game_id with the closing line proxy.
    Returns number of rows updated.

    force=True  — overwrite even when closing_line is already set (used by the
                  pregame cron to replace the 6pm_proxy with a truer close).
    force=False — default; only fills rows where closing_line IS NULL.
    """
    init_db(db_path)
    conn = get_db(db_path)
    captured_at = datetime.now(timezone.utc).isoformat()
    null_guard = "" if force else "AND closing_line IS NULL"
    cursor = conn.execute(
        f"""
        UPDATE signal_log
        SET closing_line        = ?,
            closing_source      = ?,
            closing_captured_at = ?,
            status              = 'proxy_captured'
        WHERE game_id = ?
          AND status IN ('open', 'proxy_captured')
          {null_guard}
        """,
        (closing_line, source, captured_at, game_id),
    )
    updated = cursor.rowcount
    conn.commit()
    conn.close()
    return updated


def save_snapshot(
    game_id: str,
    game_date: str,
    home_team: str,
    away_team: str,
    home_line: float,
    snapshot_label: str,
    over_under: Optional[float] = None,
    book: str = "unknown",
    source: str = "odds_api",
    db_path: Path = DB_PATH,
) -> None:
    """
    Persist a single line snapshot. Called by the odds polling cron.

    book   — which specific bookmaker the line came from (e.g. 'pinnacle', 'fanduel')
    source — data provider: 'odds_api' | 'manual'
    """
    init_db(db_path)
    conn = get_db(db_path)
    captured_at = datetime.now(timezone.utc).isoformat()
    conn.execute(
        """
        INSERT OR IGNORE INTO line_snapshots
            (game_id, game_date, home_team, away_team,
             home_line, over_under, snapshot_label, book, source, captured_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        """,
        (game_id, game_date, home_team, away_team,
         home_line, over_under, snapshot_label, book, source, captured_at),
    )
    conn.commit()
    conn.close()


def save_book_lines(
    game_id: str,
    game_date: str,
    home_team: str,
    away_team: str,
    snapshot_label: str,
    lines: List[Dict[str, Any]],
    db_path: Path = DB_PATH,
) -> int:
    """
    Persist all books' spread lines for a single game snapshot.

    Each element of `lines` should have:
      book (str), home_line (float), home_price (float|None),
      away_price (float|None), over_under (float|None)

    Duplicate (game_id, book, captured_at) rows are silently ignored —
    first write wins. Different captured_at timestamps (separate cron runs)
    produce separate rows, enabling a full intraday time series.

    Returns number of rows inserted.
    """
    if not lines:
        return 0
    init_db(db_path)
    conn = get_db(db_path)
    captured_at = datetime.now(timezone.utc).isoformat()
    inserted = 0
    for entry in lines:
        cursor = conn.execute(
            """
            INSERT OR IGNORE INTO book_lines
                (game_id, game_date, home_team, away_team,
                 book, home_line, home_price, away_price, over_under,
                 snapshot_label, captured_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                game_id, game_date, home_team, away_team,
                entry["book"], float(entry["home_line"]),
                _null_float(entry.get("home_price")),
                _null_float(entry.get("away_price")),
                _null_float(entry.get("over_under")),
                snapshot_label, captured_at,
            ),
        )
        inserted += cursor.rowcount
    conn.commit()
    conn.close()
    return inserted


def get_book_divergences(
    game_date: Optional[str] = None,
    min_divergence: float = 0.5,
    db_path: Path = DB_PATH,
) -> List[Dict[str, Any]]:
    """
    For each game on game_date, compare the most recent soft-book line against
    Pinnacle's most recent line (per game per book, latest captured_at wins).
    Returns rows where a book diverges from Pinnacle by >= min_divergence points,
    sorted by abs(divergence) descending.

    Each row: game_id, game_date, home_team, away_team,
              pinnacle_line, book, book_line, divergence (book_line - pinnacle_line)

    Positive divergence: book_line > pinnacle_line → home is LESS favored at soft book
                         → home bettors get an easier number there.
    Negative divergence: soft book has home as bigger favorite
                         → away bettors get a better number there.

    Returns empty list if Pinnacle has no line for a game.
    """
    if game_date is None:
        game_date = (datetime.now(_TZ_ET)).strftime("%Y-%m-%d")
    init_db(db_path)
    conn = get_db(db_path)
    rows = conn.execute(
        """
        WITH latest AS (
            SELECT game_id, book, home_line, game_date, home_team, away_team, snapshot_label,
                   ROW_NUMBER() OVER (PARTITION BY game_id, book ORDER BY captured_at DESC) AS rn
            FROM book_lines
            WHERE game_date = ?
        )
        SELECT l.game_id, l.game_date, l.home_team, l.away_team,
               p.home_line     AS pinnacle_line,
               l.book          AS book,
               l.home_line     AS book_line,
               ROUND(l.home_line - p.home_line, 2) AS divergence,
               l.snapshot_label
        FROM latest l
        JOIN latest p ON l.game_id = p.game_id AND p.book = 'pinnacle' AND p.rn = 1
        WHERE l.book  != 'pinnacle'
          AND l.rn     = 1
          AND ABS(l.home_line - p.home_line) >= ?
        ORDER BY ABS(l.home_line - p.home_line) DESC
        """,
        (game_date, min_divergence),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def check_and_save_divergence_alerts(
    divergences: List[Dict[str, Any]],
    snapshot_label: str,
    widen_pts: float = 1.0,
    db_path: Path = DB_PATH,
) -> List[Dict[str, Any]]:
    """
    For each divergence, fire an alert if:
      - No alert exists yet for this (game_id, book, game_date), OR
      - The divergence has grown by >= widen_pts since the last alert for that pair.

    Persists fired alerts to divergence_alerts table (dedup across cron runs).
    Returns list of newly fired alert dicts; each dict has all divergence fields
    plus "is_new" (bool) and "is_widened" (bool).
    """
    if not divergences:
        return []

    init_db(db_path)
    conn = get_db(db_path)

    new_alerts: List[Dict[str, Any]] = []
    for d in divergences:
        game_id  = d["game_id"]
        book     = d["book"]
        gdate    = d["game_date"]

        last = conn.execute(
            """
            SELECT divergence FROM divergence_alerts
            WHERE game_id = ? AND book = ? AND game_date = ?
            ORDER BY fired_at DESC LIMIT 1
            """,
            (game_id, book, gdate),
        ).fetchone()

        is_new     = last is None
        is_widened = (
            last is not None
            and abs(d["divergence"]) >= abs(last["divergence"]) + widen_pts
        )

        if is_new or is_widened:
            conn.execute(
                """
                INSERT INTO divergence_alerts
                    (game_id, game_date, home_team, away_team, book,
                     divergence, pinnacle_line, book_line, snapshot_label, fired_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    game_id, gdate, d["home_team"], d["away_team"],
                    book, d["divergence"], d["pinnacle_line"], d["book_line"],
                    snapshot_label, datetime.now(timezone.utc).isoformat(),
                ),
            )
            new_alerts.append({**d, "is_new": is_new, "is_widened": is_widened})

    conn.commit()
    conn.close()
    return new_alerts


def log_prediction_db(row: Dict[str, Any], db_path: Path = DB_PATH) -> None:
    """
    INSERT OR IGNORE a prediction row into the predictions table.
    Silently skips duplicates (same game_id) — idempotent by design.

    Expected keys in `row` (all optional except game_id / logged_at):
      game_id, logged_at, commence_time, season,
      home_team, away_team, home_line,
      home_cover_prob, away_cover_prob, pick_side, pick_confidence,
      is_bet, model_version, threshold_used,
      home_injury_impact, away_injury_impact, injury_data_available,
      pinnacle_prob, edge_vs_pinnacle, features_json
    """
    init_db(db_path)
    conn = get_db(db_path)
    conn.execute(
        """
        INSERT OR IGNORE INTO predictions (
            logged_at, game_id, commence_time, season,
            home_team, away_team, home_line,
            home_cover_prob, away_cover_prob, pick_side, pick_confidence,
            is_bet, model_version, threshold_used,
            home_injury_impact, away_injury_impact, injury_data_available,
            pinnacle_prob, edge_vs_pinnacle, features_json, matchup_context,
            result_status
        ) VALUES (
            :logged_at, :game_id, :commence_time, :season,
            :home_team, :away_team, :home_line,
            :home_cover_prob, :away_cover_prob, :pick_side, :pick_confidence,
            :is_bet, :model_version, :threshold_used,
            :home_injury_impact, :away_injury_impact, :injury_data_available,
            :pinnacle_prob, :edge_vs_pinnacle, :features_json, :matchup_context,
            'pending'
        )
        """,
        {
            "logged_at":             row.get("logged_at", datetime.now(timezone.utc).isoformat()),
            "game_id":               row["game_id"],
            "commence_time":         row.get("commence_time"),
            "season":                row.get("season"),
            "home_team":             row.get("home_team"),
            "away_team":             row.get("away_team"),
            "home_line":             _null_float(row.get("home_line")),
            "home_cover_prob":       _null_float(row.get("home_cover_prob")),
            "away_cover_prob":       _null_float(row.get("away_cover_prob")),
            "pick_side":             row.get("pick_side"),
            "pick_confidence":       _null_float(row.get("pick_confidence")),
            "is_bet":                int(bool(row.get("is_bet", 0))),
            "model_version":         row.get("model_version"),
            "threshold_used":        _null_float(row.get("threshold_used")),
            "home_injury_impact":    _null_float(row.get("home_injury_impact", 0.0)),
            "away_injury_impact":    _null_float(row.get("away_injury_impact", 0.0)),
            "injury_data_available": int(bool(row.get("injury_data_available", 0))),
            "pinnacle_prob":         _null_float(row.get("pinnacle_prob")),
            "edge_vs_pinnacle":      _null_float(row.get("edge_vs_pinnacle")),
            "features_json":         row.get("features_json"),
            "matchup_context":       row.get("matchup_context") or "",
        },
    )
    conn.commit()
    conn.close()


def update_prediction_result_db(
    game_id: str,
    actual_home_covered: Optional[int],
    notes: str = "",
    db_path: Path = DB_PATH,
) -> int:
    """
    Set grading fields on a predictions row after the game is played.
    Returns number of rows updated (0 if game_id not found).

    actual_home_covered: 1=home covered, 0=away covered, None=push
    correct: 1 if pick_side matches who covered, 0 otherwise, None on push
    """
    init_db(db_path)
    conn = get_db(db_path)

    pred = conn.execute(
        "SELECT pick_side FROM predictions WHERE game_id = ?", (game_id,)
    ).fetchone()

    if not pred:
        conn.close()
        return 0

    pick_side = pred["pick_side"]
    if actual_home_covered is None:
        correct = None
        result_status = "push"
    elif pick_side == "home":
        correct = 1 if actual_home_covered == 1 else 0
        result_status = "graded"
    else:
        correct = 1 if actual_home_covered == 0 else 0
        result_status = "graded"

    cursor = conn.execute(
        """
        UPDATE predictions
        SET actual_home_covered = ?,
            correct             = ?,
            result_status       = ?,
            notes               = CASE WHEN ? != '' THEN ? ELSE notes END
        WHERE game_id = ?
        """,
        (actual_home_covered, correct, result_status, notes, notes, game_id),
    )
    updated = cursor.rowcount
    conn.commit()
    conn.close()
    return updated


def migrate_csv_to_db(csv_path: Path, db_path: Path = DB_PATH) -> int:
    """
    One-time migration: read model_performance.csv and INSERT OR IGNORE each
    row into the predictions table. Returns number of rows inserted.

    Skips rows already present (UNIQUE game_id constraint) — safe to re-run.
    """
    import csv as _csv

    if not csv_path.exists():
        print(f"  CSV not found: {csv_path}")
        return 0

    inserted = 0
    with csv_path.open() as f:
        reader = _csv.DictReader(f)
        for raw in reader:
            game_id = raw.get("game_id", "").strip()
            if not game_id:
                continue

            result_status = raw.get("result_status", "pending").strip()
            correct_raw   = raw.get("correct", "").strip()
            covered_raw   = raw.get("actual_home_covered", "").strip()

            correct: Optional[int] = None
            if correct_raw not in ("", "nan", "NaN"):
                try:
                    correct = int(float(correct_raw))
                except ValueError:
                    pass

            actual_home_covered: Optional[int] = None
            if covered_raw not in ("", "nan", "NaN"):
                try:
                    actual_home_covered = int(float(covered_raw))
                except ValueError:
                    pass

            row: Dict[str, Any] = {
                "logged_at":             raw.get("logged_at", "").strip(),
                "game_id":               game_id,
                "commence_time":         raw.get("commence_time", "").strip() or None,
                "season":                raw.get("season", "").strip() or None,
                "home_team":             raw.get("home_team", "").strip() or None,
                "away_team":             raw.get("away_team", "").strip() or None,
                "home_line":             raw.get("home_line"),
                "home_cover_prob":       raw.get("home_cover_prob"),
                "away_cover_prob":       raw.get("away_cover_prob"),
                "pick_side":             raw.get("pick_side", "").strip() or None,
                "pick_confidence":       raw.get("pick_confidence"),
                "is_bet":                raw.get("is_bet", "0").strip(),
                "model_version":         raw.get("model_version", "").strip() or None,
                "threshold_used":        raw.get("threshold_used"),
                "home_injury_impact":    raw.get("home_injury_impact", "0.0"),
                "away_injury_impact":    raw.get("away_injury_impact", "0.0"),
                "injury_data_available": 0,
                "pinnacle_prob":         raw.get("pinnacle_prob"),
                "edge_vs_pinnacle":      raw.get("edge_vs_pinnacle"),
                "features_json":         None,
            }
            log_prediction_db(row, db_path)

            if result_status in ("graded", "push") and correct is not None:
                update_prediction_result_db(game_id, actual_home_covered, "", db_path)

            inserted += 1

    return inserted


def grade_signal(
    game_id: str,
    score_home: int,
    score_away: int,
    db_path: Path = DB_PATH,
) -> list[dict]:
    """
    For every proxy_captured signal matching game_id:
      - compute covered (1/0/None)
      - compute clv_points
      - set status = 'graded'

    Returns list of dicts with signal id, clv_points, covered.
    Called by the grading cron (grade_results.py).
    """
    init_db(db_path)
    conn = get_db(db_path)

    rows = conn.execute(
        """
        SELECT id, home_team, away_team, line_at_signal, closing_line, bet_side
        FROM signal_log
        WHERE game_id = ? AND status IN ('proxy_captured', 'open')
        """,
        (game_id,),
    ).fetchall()

    results = []
    for row in rows:
        covered = determine_covered(score_home, score_away, row["line_at_signal"])
        clv: Optional[float] = None
        if row["closing_line"] is not None:
            clv = compute_clv_points(
                row["line_at_signal"],
                row["closing_line"],
                row["bet_side"],
            )

        conn.execute(
            """
            UPDATE signal_log
            SET score_home = ?,
                score_away = ?,
                covered    = ?,
                clv_points = ?,
                status     = 'graded'
            WHERE id = ?
            """,
            (score_home, score_away, covered, clv, row["id"]),
        )
        results.append({"id": row["id"], "clv_points": clv, "covered": covered})

    conn.commit()
    conn.close()
    for item in results:
        try:
            from ml.ops.tracked_picks import track_nba_signal
            track_nba_signal(item["id"], db_path, origin="model_auto")
        except Exception:
            pass
    return results


# ---------------------------------------------------------------------------
# Line movement detection
# ---------------------------------------------------------------------------

def detect_line_movements(
    game_date: Optional[str] = None,
    threshold: float = 1.5,
    db_path: Path = DB_PATH,
) -> list[dict]:
    """
    Compare earliest vs later snapshots for each game on game_date (defaults to
    today ET). Auto-logs a 'line_movement' signal when spread moves >= threshold pts.

    Uses the earliest captured snapshot as baseline regardless of label ('morning',
    'afternoon', etc.), so noon-labeled runs still anchor the comparison.

    bet_side convention:
      proxy_line < baseline_line  →  home more favored  →  bet_side='home'
      proxy_line > baseline_line  →  away more favored  →  bet_side='away'

    Idempotent: skips games that already have a line_movement signal logged today.
    Returns list of dicts for each new signal created.
    """
    if game_date is None:
        # Use ET calendar date so late games (9:30pm/10pm ET) aren't
        # silently missed because their commence_time rolls into the
        # next UTC calendar day.
        game_date = (datetime.now(_TZ_ET)).strftime("%Y-%m-%d")

    init_db(db_path)
    conn = get_db(db_path)

    # For each game, get the earliest snapshot as baseline and best later snapshot.
    # Using earliest captured_at (not label='morning') so afternoon-labeled noon
    # runs still serve as the baseline when no 'morning' label exists.
    rows = conn.execute(
        """
        WITH earliest AS (
            SELECT game_id, game_date, home_team, away_team,
                   home_line AS morning_line, captured_at,
                   ROW_NUMBER() OVER (PARTITION BY game_id ORDER BY captured_at ASC) AS rn
            FROM line_snapshots
            WHERE game_date = ?
        ),
        baseline AS (
            SELECT game_id, game_date, home_team, away_team,
                   morning_line, captured_at
            FROM earliest WHERE rn = 1
        ),
        later AS (
            SELECT ls.game_id, ls.home_line AS proxy_line, ls.snapshot_label,
                   ls.book AS proxy_book, ls.captured_at,
                   ROW_NUMBER() OVER (
                       PARTITION BY ls.game_id
                       ORDER BY
                           CASE ls.snapshot_label
                               WHEN '6pm_proxy'  THEN 1
                               WHEN 'afternoon'  THEN 2
                               ELSE 3
                           END,
                           ls.captured_at DESC
                   ) AS rn
            FROM line_snapshots ls
            JOIN baseline b ON ls.game_id = b.game_id
            WHERE ls.game_date = ? AND ls.captured_at > b.captured_at
        )
        SELECT b.game_id, b.game_date, b.home_team, b.away_team,
               b.morning_line, l.proxy_line, l.snapshot_label AS proxy_label,
               l.proxy_book, b.captured_at AS morning_captured_at
        FROM baseline b
        JOIN later l ON b.game_id = l.game_id AND l.rn = 1
        WHERE ABS(l.proxy_line - b.morning_line) >= ?
        """,
        (game_date, game_date, threshold),
    ).fetchall()

    created: list[dict] = []
    for row in rows:
        game_id = row["game_id"]

        # Idempotency: skip if we already logged a line_movement signal for this game today
        already = conn.execute(
            """
            SELECT 1 FROM signal_log
            WHERE game_id = ? AND signal_type = 'line_movement'
            LIMIT 1
            """,
            (game_id,),
        ).fetchone()
        if already:
            continue

        morning_line = row["morning_line"]
        proxy_line   = row["proxy_line"]
        movement     = proxy_line - morning_line  # signed
        proxy_book   = row["proxy_book"] or "unknown"

        bet_side = "home" if proxy_line < morning_line else "away"
        detail = (
            f"{row['home_team']} {morning_line:+.1f} → {proxy_line:+.1f}  "
            f"({movement:+.1f} pts, morning→{row['proxy_label']}, book={proxy_book})"
        )

        # Resolve team codes for rest-day lookup (suffix matching on full names)
        def _to_code(name: str) -> Optional[str]:
            lower = name.lower().rstrip("*").strip()
            _suffixes = {
                "hawks": "atl", "celtics": "bos", "nets": "bkn", "hornets": "cha",
                "bulls": "chi", "cavaliers": "cle", "mavericks": "dal", "nuggets": "den",
                "pistons": "det", "warriors": "gs", "rockets": "hou", "pacers": "ind",
                "clippers": "lac", "lakers": "lal", "grizzlies": "mem", "heat": "mia",
                "bucks": "mil", "timberwolves": "min", "pelicans": "no", "knicks": "ny",
                "thunder": "okc", "magic": "orl", "76ers": "phi", "suns": "phx",
                "trail blazers": "por", "kings": "sac", "spurs": "sa", "raptors": "tor",
                "jazz": "utah", "wizards": "wsh",
            }
            for suffix, code in _suffixes.items():
                if lower.endswith(suffix):
                    return code
            return None

        h_code = _to_code(row["home_team"])
        a_code = _to_code(row["away_team"])
        h_rest = _rest_days_for_code(h_code) if h_code else None
        a_rest = _rest_days_for_code(a_code) if a_code else None
        b_rest = h_rest if bet_side == "home" else a_rest
        o_rest = a_rest if bet_side == "home" else h_rest

        conn.close()
        row_id = log_signal(
            game_id=game_id,
            game_date=row["game_date"],
            home_team=row["home_team"],
            away_team=row["away_team"],
            signal_type="line_movement",
            line_at_signal=proxy_line,
            execution_source=proxy_book,
            bet_side=bet_side,
            signal_detail=detail,
            opening_line=morning_line,
            regime=_regime_for_date(row["game_date"]),
            bet_rest_days=b_rest,
            opp_rest_days=o_rest,
            db_path=db_path,
        )
        conn = get_db(db_path)
        created.append({
            "id": row_id,
            "game_id": game_id,
            "home_team": row["home_team"],
            "away_team": row["away_team"],
            "morning_line": morning_line,
            "proxy_line": proxy_line,
            "movement": movement,
            "bet_side": bet_side,
        })

    conn.close()
    return created


# ---------------------------------------------------------------------------
# Edge evaluation
# ---------------------------------------------------------------------------

MIN_SAMPLES_FOR_STATUS = 30

def compute_edge_status(n: int, avg_clv: float, pct_pos_clv: float) -> str:
    """
    Classify a signal type based on sample size and CLV metrics.

    Below MIN_SAMPLES_FOR_STATUS the label is always 'accumulating' — not
    enough data to draw any conclusion regardless of the numbers.

    Tiers (30+ samples):
      avg_clv < 0              → 'bad'           signal finding bad numbers
      0   ≤ avg_clv < 0.5      → 'inconclusive'  direction unclear
      0.5 ≤ avg_clv < 1.0      → 'promising'     worth continuing to track
      avg_clv ≥ 1.0            → 'strong'        clear signal

    pct_pos_clv is a secondary check. When avg_clv ≥ 0 but pct_pos_clv ≤ 50
    the status gets a '?' suffix to flag the inconsistency (a few large
    positive values pulling the average up).
    """
    if n < MIN_SAMPLES_FOR_STATUS:
        return "accumulating"
    if avg_clv < 0:
        return "bad"
    suffix = "?" if pct_pos_clv <= 50.0 else ""
    if avg_clv < 0.5:
        return f"inconclusive{suffix}"
    if avg_clv < 1.0:
        return f"promising{suffix}"
    return f"strong{suffix}"


# ---------------------------------------------------------------------------
# Read / reporting
# ---------------------------------------------------------------------------

def get_report(db_path: Path = DB_PATH) -> list[dict]:
    """
    Return per-signal_type stats for all graded signals, including edge_status.

    Each row contains:
      signal_type, n, avg_clv, pct_pos_clv, win_rate_pct, roi_per_unit,
      first_signal, last_signal, edge_status
    """
    init_db(db_path)
    conn = get_db(db_path)
    rows = conn.execute(
        """
        WITH deduped_div AS (
            -- soft_book_divergence: treat each unique (game_id, bet_side, game_date) as
            -- one market observation. Multiple soft books moving together are the same
            -- bet opportunity, not independent signals. CLV is averaged across books;
            -- MAX(covered) works because all books track the same game outcome.
            SELECT 'soft_book_divergence' AS signal_type,
                   game_id, bet_side, game_date,
                   AVG(clv_points) AS clv_points,
                   MAX(covered)    AS covered
            FROM signal_log
            WHERE status = 'graded' AND signal_type = 'soft_book_divergence'
            GROUP BY game_id, bet_side, game_date
        ),
        other AS (
            SELECT signal_type, game_id, bet_side, game_date, clv_points, covered
            FROM signal_log
            WHERE status = 'graded' AND signal_type != 'soft_book_divergence'
        ),
        combined AS (SELECT * FROM deduped_div UNION ALL SELECT * FROM other)
        SELECT
            signal_type,
            COUNT(*)                                                     AS n,
            ROUND(AVG(clv_points), 2)                                    AS avg_clv,
            ROUND(
                100.0 * SUM(CASE WHEN clv_points > 0 THEN 1 ELSE 0 END)
                / NULLIF(COUNT(clv_points), 0), 1)                       AS pct_pos_clv,
            ROUND(
                100.0 * SUM(CASE WHEN covered = 1 THEN 1 ELSE 0 END)
                / NULLIF(SUM(CASE WHEN covered IS NOT NULL THEN 1 END), 0)
            , 1)                                                         AS win_rate_pct,
            ROUND(
                ( SUM(CASE WHEN covered = 1 THEN 100.0/110 ELSE 0 END)
                - SUM(CASE WHEN covered = 0 THEN 1.0     ELSE 0 END) )
                / NULLIF(SUM(CASE WHEN covered IS NOT NULL THEN 1 END), 0)
            , 3)                                                         AS roi_per_unit,
            MIN(game_date)                                               AS first_signal,
            MAX(game_date)                                               AS last_signal
        FROM combined
        GROUP BY signal_type
        ORDER BY avg_clv DESC NULLS LAST
        """,
    ).fetchall()
    conn.close()
    result = []
    for r in rows:
        row = dict(r)
        row["edge_status"] = compute_edge_status(
            n=row["n"],
            avg_clv=row["avg_clv"] or 0.0,
            pct_pos_clv=row["pct_pos_clv"] or 0.0,
        )
        result.append(row)
    return result


def get_signal_execution_source(game_id: str, db_path: Path = DB_PATH) -> Optional[str]:
    """
    Return the execution_source of the most recent open signal for game_id.
    Used by the 6pm run to try matching the same book when stamping the closing proxy.
    Returns None if no open signal exists or execution_source is empty.
    """
    init_db(db_path)
    conn = get_db(db_path)
    row = conn.execute(
        """
        SELECT execution_source FROM signal_log
        WHERE game_id = ? AND status = 'open' AND closing_line IS NULL
        ORDER BY id DESC LIMIT 1
        """,
        (game_id,),
    ).fetchone()
    conn.close()
    if row and row["execution_source"]:
        return row["execution_source"]
    return None


def get_open_signals(db_path: Path = DB_PATH) -> list[dict]:
    init_db(db_path)
    conn = get_db(db_path)
    rows = conn.execute(
        """
        SELECT id, game_date, home_team, away_team, signal_type,
               signal_detail, line_at_signal, execution_source,
               bet_side, status, detected_at
        FROM signal_log
        WHERE status IN ('open', 'proxy_captured')
        ORDER BY game_date DESC, id DESC
        """,
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Execution logging
# ---------------------------------------------------------------------------

def log_paper_execution(
    signal_id: int,
    book: str,
    signal_line: float,
    bet_side: str,
    stake: float = 1.0,
    notes: str = "",
    db_path: Path = DB_PATH,
) -> int:
    """
    Auto-log a paper trade when a divergence signal fires.
    Idempotent: returns existing id if a paper execution already exists for this signal.
    Returns the execution row id (0 on failure).
    """
    init_db(db_path)
    conn = get_db(db_path)
    existing = conn.execute(
        "SELECT id FROM execution_log WHERE signal_id = ? AND mode = 'paper'", (signal_id,)
    ).fetchone()
    if existing:
        conn.close()
        return existing["id"]
    cursor = conn.execute(
        """INSERT INTO execution_log (signal_id, mode, book, signal_line, bet_side, stake, notes)
           VALUES (?, 'paper', ?, ?, ?, ?, ?)""",
        (signal_id, book, signal_line, bet_side, stake, notes),
    )
    exec_id = cursor.lastrowid or 0
    conn.commit()
    conn.close()
    return exec_id


def log_real_execution(
    signal_id: int,
    book: str,
    signal_line: float,
    bet_side: str,
    fill_line: Optional[float] = None,
    fill_slippage: float = 0.0,
    stake: float = 1.0,
    notes: str = "",
    db_path: Path = DB_PATH,
) -> int:
    """Log a manually confirmed real bet. Returns the new execution row id."""
    init_db(db_path)
    conn = get_db(db_path)
    cursor = conn.execute(
        """INSERT INTO execution_log
           (signal_id, mode, book, signal_line, fill_line, fill_slippage, bet_side, stake, notes)
           VALUES (?, 'real', ?, ?, ?, ?, ?, ?, ?)""",
        (signal_id, book, signal_line, fill_line, fill_slippage, bet_side, stake, notes),
    )
    exec_id = cursor.lastrowid or 0
    conn.commit()
    conn.close()
    return exec_id


def grade_executions(
    signal_id: int,
    covered: Optional[int],
    db_path: Path = DB_PATH,
) -> int:
    """
    Grade all pending (outcome IS NULL) executions for a signal.
    covered = 1 (home covered), 0 (away covered), None (push).
    Returns number of executions updated.
    """
    init_db(db_path)
    conn = get_db(db_path)

    sig = conn.execute("SELECT bet_side FROM signal_log WHERE id = ?", (signal_id,)).fetchone()
    if not sig:
        conn.close()
        return 0

    bet_side = sig["bet_side"]
    graded_at = datetime.now(timezone.utc).isoformat()

    if covered is None:
        outcome: Optional[int] = None
    elif (bet_side == "home" and covered == 1) or (bet_side == "away" and covered == 0):
        outcome = 1
    else:
        outcome = 0

    execs = conn.execute(
        "SELECT id, stake FROM execution_log WHERE signal_id = ? AND outcome IS NULL",
        (signal_id,),
    ).fetchall()

    for ex in execs:
        if outcome == 1:
            pnl = round(ex["stake"] * 100.0 / 110.0, 4)
        elif outcome == 0:
            pnl = -ex["stake"]
        else:
            pnl = 0.0
        conn.execute(
            "UPDATE execution_log SET outcome = ?, pnl_units = ?, graded_at = ? WHERE id = ?",
            (outcome, pnl, graded_at, ex["id"]),
        )

    conn.commit()
    conn.close()
    return len(execs)


def get_executions(
    signal_id: Optional[int] = None,
    mode: Optional[str] = None,
    limit: int = 200,
    db_path: Path = DB_PATH,
) -> List[Dict[str, Any]]:
    """Return executions, optionally filtered by signal_id and/or mode."""
    init_db(db_path)
    conn = get_db(db_path)
    clauses: List[str] = []
    params: List[Any] = []
    if signal_id is not None:
        clauses.append("signal_id = ?")
        params.append(signal_id)
    if mode is not None:
        clauses.append("mode = ?")
        params.append(mode)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    params.append(limit)
    rows = conn.execute(
        f"SELECT * FROM execution_log {where} ORDER BY id DESC LIMIT ?", params
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Meta key-value store
# ---------------------------------------------------------------------------

def update_meta(key: str, value: str, db_path: Path = DB_PATH) -> None:
    """Upsert a key-value pair into the meta table."""
    init_db(db_path)
    conn = get_db(db_path)
    conn.execute(
        "INSERT INTO meta (key, value, updated_at) VALUES (?, ?, datetime('now')) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        (key, str(value)),
    )
    conn.commit()
    conn.close()


def get_meta(key: str, db_path: Path = DB_PATH) -> Optional[str]:
    """Return the value for a meta key, or None if not set."""
    init_db(db_path)
    conn = get_db(db_path)
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    conn.close()
    return row["value"] if row else None


def void_stale_signals(days: int = 3, db_path: Path = DB_PATH) -> list[dict]:
    """
    Mark open signals with no closing line whose game_date is more than
    `days` days in the past as 'no_action'.  Does not delete rows.

    Returns list of voided signal dicts (id, game_id, game_date, signal_type).
    """
    init_db(db_path)
    conn = get_db(db_path)
    cutoff = (datetime.now(_TZ_ET) - timedelta(days=days)).strftime("%Y-%m-%d")
    rows = conn.execute(
        """
        SELECT id, game_id, game_date, signal_type, home_team, away_team
        FROM signal_log
        WHERE closing_line IS NULL
          AND game_date < ?
          AND status NOT IN ('graded', 'no_action')
        """,
        (cutoff,),
    ).fetchall()

    voided = []
    for row in rows:
        conn.execute(
            """
            UPDATE signal_log
            SET status = 'no_action',
                notes  = COALESCE(NULLIF(notes,''), '') ||
                         ' [auto-voided: no closing line after ' || ? || ' days]'
            WHERE id = ?
            """,
            (days, row["id"]),
        )
        voided.append(dict(row))

    conn.commit()
    conn.close()
    return voided


def get_snapshots(game_date: Optional[str] = None, db_path: Path = DB_PATH) -> list[dict]:
    """
    Return all line_snapshots rows for the given ET date (defaults to ET today).
    Sorted by snapshot_label priority then captured_at.
    """
    if game_date is None:
        game_date = (datetime.now(_TZ_ET)).strftime("%Y-%m-%d")
    init_db(db_path)
    conn = get_db(db_path)
    rows = conn.execute(
        """
        SELECT game_id, game_date, home_team, away_team,
               home_line, over_under, snapshot_label, book, source, captured_at
        FROM line_snapshots
        WHERE game_date = ?
        ORDER BY
            CASE snapshot_label
                WHEN 'morning'   THEN 1
                WHEN 'afternoon' THEN 2
                WHEN '6pm_proxy' THEN 3
                ELSE 4
            END,
            captured_at
        """,
        (game_date,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def print_report(db_path: Path = DB_PATH) -> None:
    rows = get_report(db_path)
    conn = get_db(db_path)
    total_graded = conn.execute(
        "SELECT COUNT(*) FROM signal_log WHERE status='graded'"
    ).fetchone()[0]
    total_open = conn.execute(
        "SELECT COUNT(*) FROM signal_log WHERE status IN ('open','proxy_captured')"
    ).fetchone()[0]
    conn.close()

    W = 70
    print()
    print("=" * W)
    print("  ACE — Signal Edge Report")
    print("=" * W)
    print(f"  Graded: {total_graded}   Open/pending: {total_open}   "
          f"Need for status: {MIN_SAMPLES_FOR_STATUS}+")
    print()

    if not rows:
        print("  No graded signals yet. System is accumulating.")
        print()
        return

    # Table header
    print(f"  {'Type':<18} {'N':>4}  {'Status':<14}  "
          f"{'AvgCLV':>7}  {'%PosCLV':>8}  {'WinRate':>8}  {'Range'}")
    print("  " + "─" * (W - 2))

    for r in rows:
        n        = r["n"]
        avg_clv  = r["avg_clv"] or 0.0
        pct_pos  = r["pct_pos_clv"] or 0.0
        win_rate = r["win_rate_pct"] or 0.0
        status   = r["edge_status"]
        clv_str  = f"{avg_clv:>+7.2f}" if n > 0 else "     n/a"

        print(
            f"  {r['signal_type']:<18} {n:>4}  {status:<14}  "
            f"{clv_str}  {pct_pos:>7.1f}%  {win_rate:>7.1f}%  "
            f"{r['first_signal']} → {r['last_signal']}"
        )

    print()
    print("  ── Edge thresholds (requires 30+ graded samples) ───────────────")
    print("    avg CLV < 0          →  bad           finding bad numbers, stop")
    print("    0   ≤ avg CLV < 0.5  →  inconclusive  direction unclear")
    print("    0.5 ≤ avg CLV < 1.0  →  promising     worth continuing to track")
    print("    avg CLV ≥ 1.0        →  strong        clear signal")
    print("    '?' suffix           →  avg CLV ≥ 0 but ≤50% of signals positive")
    print()
    print("  Primary:   avg CLV > 0")
    print("  Secondary: % positive CLV > 50%")
    print("  ROI not used for decisions until 50+ graded samples.")
    print()


def get_model_probs(game_id: str, db_path: Path = DB_PATH) -> Optional[Dict[str, Any]]:
    """
    Return the model's cover probabilities for game_id from the predictions table.
    Returns None if no prediction exists yet for this game.
    """
    init_db(db_path)
    conn = get_db(db_path)
    row = conn.execute(
        "SELECT home_cover_prob, away_cover_prob FROM predictions WHERE game_id = ?",
        (game_id,),
    ).fetchone()
    conn.close()
    if row:
        return dict(row)
    return None


def get_divergence_first_seen(
    game_id: str,
    book: str,
    game_date: str,
    db_path: Path = DB_PATH,
) -> Optional[datetime]:
    """
    Return the UTC datetime of the FIRST divergence alert for (game_id, book, game_date).
    Used to compute gap age at signal logging time.
    Returns None if no alert exists (shouldn't happen if called after check_and_save_divergence_alerts).
    """
    init_db(db_path)
    conn = get_db(db_path)
    row = conn.execute(
        "SELECT MIN(fired_at) AS first_seen FROM divergence_alerts WHERE game_id=? AND book=? AND game_date=?",
        (game_id, book, game_date),
    ).fetchone()
    conn.close()
    if row and row["first_seen"]:
        return datetime.fromisoformat(row["first_seen"])
    return None


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _cmd_log(args: argparse.Namespace) -> None:
    row_id = log_signal(
        game_id=args.game_id,
        game_date=args.date,
        home_team=args.home,
        away_team=args.away,
        signal_type=args.type,
        line_at_signal=args.line,
        bet_side=args.side,
        execution_source=args.book or "",
        signal_detail=args.detail or "",
        commence_time=args.commence or "",
        opening_line=args.opening_line,
        bet_odds=args.odds,
        notes=args.notes or "",
    )
    book_note = f"  book={args.book}" if args.book else ""
    print(f"  Logged signal #{row_id}")
    print(f"    {args.away} @ {args.home}  |  type={args.type}  "
          f"side={args.side}  line={args.line:+.1f}{book_note}")
    print(f"    detail: {args.detail or '—'}")
    print(f"    status: open  |  CLV pending closing line (~6pm ET)")


def _cmd_status(_args: argparse.Namespace) -> None:
    signals = get_open_signals()
    print(f"\n  Open / pending signals: {len(signals)}\n")
    if not signals:
        print("  None.")
        return
    for s in signals:
        src = s.get("execution_source") or "unknown"
        print(
            f"  #{s['id']}  {s['game_date']}  {s['away_team']} @ {s['home_team']}"
            f"  [{s['signal_type']}]  side={s['bet_side']}  "
            f"line={s['line_at_signal']:+.1f}  book={src}  status={s['status']}"
        )
        if s["signal_detail"]:
            print(f"       {s['signal_detail']}")
    print()


def _cmd_close(args: argparse.Namespace) -> None:
    updated = record_closing_proxy(
        game_id=args.game_id,
        closing_line=args.line,
        source=args.source,
    )
    print(f"  Closed {updated} signal(s) for game {args.game_id} "
          f"with closing proxy {args.line:+.1f}")


def _cmd_grade(args: argparse.Namespace) -> None:
    results = grade_signal(args.game_id, args.home_score, args.away_score)
    if not results:
        print(f"  No proxy_captured signals found for game {args.game_id}")
        return
    for r in results:
        clv_str = f"{r['clv_points']:+.2f} pts" if r["clv_points"] is not None else "CLV=n/a"
        covered_str = {1: "WIN", 0: "LOSS", None: "PUSH"}.get(r["covered"], "?")
        print(f"  #{r['id']}  {covered_str}  CLV={clv_str}")


def _cmd_report(_args: argparse.Namespace) -> None:
    print_report()


def _cmd_snapshots(args: argparse.Namespace) -> None:
    date = args.date or (datetime.now(_TZ_ET)).strftime("%Y-%m-%d")
    rows = get_snapshots(game_date=date)
    if not rows:
        print(f"\n  No snapshots found for {date}.")
        return

    # Group by snapshot_label for display
    from itertools import groupby
    print(f"\n  Line snapshots for {date}  ({len(rows)} rows)\n")
    for label, group in groupby(rows, key=lambda r: r["snapshot_label"]):
        items = list(group)
        # Show time from first item in group
        ts = items[0]["captured_at"][11:16] + " UTC"
        print(f"  ── {label:<12} captured ~{ts} ─────────────────────────────")
        for r in items:
            line_str  = f"{r['home_line']:+.1f}"
            ou_str    = f"  O/U {r['over_under']:.1f}" if r["over_under"] else ""
            book_str  = r["book"] or "unknown"
            print(f"     {r['away_team']:<5} @ {r['home_team']:<5}  "
                  f"spread={line_str:<6}{ou_str:<12}  [{book_str}]")
        print()


def _cmd_detect(args: argparse.Namespace) -> None:
    date = args.date or (datetime.now(_TZ_ET)).strftime("%Y-%m-%d")
    created = detect_line_movements(game_date=date, threshold=args.threshold)
    if not created:
        print(f"  No new line movements >= {args.threshold} pts on {date}.")
        return
    print(f"\n  Auto-logged {len(created)} line movement signal(s) for {date}:\n")
    for s in created:
        print(
            f"  #{s['id']}  {s['away_team']} @ {s['home_team']}  "
            f"{s['morning_line']:+.1f} → {s['proxy_line']:+.1f}  "
            f"({s['movement']:+.1f} pts)  bet={s['bet_side'].upper()}"
        )
    print()


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="signal_logger",
        description="ACE signal log — measurement only, no predictions",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    # log
    p_log = sub.add_parser("log", help="Log a new signal")
    p_log.add_argument("--game-id",      required=True)
    p_log.add_argument("--date",         required=True, help="YYYY-MM-DD")
    p_log.add_argument("--home",         required=True, help="3-letter team code")
    p_log.add_argument("--away",         required=True, help="3-letter team code")
    p_log.add_argument("--type",         required=True,
                       choices=["line_movement", "reverse_line", "manual", "soft_book_divergence"],
                       help="Signal type")
    p_log.add_argument("--line",         required=True, type=float,
                       help="home_line at signal time (negative = home favored)")
    p_log.add_argument("--side",         required=True, choices=["home", "away"])
    p_log.add_argument("--detail",       default="", help="Human-readable context")
    p_log.add_argument("--commence",     default="", help="ISO-8601 tipoff (optional)")
    p_log.add_argument("--opening-line", type=float, default=None)
    p_log.add_argument("--odds",         type=float, default=-110.0)
    p_log.add_argument("--book",         default="",
                       help="Bookmaker the line came from (e.g. pinnacle, fanduel)")
    p_log.add_argument("--notes",        default="")

    # status
    sub.add_parser("status", help="Show open/pending signals")

    # close (record closing proxy)
    p_close = sub.add_parser("close", help="Record closing line proxy for a game")
    p_close.add_argument("--game-id", required=True)
    p_close.add_argument("--line",    required=True, type=float)
    p_close.add_argument("--source",  default="odds_api_6pm")

    # grade
    p_grade = sub.add_parser("grade", help="Grade signals for a completed game")
    p_grade.add_argument("--game-id",    required=True)
    p_grade.add_argument("--home-score", required=True, type=int)
    p_grade.add_argument("--away-score", required=True, type=int)

    # report
    sub.add_parser("report", help="CLV report grouped by signal type")

    # detect
    p_detect = sub.add_parser("detect", help="Scan line_snapshots for movements and auto-log signals")
    p_detect.add_argument("--date",      default=None, help="YYYY-MM-DD (default: today ET)")
    p_detect.add_argument("--threshold", type=float, default=1.5,
                          help="Minimum spread movement in points to trigger a signal (default: 1.5)")

    # snapshots
    p_snap = sub.add_parser("snapshots", help="Show captured line snapshots for a date")
    p_snap.add_argument("--date", default=None, help="YYYY-MM-DD (default: today ET)")

    args = parser.parse_args()
    dispatch = {
        "log":       _cmd_log,
        "status":    _cmd_status,
        "close":     _cmd_close,
        "grade":     _cmd_grade,
        "report":    _cmd_report,
        "detect":    _cmd_detect,
        "snapshots": _cmd_snapshots,
    }
    dispatch[args.cmd](args)


if __name__ == "__main__":
    main()
