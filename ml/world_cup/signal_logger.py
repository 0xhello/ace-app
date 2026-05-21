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


_PICK_COLUMNS: List[tuple] = [
    # (name, sql_type) — added by _migrate() if the row is missing.
    # Keep additive only; never remove or rename a deployed column here.
    ("confidence_tier",       "TEXT"),    # 'A' | 'B' | 'C' — set at log time from edge_pp
    ("kelly_fraction",        "REAL"),    # half-Kelly bet sizing as decimal (0.024 = 2.4% of bankroll)
    ("reasoning_json",        "TEXT"),    # JSON snapshot of context.py output at detection time
    ("closing_pinnacle_prob", "REAL"),    # Pinnacle de-vigged prob captured at/near kickoff
    ("closing_book_odds",     "REAL"),    # soft-book closing odds for CLV comparison
    ("clv_pp",                "REAL"),    # book_prob_at_signal - closing_pinnacle_prob (>0 = beat the close)
    # Player-prop dimension — NULL for game-level signals, set for player markets
    # (anytime goalscorer, first goalscorer, shots on target, to be carded).
    ("player_name",           "TEXT"),    # canonical player name (matches wc_historical_form / wc_players)
    ("api_player_id",         "INTEGER"), # API-Football player ID when we resolved the name to a squad row
    ("prior_prob",            "REAL"),    # OUR computed prior — the reference point for player-prop signals
]


def _migrate(conn: sqlite3.Connection) -> None:
    """Idempotently add new columns to soccer_signals. Safe to run repeatedly.

    Stamps `schema:last_migration_at` in the meta table when a column is
    actually added so we can see in /api/ops/soccer when the production DB
    received the new shape.

    Also upgrades the unique index from (game_id, market, bet_side) to include
    player_name so multiple player-prop signals on the same game (e.g. an
    Mbappé anytime-scorer signal AND a Bellingham anytime-scorer signal)
    don't collide. The migration is a one-time rebuild — see _rebuild_index().
    """
    existing = {row["name"] for row in conn.execute("PRAGMA table_info(soccer_signals)").fetchall()}
    added = False
    for col, typ in _PICK_COLUMNS:
        if col not in existing:
            conn.execute(f"ALTER TABLE soccer_signals ADD COLUMN {col} {typ}")
            added = True
    if added:
        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
            ("schema:last_migration_at", datetime.now(timezone.utc).isoformat()),
        )
    # Rebuild the unique index to include player_name. Old index name was
    # `uidx_soccer_signal`; new one is `uidx_soccer_signal_v2`. Safe to call
    # repeatedly — only fires when the v2 index is missing.
    _rebuild_index_for_player_props(conn)
    conn.commit()


def _rebuild_index_for_player_props(conn: sqlite3.Connection) -> None:
    """Drop the old (game_id, market, bet_side) unique index and create one
    that includes player_name. Without this, two anytime-scorer signals on
    the same game would collide on the UNIQUE constraint.

    Idempotent: checks for the v2 index before doing anything.
    """
    have_v2 = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='uidx_soccer_signal_v2'"
    ).fetchone() is not None
    if have_v2:
        return
    # Drop the old index if it exists, then create the v2 that includes
    # player_name (COALESCE so NULL player_name still uniquely keys the
    # game-level row — the empty-string sentinel keeps SQLite happy).
    conn.execute("DROP INDEX IF EXISTS uidx_soccer_signal")
    conn.execute(
        "CREATE UNIQUE INDEX uidx_soccer_signal_v2 "
        "ON soccer_signals(game_id, market, bet_side, COALESCE(player_name, ''))"
    )


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
            market          TEXT NOT NULL,   -- 'h2h' | 'totals' | 'asian_handicap'
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

        -- Unique index intentionally NOT created here. _migrate() owns it
        -- (uidx_soccer_signal_v2) so we can change the key without fighting
        -- a CREATE IF NOT EXISTS clause that would resurrect the old shape
        -- on every init_db call.

        CREATE INDEX IF NOT EXISTS idx_soccer_game_id ON soccer_signals(game_id);
        CREATE INDEX IF NOT EXISTS idx_soccer_status  ON soccer_signals(status);
        CREATE INDEX IF NOT EXISTS idx_soccer_date    ON soccer_signals(game_date);

        CREATE TABLE IF NOT EXISTS meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL DEFAULT ''
        );
    """)
    _migrate(conn)
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


def _american_to_decimal(odds: float) -> float:
    if odds == 0:
        return 1.0
    return odds / 100.0 + 1.0 if odds > 0 else 100.0 / abs(odds) + 1.0


# ---------------------------------------------------------------------------
# Pick-quality helpers — used by fetch_signals.py at log time
# ---------------------------------------------------------------------------

def confidence_tier(edge_pp: float) -> str:
    """
    Map edge size (decimal probability points) to an internal tier label.
    Tiers are used by the front-end highlighting (invisible-classification,
    visible-outcome pattern) and are kept simple on purpose:

      A — strong play  (edge >= 7pp)
      B — solid play   (edge >= 4pp)
      C — marginal     (edge >= 3pp, the firing threshold)
    """
    if edge_pp is None:
        return "C"
    if edge_pp >= 0.07:
        return "A"
    if edge_pp >= 0.04:
        return "B"
    return "C"


def kelly_fraction(true_prob: float, book_odds: float, kelly_mult: float = 0.5, cap: float = 0.05) -> float:
    """
    Half-Kelly suggested bet size as fraction of bankroll.

    Uses pinnacle_prob (sharp benchmark) as our estimate of true win probability
    and the soft-book American odds as the price we'd actually get. Returns 0
    when there's no positive expected value. Capped at `cap` (default 5%) so a
    single pick can't dominate the bankroll.
    """
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
    total_line: Optional[float] = None,
    notes: str = "",
    reasoning_json: Optional[str] = None,
    tournament: str = "FIFA World Cup",
    path: Optional[Path] = None,
) -> int:
    """
    Insert a new signal-as-pick. Silently ignores duplicates (same game_id +
    market + bet_side + player_name). Returns the new row id, or 0 if duplicate.

    `tournament` distinguishes which competition this signal belongs to —
    'FIFA World Cup' (default for backward compat), 'Premier League',
    'La Liga', etc. Ops dashboard groups by this column.

    confidence_tier and kelly_fraction are derived from edge_pp / pinnacle_prob /
    book_odds — no caller computation required.

    `path` defaults to None so DB_PATH is resolved at call time (respects
    monkeypatch in tests; default args would otherwise bind at definition).
    """
    if path is None:
        path = DB_PATH
    init_db(path)
    conn = get_db(path)
    detected_at = datetime.now(timezone.utc).isoformat()

    tier   = confidence_tier(edge_pp)
    kelly  = kelly_fraction(_null_float(pinnacle_prob) or 0.0, _null_float(book_odds) or 0.0)

    cursor = conn.execute(
        """
        INSERT OR IGNORE INTO soccer_signals
            (game_id, game_date, home_team, away_team, commence_time, tournament,
             market, bet_side, total_line,
             pinnacle_prob, book, book_prob, book_odds, edge_pp,
             confidence_tier, kelly_fraction, reasoning_json,
             notes, detected_at)
        VALUES (?,?,?,?,?,?, ?,?,?, ?,?,?,?,?, ?,?,?, ?,?)
        """,
        (
            game_id, game_date, home_team, away_team, commence_time, tournament,
            market, bet_side, _null_float(total_line),
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


def log_player_prop_signal(
    game_id: str,
    game_date: str,
    home_team: str,
    away_team: str,
    commence_time: str,
    market: str,              # e.g. 'player_goal_scorer_anytime'
    bet_side: str,            # 'yes' for anytime, etc.
    player_name: str,         # canonical
    api_player_id: Optional[int],
    prior_prob: float,        # OUR computed prior (the "sharp" reference)
    book: str,
    book_prob: float,
    book_odds: float,
    edge_pp: float,
    notes: str = "",
    reasoning_json: Optional[str] = None,
    path: Optional[Path] = None,
) -> int:
    """
    Log a player-prop divergence signal. Unlike game-level signals where
    Pinnacle is the sharp reference, player props compare the soft-book
    price to OUR computed prior (compute_goalscorer_prior). When Pinnacle
    eventually posts WC player props, we'll also anchor against it — but
    that's a v2 layer; v1 uses our prior.

    Stores both prior_prob (our number) and pinnacle_prob (left NULL until
    we have a real Pinnacle player-prop comparison). The book_prob and
    edge_pp are the same shape as game-level signals so the ops UI can
    render them with no changes.

    Idempotent on (game_id, market, bet_side, player_name) via the v2
    unique index. `path` resolves at call time so tests can monkeypatch.
    """
    if path is None:
        path = DB_PATH
    init_db(path)
    conn = get_db(path)
    detected_at = datetime.now(timezone.utc).isoformat()

    tier  = confidence_tier(edge_pp)
    kelly = kelly_fraction(_null_float(prior_prob) or 0.0, _null_float(book_odds) or 0.0)

    cursor = conn.execute(
        """
        INSERT OR IGNORE INTO soccer_signals
            (game_id, game_date, home_team, away_team, commence_time,
             market, bet_side, total_line,
             pinnacle_prob, book, book_prob, book_odds, edge_pp,
             confidence_tier, kelly_fraction, reasoning_json,
             player_name, api_player_id, prior_prob,
             notes, detected_at)
        VALUES (?,?,?,?,?, ?,?,?, ?,?,?,?,?, ?,?,?, ?,?,?, ?,?)
        """,
        (
            game_id, game_date, home_team, away_team, commence_time,
            market, bet_side, None,                              # no total_line for player props
            None, book, _null_float(book_prob),                  # pinnacle_prob NULL until v2
            _null_float(book_odds), _null_float(edge_pp),
            tier, kelly, reasoning_json,
            player_name, api_player_id, _null_float(prior_prob),
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


def update_closing_lines(
    game_id: str,
    pinnacle_probs_by_side: Dict[str, float],
    book_odds_by_side_book: Dict[tuple, float],
    path: Optional[Path] = None,
) -> int:
    """
    Stamp closing-line snapshots onto every still-open signal for a game.

    Called near kickoff. For each open signal we already have:
      - book_prob (logged at signal time — the price we'd have bet at)
      - bet_side, book (so we can look up the matching closing odds now)

    We compute:
      - closing_pinnacle_prob = current Pinnacle de-vigged prob for bet_side
      - closing_book_odds     = current American odds for (book, bet_side)
      - clv_pp = closing_pinnacle_prob - book_prob_at_signal
                 (positive → we beat the close; the sharp truth caught up
                  with the value we spotted, validating our entry)

    Returns the number of signals updated. Only updates rows where
    closing_pinnacle_prob is still NULL — once captured, treated as
    final and never overwritten.

    Args:
      pinnacle_probs_by_side: {'home': 0.42, 'draw': 0.28, 'away': 0.30}
                              (or {'over': 0.55, 'under': 0.45} for totals)
      book_odds_by_side_book: {('fanduel', 'draw'): +240, ...} — current
                              American odds per (book, bet_side) pair
    """
    if path is None:
        path = DB_PATH
    init_db(path)
    conn = get_db(path)
    open_rows = conn.execute(
        """SELECT id, market, bet_side, book, book_prob
           FROM soccer_signals
           WHERE game_id = ? AND status = 'open' AND closing_pinnacle_prob IS NULL""",
        (game_id,),
    ).fetchall()

    updated = 0
    for row in open_rows:
        side = row["bet_side"]
        closing_pin = _null_float(pinnacle_probs_by_side.get(side))
        closing_odds = _null_float(book_odds_by_side_book.get((row["book"], side)))

        if closing_pin is None:
            continue  # can't compute CLV without a sharp benchmark

        book_prob = _null_float(row["book_prob"])
        clv = (closing_pin - book_prob) if book_prob is not None else None

        conn.execute(
            """UPDATE soccer_signals
               SET closing_pinnacle_prob = ?,
                   closing_book_odds     = ?,
                   clv_pp                = ?
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
