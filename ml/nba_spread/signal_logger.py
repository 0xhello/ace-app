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
import sqlite3
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

DB_PATH = Path(__file__).resolve().parent / "data" / "signal_log.db"

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
        # Prevents duplicate snapshots for the same game + label (e.g. running
        # the cron twice). First write wins; subsequent inserts are silently ignored.
        "CREATE UNIQUE INDEX IF NOT EXISTS uidx_snap_game_label ON line_snapshots(game_id, snapshot_label)",
    ]
    for sql in migrations:
        try:
            conn.execute(sql)
        except sqlite3.OperationalError:
            pass  # column/index already exists


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
    db_path: Path = DB_PATH,
) -> int:
    """
    Insert a new signal. Returns the new row id.
    Automatically sets detected_at to now (UTC).

    execution_source — which bookmaker provided line_at_signal (e.g. 'pinnacle').
    """
    if bet_side not in ("home", "away"):
        raise ValueError(f"bet_side must be 'home' or 'away', got {bet_side!r}")

    init_db(db_path)
    conn = get_db(db_path)
    detected_at = datetime.now(timezone.utc).isoformat()
    cursor = conn.execute(
        """
        INSERT INTO signal_log
            (game_id, game_date, home_team, away_team, commence_time,
             signal_type, signal_detail, detected_at,
             opening_line, line_at_signal, execution_source,
             bet_side, bet_odds, notes, status)
        VALUES (?,?,?,?,?,  ?,?,?,  ?,?,?,  ?,?,?, 'open')
        """,
        (
            game_id, game_date, home_team, away_team, commence_time,
            signal_type, signal_detail, detected_at,
            opening_line, line_at_signal, execution_source,
            bet_side, bet_odds, notes,
        ),
    )
    row_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return row_id


def record_closing_proxy(
    game_id: str,
    closing_line: float,
    source: str = "odds_api_6pm",
    db_path: Path = DB_PATH,
) -> int:
    """
    Update all open signals for game_id with the closing line proxy.
    Returns number of rows updated.
    """
    init_db(db_path)
    conn = get_db(db_path)
    captured_at = datetime.now(timezone.utc).isoformat()
    cursor = conn.execute(
        """
        UPDATE signal_log
        SET closing_line       = ?,
            closing_source     = ?,
            closing_captured_at = ?,
            status             = 'proxy_captured'
        WHERE game_id = ?
          AND status  = 'open'
          AND closing_line IS NULL
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
        WHERE game_id = ? AND status = 'proxy_captured'
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
        # Use ET date (UTC-5 conservative) so late games (9:30pm/10pm ET)
        # aren't silently missed because their commence_time rolls into the
        # next UTC calendar day.
        game_date = (datetime.now(timezone.utc) - timedelta(hours=5)).strftime("%Y-%m-%d")

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
        FROM signal_log
        WHERE status = 'graded'
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


def void_stale_signals(days: int = 3, db_path: Path = DB_PATH) -> list[dict]:
    """
    Mark open signals with no closing line whose game_date is more than
    `days` days in the past as 'no_action'.  Does not delete rows.

    Returns list of voided signal dicts (id, game_id, game_date, signal_type).
    """
    init_db(db_path)
    conn = get_db(db_path)
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=5, days=days)).strftime("%Y-%m-%d")
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
        game_date = (datetime.now(timezone.utc) - timedelta(hours=5)).strftime("%Y-%m-%d")
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


def _cmd_status(args: argparse.Namespace) -> None:
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
    date = args.date or (datetime.now(timezone.utc) - timedelta(hours=5)).strftime("%Y-%m-%d")
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
    date = args.date or (datetime.now(timezone.utc) - timedelta(hours=5)).strftime("%Y-%m-%d")
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
                       choices=["line_movement", "reverse_line", "manual"],
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
