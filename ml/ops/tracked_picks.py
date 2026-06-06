#!/usr/bin/env python3
"""Canonical ACE paper-tracked pick ledger.

This module is intentionally additive. It creates/updates tracked_picks.db and
imports from existing sport-specific signal DBs without deleting or mutating the
source DBs.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from ml.ops.confidence_calibration import MODEL_VERSION as CONFIDENCE_MODEL_VERSION
from ml.ops.confidence_calibration import confidence_tier_for_score

APP_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DATA_DIR = APP_ROOT / "ml" / "nba_spread" / "data"
DEFAULT_TARGET_DB = DEFAULT_DATA_DIR / "tracked_picks.db"

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS tracked_picks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  source_table TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_db TEXT,
  source_snapshot_at TEXT,

  sport TEXT NOT NULL,
  tracking_mode TEXT NOT NULL DEFAULT 'paper',
  origin TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  publish_state TEXT NOT NULL DEFAULT 'internal',

  game_id TEXT NOT NULL,
  game_date TEXT,
  commence_time TEXT,
  league TEXT,
  tournament TEXT,
  home_team TEXT,
  away_team TEXT,
  matchup_label TEXT,

  market TEXT NOT NULL,
  side TEXT NOT NULL,
  line REAL,
  selection_label TEXT,

  book TEXT,
  odds_american REAL,
  implied_prob REAL,
  sharp_prob REAL,
  model_prob REAL,
  edge_pp REAL,
  signal_strength REAL,
  confidence_tier TEXT,
  kelly_fraction REAL,
  stake_units REAL,

  model_version TEXT,
  confidence_model_version TEXT,
  rationale_json TEXT,
  notes TEXT,

  closing_book TEXT,
  closing_odds_american REAL,
  closing_implied_prob REAL,
  clv_pp REAL,
  clv_points REAL,

  home_score INTEGER,
  away_score INTEGER,
  result TEXT,
  result_detail TEXT,
  pnl_units REAL,

  detected_at TEXT,
  tracked_at TEXT NOT NULL,
  graded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(source_table, source_id)
);

CREATE INDEX IF NOT EXISTS idx_tracked_picks_sport ON tracked_picks(sport);
CREATE INDEX IF NOT EXISTS idx_tracked_picks_lifecycle ON tracked_picks(lifecycle);
CREATE INDEX IF NOT EXISTS idx_tracked_picks_game_date ON tracked_picks(game_date);
CREATE INDEX IF NOT EXISTS idx_tracked_picks_tracked_at ON tracked_picks(tracked_at);
CREATE INDEX IF NOT EXISTS idx_tracked_picks_publish_state ON tracked_picks(publish_state);
CREATE INDEX IF NOT EXISTS idx_tracked_picks_origin ON tracked_picks(origin);
CREATE INDEX IF NOT EXISTS idx_tracked_picks_source ON tracked_picks(source_table, source_id);

CREATE TABLE IF NOT EXISTS tracked_parlays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL UNIQUE,
  tracking_mode TEXT NOT NULL DEFAULT 'paper',
  origin TEXT NOT NULL DEFAULT 'operator_manual',
  lifecycle TEXT NOT NULL DEFAULT 'open',
  publish_state TEXT NOT NULL DEFAULT 'internal',

  label TEXT NOT NULL,
  sport TEXT,
  stake_units REAL NOT NULL DEFAULT 1.0,
  odds_american REAL,
  implied_prob REAL,
  leg_count INTEGER NOT NULL,
  notes TEXT,

  result TEXT,
  pnl_units REAL,
  tracked_at TEXT NOT NULL,
  graded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tracked_parlay_legs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parlay_id INTEGER NOT NULL,
  pick_id INTEGER NOT NULL,
  leg_index INTEGER NOT NULL,
  FOREIGN KEY(parlay_id) REFERENCES tracked_parlays(id),
  FOREIGN KEY(pick_id) REFERENCES tracked_picks(id),
  UNIQUE(parlay_id, pick_id),
  UNIQUE(parlay_id, leg_index)
);

CREATE INDEX IF NOT EXISTS idx_tracked_parlays_lifecycle ON tracked_parlays(lifecycle);
CREATE INDEX IF NOT EXISTS idx_tracked_parlays_publish_state ON tracked_parlays(publish_state);
CREATE INDEX IF NOT EXISTS idx_tracked_parlay_legs_parlay ON tracked_parlay_legs(parlay_id);

CREATE TABLE IF NOT EXISTS tracked_pick_import_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_name TEXT NOT NULL,
  source_snapshot_at TEXT,
  source_archive_sha256 TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  rows_seen INTEGER DEFAULT 0,
  rows_inserted INTEGER DEFAULT 0,
  rows_updated INTEGER DEFAULT 0,
  rows_skipped INTEGER DEFAULT 0,
  notes TEXT,
  error TEXT
);
"""

TRACKED_COLUMNS = [
    "source_table", "source_id", "source_db", "source_snapshot_at",
    "sport", "tracking_mode", "origin", "lifecycle", "publish_state",
    "game_id", "game_date", "commence_time", "league", "tournament",
    "home_team", "away_team", "matchup_label", "market", "side", "line",
    "selection_label", "book", "odds_american", "implied_prob", "sharp_prob",
    "model_prob", "edge_pp", "signal_strength", "confidence_tier",
    "kelly_fraction", "stake_units", "model_version",
    "confidence_model_version", "rationale_json", "notes", "closing_book",
    "closing_odds_american", "closing_implied_prob", "clv_pp", "clv_points",
    "home_score", "away_score", "result", "result_detail", "pnl_units",
    "detected_at", "tracked_at", "graded_at",
]

@dataclass
class ImportStats:
    name: str
    rows_seen: int = 0
    rows_inserted: int = 0
    rows_updated: int = 0
    rows_skipped: int = 0

    def as_dict(self) -> Dict[str, Any]:
        return self.__dict__.copy()



def calibrated_tier(edge_pp: Optional[float], fallback: Optional[str] = None) -> Optional[str]:
    if edge_pp is None:
        return fallback
    try:
        return confidence_tier_for_score(float(edge_pp))
    except (TypeError, ValueError):
        return fallback

def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def rowdict(row: sqlite3.Row) -> Dict[str, Any]:
    return {k: row[k] for k in row.keys()}


def connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def readonly_connect(path: Path) -> sqlite3.Connection:
    uri = f"file:{path}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def init_db(target_db: Path = DEFAULT_TARGET_DB) -> None:
    conn = connect(target_db)
    conn.executescript(SCHEMA_SQL)
    conn.commit()
    conn.close()


def source_snapshot_at(path: Path) -> str:
    try:
        return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()
    except FileNotFoundError:
        return utc_now()


def table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()
    return row is not None


def map_signal_lifecycle(status: Optional[str]) -> str:
    if status == "graded":
        return "graded"
    if status == "open":
        return "open"
    if status == "void":
        return "void"
    if status == "no_action":
        return "no_action"
    if status == "proxy_captured":
        # Not a settled pick; keep out of Results by default.
        return "archived"
    return "archived"


def result_from_correct(status: Optional[str], correct: Any) -> Optional[str]:
    if status == "void":
        return "void"
    if status != "graded":
        return None
    if correct == 1:
        return "win"
    if correct == 0:
        return "loss"
    return "push"


def result_from_graded_status(status: Optional[str]) -> Optional[str]:
    if status in (None, "", "open"):
        return None
    if status in ("won", "win"):
        return "win"
    if status in ("lost", "loss"):
        return "loss"
    if status == "push":
        return "push"
    if status == "void":
        return "void"
    return status


def lifecycle_from_approved(status: Optional[str]) -> str:
    if status in (None, "", "open"):
        return "open"
    if status in ("won", "lost", "win", "loss", "push"):
        return "graded"
    if status == "void":
        return "void"
    return "archived"


PROTECTED_ORIGINS = {"model_auto", "model_approved", "operator_manual"}


def upsert_pick(conn: sqlite3.Connection, pick: Dict[str, Any], dry_run: bool) -> Tuple[str, Optional[int]]:
    existing = conn.execute(
        "SELECT id, origin FROM tracked_picks WHERE source_table=? AND source_id=?",
        (pick["source_table"], pick["source_id"]),
    ).fetchone()
    if dry_run:
        return ("updated" if existing else "inserted", existing["id"] if existing else None)

    # Historical sync/import jobs should never downgrade a row that was already
    # intentionally paper-tracked at signal-fire time or entered by an operator.
    if existing and pick.get("origin") == "historical_signal" and existing["origin"] in PROTECTED_ORIGINS:
        pick = {**pick, "origin": existing["origin"]}

    payload = {col: pick.get(col) for col in TRACKED_COLUMNS}
    if existing:
        assignments = ", ".join([f"{col}=?" for col in TRACKED_COLUMNS if col not in ("source_table", "source_id")])
        values = [payload[col] for col in TRACKED_COLUMNS if col not in ("source_table", "source_id")]
        values.extend([pick["source_table"], pick["source_id"]])
        conn.execute(
            f"UPDATE tracked_picks SET {assignments}, updated_at=datetime('now') WHERE source_table=? AND source_id=?",
            values,
        )
        return "updated", existing["id"]

    cols = ", ".join(TRACKED_COLUMNS)
    placeholders = ", ".join(["?"] * len(TRACKED_COLUMNS))
    cur = conn.execute(
        f"INSERT INTO tracked_picks ({cols}) VALUES ({placeholders})",
        [payload[col] for col in TRACKED_COLUMNS],
    )
    return "inserted", int(cur.lastrowid)


def _target_for_source(source_db: Path, target_db: Optional[Path] = None) -> Path:
    return target_db if target_db is not None else Path(source_db).parent / "tracked_picks.db"


def _fetch_source_row(source_db: Path, table: str, source_id: int | str) -> Optional[Dict[str, Any]]:
    src = readonly_connect(Path(source_db))
    try:
        if not table_exists(src, table):
            return None
        row = src.execute(f"SELECT * FROM {table} WHERE id=?", (source_id,)).fetchone()
        return rowdict(row) if row else None
    finally:
        src.close()


def track_mlb_signal(source_id: int | str, source_db: Path, target_db: Optional[Path] = None, origin: str = "model_auto") -> Optional[int]:
    """Upsert one MLB signal into the canonical paper ledger."""
    source_db = Path(source_db)
    r = _fetch_source_row(source_db, "mlb_signals", source_id)
    if not r:
        return None
    target = _target_for_source(source_db, target_db)
    init_db(target)
    tgt = connect(target)
    try:
        lifecycle = map_signal_lifecycle(r.get("status"))
        pick = {
            "source_table": "mlb_signals",
            "source_id": str(r["id"]),
            "source_db": source_db.name,
            "source_snapshot_at": source_snapshot_at(source_db),
            "sport": "mlb",
            "tracking_mode": "paper",
            "origin": origin,
            "lifecycle": lifecycle,
            "publish_state": "internal",
            "game_id": r.get("game_id"),
            "game_date": r.get("game_date"),
            "commence_time": r.get("commence_time"),
            "league": r.get("league") or "MLB",
            "home_team": r.get("home_team"),
            "away_team": r.get("away_team"),
            "matchup_label": f"{r.get('away_team')} @ {r.get('home_team')}",
            "market": r.get("market"),
            "side": r.get("bet_side"),
            "line": r.get("line"),
            "book": r.get("book"),
            "odds_american": r.get("book_odds"),
            "implied_prob": r.get("book_prob"),
            "sharp_prob": r.get("pinnacle_prob"),
            "edge_pp": r.get("edge_pp"),
            "signal_strength": r.get("edge_pp"),
            "confidence_tier": calibrated_tier(r.get("edge_pp"), r.get("confidence_tier")),
            "confidence_model_version": CONFIDENCE_MODEL_VERSION if r.get("edge_pp") is not None else None,
            "kelly_fraction": r.get("kelly_fraction"),
            "stake_units": 1.0 if lifecycle in ("open", "graded") else None,
            "rationale_json": r.get("reasoning_json"),
            "notes": r.get("notes"),
            "closing_odds_american": r.get("closing_book_odds"),
            "closing_implied_prob": r.get("closing_pinnacle_prob"),
            "clv_pp": r.get("clv_pp"),
            "home_score": r.get("home_score"),
            "away_score": r.get("away_score"),
            "result": result_from_correct(r.get("status"), r.get("correct")),
            "result_detail": r.get("result"),
            "pnl_units": pnl_units(r.get("status"), r.get("correct"), 1.0),
            "detected_at": r.get("detected_at"),
            "tracked_at": r.get("detected_at") or r.get("created_at") or utc_now(),
            "graded_at": utc_now() if lifecycle in ("graded", "void") else None,
        }
        _, row_id = upsert_pick(tgt, pick, dry_run=False)
        tgt.commit()
        return row_id
    finally:
        tgt.close()


def track_soccer_signal(source_id: int | str, source_db: Path, target_db: Optional[Path] = None, origin: str = "model_auto") -> Optional[int]:
    """Upsert one soccer signal into the canonical paper ledger."""
    source_db = Path(source_db)
    r = _fetch_source_row(source_db, "soccer_signals", source_id)
    if not r:
        return None
    target = _target_for_source(source_db, target_db)
    init_db(target)
    tgt = connect(target)
    try:
        lifecycle = map_signal_lifecycle(r.get("status"))
        pick = {
            "source_table": "soccer_signals",
            "source_id": str(r["id"]),
            "source_db": source_db.name,
            "source_snapshot_at": source_snapshot_at(source_db),
            "sport": "soccer",
            "tracking_mode": "paper",
            "origin": origin,
            "lifecycle": lifecycle,
            "publish_state": "internal",
            "game_id": r.get("game_id"),
            "game_date": r.get("game_date"),
            "commence_time": r.get("commence_time"),
            "tournament": r.get("tournament"),
            "home_team": r.get("home_team"),
            "away_team": r.get("away_team"),
            "matchup_label": f"{r.get('away_team')} @ {r.get('home_team')}",
            "market": r.get("market"),
            "side": r.get("bet_side"),
            "line": r.get("total_line"),
            "selection_label": r.get("player_name"),
            "book": r.get("book"),
            "odds_american": r.get("book_odds"),
            "implied_prob": r.get("book_prob"),
            "sharp_prob": r.get("pinnacle_prob") or r.get("prior_prob"),
            "edge_pp": r.get("edge_pp"),
            "signal_strength": r.get("edge_pp"),
            "confidence_tier": calibrated_tier(r.get("edge_pp"), r.get("confidence_tier")),
            "confidence_model_version": CONFIDENCE_MODEL_VERSION if r.get("edge_pp") is not None else None,
            "kelly_fraction": r.get("kelly_fraction"),
            "stake_units": 1.0 if lifecycle in ("open", "graded") else None,
            "rationale_json": r.get("reasoning_json"),
            "notes": r.get("notes"),
            "closing_odds_american": r.get("closing_book_odds"),
            "closing_implied_prob": r.get("closing_pinnacle_prob"),
            "clv_pp": r.get("clv_pp"),
            "home_score": r.get("home_score"),
            "away_score": r.get("away_score"),
            "result": result_from_correct(r.get("status"), r.get("correct")),
            "result_detail": r.get("result"),
            "pnl_units": pnl_units(r.get("status"), r.get("correct"), 1.0),
            "detected_at": r.get("detected_at"),
            "tracked_at": r.get("detected_at") or r.get("created_at") or utc_now(),
            "graded_at": utc_now() if lifecycle in ("graded", "void") else None,
        }
        _, row_id = upsert_pick(tgt, pick, dry_run=False)
        tgt.commit()
        return row_id
    finally:
        tgt.close()


def track_nba_signal(source_id: int | str, source_db: Path, target_db: Optional[Path] = None, origin: str = "model_auto") -> Optional[int]:
    """Upsert one NBA signal into the canonical paper ledger."""
    source_db = Path(source_db)
    r = _fetch_source_row(source_db, "signal_log", source_id)
    if not r:
        return None
    target = _target_for_source(source_db, target_db)
    init_db(target)
    tgt = connect(target)
    try:
        lifecycle = map_signal_lifecycle(r.get("status"))
        result = None
        if lifecycle == "graded":
            result = "win" if r.get("covered") == 1 else "loss" if r.get("covered") == 0 else "push"
        pick = {
            "source_table": "signal_log",
            "source_id": str(r["id"]),
            "source_db": source_db.name,
            "source_snapshot_at": source_snapshot_at(source_db),
            "sport": "nba",
            "tracking_mode": "paper",
            "origin": origin,
            "lifecycle": lifecycle,
            "publish_state": "internal",
            "game_id": r.get("game_id"),
            "game_date": r.get("game_date"),
            "commence_time": r.get("commence_time"),
            "league": "NBA",
            "home_team": r.get("home_team"),
            "away_team": r.get("away_team"),
            "matchup_label": f"{r.get('away_team')} @ {r.get('home_team')}",
            "market": r.get("signal_type"),
            "side": r.get("bet_side"),
            "line": r.get("line_at_signal"),
            "book": r.get("execution_source"),
            "odds_american": r.get("bet_odds"),
            "notes": r.get("notes") or r.get("signal_detail"),
            "closing_book": r.get("closing_source"),
            "clv_points": r.get("clv_points"),
            "home_score": r.get("score_home"),
            "away_score": r.get("score_away"),
            "result": result,
            "pnl_units": pnl_units("graded", r.get("covered"), 1.0) if lifecycle == "graded" else None,
            "detected_at": r.get("detected_at"),
            "tracked_at": r.get("detected_at") or r.get("created_at") or utc_now(),
            "graded_at": utc_now() if lifecycle in ("graded", "void") else None,
        }
        _, row_id = upsert_pick(tgt, pick, dry_run=False)
        tgt.commit()
        return row_id
    finally:
        tgt.close()



def profit_from_american(stake: float, odds: Optional[float]) -> float:
    if odds is None:
        return stake * (100 / 110)
    odds = float(odds)
    if odds > 0:
        return stake * (odds / 100)
    if odds < 0:
        return stake * (100 / abs(odds))
    return 0.0


def parlay_pnl(result: str, stake: Optional[float], odds: Optional[float]) -> float:
    s = float(stake if stake is not None else 1.0)
    if result == "win":
        return round(profit_from_american(s, odds), 6)
    if result == "loss":
        return round(-s, 6)
    return 0.0


def decimal_from_american(odds: Optional[float]) -> Optional[float]:
    if odds is None:
        return None
    odds = float(odds)
    if odds > 0:
        return 1.0 + (odds / 100.0)
    if odds < 0:
        return 1.0 + (100.0 / abs(odds))
    return None


def american_from_decimal(decimal_odds: Optional[float]) -> Optional[float]:
    if decimal_odds is None or decimal_odds <= 1:
        return None
    if decimal_odds >= 2:
        return round((decimal_odds - 1.0) * 100.0, 2)
    return round(-100.0 / (decimal_odds - 1.0), 2)


def combined_parlay_odds(rows: Iterable[sqlite3.Row]) -> Optional[float]:
    decimal = 1.0
    used = 0
    for row in rows:
        leg_decimal = decimal_from_american(row["odds_american"])
        if leg_decimal is None:
            continue
        decimal *= leg_decimal
        used += 1
    if used == 0:
        return None
    return american_from_decimal(decimal)


def sync_parlay_results(target_db: Path = DEFAULT_TARGET_DB) -> Dict[str, Any]:
    """Settle open parlays once all legs have settled.

    Parlay settlement is conservative: any losing leg loses the parlay; pushes
    reduce the active leg count; all settled with at least one winning/non-push
    leg wins. If any leg remains open, the parlay remains open.
    """
    init_db(Path(target_db))
    conn = connect(Path(target_db))
    settled = []
    try:
        parlays = conn.execute("SELECT * FROM tracked_parlays WHERE lifecycle='open' ORDER BY id").fetchall()
        for parlay in parlays:
            legs = conn.execute(
                """
                SELECT p.* FROM tracked_parlay_legs l
                JOIN tracked_picks p ON p.id=l.pick_id
                WHERE l.parlay_id=? ORDER BY l.leg_index
                """,
                (parlay["id"],),
            ).fetchall()
            if not legs:
                continue
            results = [leg["result"] for leg in legs]
            lifecycles = [leg["lifecycle"] for leg in legs]
            if any(lc == "open" or result is None for lc, result in zip(lifecycles, results)):
                continue
            if any(result == "loss" for result in results):
                result = "loss"
            elif any(result == "win" for result in results):
                result = "win"
            else:
                result = "push"
            pnl = parlay_pnl(result, parlay["stake_units"], parlay["odds_american"])
            conn.execute(
                """
                UPDATE tracked_parlays
                   SET lifecycle='graded', result=?, pnl_units=?, graded_at=?, updated_at=datetime('now')
                 WHERE id=?
                """,
                (result, pnl, utc_now(), parlay["id"]),
            )
            settled.append({"id": parlay["id"], "result": result, "pnl_units": pnl})
        conn.commit()
        return {"ok": True, "settled": settled, "rows_settled": len(settled)}
    finally:
        conn.close()


def add_operator_parlay(
    *,
    pick_ids: List[int],
    label: str,
    stake_units: Optional[float] = 1.0,
    odds_american: Optional[float] = None,
    notes: Optional[str] = None,
    publish_state: str = "internal",
    target_db: Path = DEFAULT_TARGET_DB,
) -> Dict[str, Any]:
    """Create an operator-built paper parlay from canonical tracked pick legs."""
    label = (label or "").strip()
    publish_state = (publish_state or "internal").strip().lower()
    clean_ids = []
    for raw in pick_ids or []:
        try:
            value = int(raw)
        except Exception:
            continue
        if value not in clean_ids:
            clean_ids.append(value)

    if len(clean_ids) < 2:
        raise ValueError("parlay requires at least two unique pick_ids")
    if not label:
        raise ValueError("label is required")
    if publish_state not in {"internal", "signal_feed", "hidden"}:
        raise ValueError("publish_state must be internal, signal_feed, or hidden")

    init_db(Path(target_db))
    conn = connect(Path(target_db))
    try:
        placeholders = ",".join(["?"] * len(clean_ids))
        rows = conn.execute(f"SELECT * FROM tracked_picks WHERE id IN ({placeholders})", clean_ids).fetchall()
        by_id = {int(r["id"]): r for r in rows}
        missing = [pid for pid in clean_ids if pid not in by_id]
        if missing:
            raise ValueError(f"unknown pick_ids: {missing}")
        ordered = [by_id[pid] for pid in clean_ids]
        if odds_american is None:
            odds_american = combined_parlay_odds(ordered)
        implied = None
        if odds_american is not None:
            dec = decimal_from_american(odds_american)
            implied = round(1.0 / dec, 6) if dec else None
        sports = sorted({str(r["sport"]) for r in ordered if r["sport"]})
        sport = sports[0] if len(sports) == 1 else "multi"
        source_id = f"parlay_{uuid.uuid4().hex}"
        now = utc_now()
        cur = conn.execute(
            """
            INSERT INTO tracked_parlays (
              source_id, tracking_mode, origin, lifecycle, publish_state,
              label, sport, stake_units, odds_american, implied_prob, leg_count,
              notes, tracked_at
            ) VALUES (?, 'paper', 'operator_manual', 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (source_id, publish_state, label, sport, float(stake_units or 1.0), odds_american, implied, len(ordered), notes, now),
        )
        parlay_id = int(cur.lastrowid)
        for index, pick_id in enumerate(clean_ids, start=1):
            conn.execute(
                "INSERT INTO tracked_parlay_legs (parlay_id, pick_id, leg_index) VALUES (?, ?, ?)",
                (parlay_id, pick_id, index),
            )
        conn.commit()
        row = get_parlay(conn, parlay_id)
        return row or {"id": parlay_id, "source_id": source_id}
    finally:
        conn.close()


def get_parlay(conn: sqlite3.Connection, parlay_id: int) -> Optional[Dict[str, Any]]:
    parlay = conn.execute("SELECT * FROM tracked_parlays WHERE id=?", (parlay_id,)).fetchone()
    if not parlay:
        return None
    legs = conn.execute(
        """
        SELECT l.leg_index, p.* FROM tracked_parlay_legs l
        JOIN tracked_picks p ON p.id=l.pick_id
        WHERE l.parlay_id=? ORDER BY l.leg_index
        """,
        (parlay_id,),
    ).fetchall()
    out = rowdict(parlay)
    out["legs"] = [rowdict(r) for r in legs]
    return out


def list_parlays(target_db: Path = DEFAULT_TARGET_DB, limit: int = 100) -> List[Dict[str, Any]]:
    init_db(Path(target_db))
    conn = connect(Path(target_db))
    try:
        sync_parlay_results(Path(target_db))
        rows = conn.execute("SELECT id FROM tracked_parlays ORDER BY COALESCE(graded_at, tracked_at) DESC, id DESC LIMIT ?", (limit,)).fetchall()
        return [p for r in rows if (p := get_parlay(conn, int(r["id"]))) is not None]
    finally:
        conn.close()



def update_parlay_publish_state(
    *,
    parlay_id: int,
    publish_state: str,
    target_db: Path = DEFAULT_TARGET_DB,
) -> Dict[str, Any]:
    """Update whether an operator parlay is internal, hidden, or ready for the signal feed."""
    publish_state = (publish_state or "internal").strip().lower()
    if publish_state not in {"internal", "signal_feed", "hidden"}:
        raise ValueError("publish_state must be internal, signal_feed, or hidden")

    init_db(Path(target_db))
    conn = connect(Path(target_db))
    try:
        row = conn.execute("SELECT id FROM tracked_parlays WHERE id=?", (int(parlay_id),)).fetchone()
        if not row:
            raise ValueError(f"unknown parlay_id: {parlay_id}")
        conn.execute(
            "UPDATE tracked_parlays SET publish_state=?, updated_at=datetime('now') WHERE id=?",
            (publish_state, int(parlay_id)),
        )
        conn.commit()
        updated = get_parlay(conn, int(parlay_id))
        return updated or {"id": int(parlay_id), "publish_state": publish_state}
    finally:
        conn.close()

def add_operator_pick(
    *,
    sport: str,
    market: str,
    side: str,
    matchup_label: str,
    game_id: Optional[str] = None,
    game_date: Optional[str] = None,
    commence_time: Optional[str] = None,
    league: Optional[str] = None,
    tournament: Optional[str] = None,
    home_team: Optional[str] = None,
    away_team: Optional[str] = None,
    line: Optional[float] = None,
    selection_label: Optional[str] = None,
    book: Optional[str] = None,
    odds_american: Optional[float] = None,
    implied_prob: Optional[float] = None,
    model_prob: Optional[float] = None,
    edge_pp: Optional[float] = None,
    confidence_tier: Optional[str] = None,
    stake_units: Optional[float] = 1.0,
    notes: Optional[str] = None,
    publish_state: str = "internal",
    target_db: Path = DEFAULT_TARGET_DB,
) -> Dict[str, Any]:
    """Create a manual/operator paper pick in the canonical ledger.

    This is intentionally internal + paper-only. It does not touch real-money
    execution and does not write to legacy sport signal tables.
    """
    sport = (sport or "").strip().lower()
    market = (market or "").strip().lower()
    side = (side or "").strip().lower()
    matchup_label = (matchup_label or "").strip()
    publish_state = (publish_state or "internal").strip().lower()

    if sport not in {"mlb", "nba", "soccer"}:
        raise ValueError("sport must be one of: mlb, nba, soccer")
    if not market:
        raise ValueError("market is required")
    if not side:
        raise ValueError("side is required")
    if not matchup_label:
        raise ValueError("matchup_label is required")
    if publish_state not in {"internal", "signal_feed", "hidden"}:
        raise ValueError("publish_state must be internal, signal_feed, or hidden")

    source_id = f"manual_{uuid.uuid4().hex}"
    now = utc_now()
    pick = {
        "source_table": "operator_manual",
        "source_id": source_id,
        "source_db": Path(target_db).name,
        "source_snapshot_at": now,
        "sport": sport,
        "tracking_mode": "paper",
        "origin": "operator_manual",
        "lifecycle": "open",
        "publish_state": publish_state,
        "game_id": game_id or source_id,
        "game_date": game_date,
        "commence_time": commence_time,
        "league": league,
        "tournament": tournament,
        "home_team": home_team,
        "away_team": away_team,
        "matchup_label": matchup_label,
        "market": market,
        "side": side,
        "line": line,
        "selection_label": selection_label,
        "book": book,
        "odds_american": odds_american,
        "implied_prob": implied_prob,
        "model_prob": model_prob,
        "edge_pp": edge_pp,
        "signal_strength": edge_pp,
        "confidence_tier": calibrated_tier(edge_pp, confidence_tier),
        "confidence_model_version": CONFIDENCE_MODEL_VERSION if edge_pp is not None else None,
        "stake_units": stake_units,
        "notes": notes,
        "detected_at": now,
        "tracked_at": now,
    }
    init_db(Path(target_db))
    conn = connect(Path(target_db))
    try:
        _, row_id = upsert_pick(conn, pick, dry_run=False)
        conn.commit()
        row = conn.execute("SELECT * FROM tracked_picks WHERE id=?", (row_id,)).fetchone()
        return rowdict(row) if row else {**pick, "id": row_id}
    finally:
        conn.close()


def import_mlb_signals(source_db: Path, target_db: Path, dry_run: bool = True) -> ImportStats:
    stats = ImportStats("mlb_signals")
    src = readonly_connect(source_db)
    if not table_exists(src, "mlb_signals"):
        src.close(); return stats
    tgt = connect(target_db); init_db(target_db)
    snapshot = source_snapshot_at(source_db)
    for row in src.execute("SELECT * FROM mlb_signals ORDER BY id"):
        stats.rows_seen += 1
        r = rowdict(row)
        lifecycle = map_signal_lifecycle(r.get("status"))
        pick = {
            "source_table": "mlb_signals",
            "source_id": str(r["id"]),
            "source_db": source_db.name,
            "source_snapshot_at": snapshot,
            "sport": "mlb",
            "tracking_mode": "paper",
            "origin": "historical_signal",
            "lifecycle": lifecycle,
            "publish_state": "internal",
            "game_id": r.get("game_id"),
            "game_date": r.get("game_date"),
            "commence_time": r.get("commence_time"),
            "league": r.get("league") or "MLB",
            "home_team": r.get("home_team"),
            "away_team": r.get("away_team"),
            "matchup_label": f"{r.get('away_team')} @ {r.get('home_team')}",
            "market": r.get("market"),
            "side": r.get("bet_side"),
            "line": r.get("line"),
            "selection_label": None,
            "book": r.get("book"),
            "odds_american": r.get("book_odds"),
            "implied_prob": r.get("book_prob"),
            "sharp_prob": r.get("pinnacle_prob"),
            "model_prob": None,
            "edge_pp": r.get("edge_pp"),
            "signal_strength": r.get("edge_pp"),
            "confidence_tier": calibrated_tier(r.get("edge_pp"), r.get("confidence_tier")),
            "confidence_model_version": CONFIDENCE_MODEL_VERSION if r.get("edge_pp") is not None else None,
            "kelly_fraction": r.get("kelly_fraction"),
            "stake_units": 1.0 if lifecycle in ("open", "graded") else None,
            "rationale_json": r.get("reasoning_json"),
            "notes": r.get("notes"),
            "closing_odds_american": r.get("closing_book_odds"),
            "closing_implied_prob": r.get("closing_pinnacle_prob"),
            "clv_pp": r.get("clv_pp"),
            "home_score": r.get("home_score"),
            "away_score": r.get("away_score"),
            "result": result_from_correct(r.get("status"), r.get("correct")),
            "result_detail": r.get("result"),
            "pnl_units": pnl_units(r.get("status"), r.get("correct"), 1.0),
            "detected_at": r.get("detected_at"),
            "tracked_at": r.get("detected_at") or r.get("created_at") or utc_now(),
            "graded_at": None,
        }
        action, _ = upsert_pick(tgt, pick, dry_run)
        if action == "inserted": stats.rows_inserted += 1
        else: stats.rows_updated += 1
    if not dry_run:
        tgt.commit()
    src.close(); tgt.close()
    return stats


def import_soccer_signals(source_db: Path, target_db: Path, dry_run: bool = True) -> ImportStats:
    stats = ImportStats("soccer_signals")
    src = readonly_connect(source_db)
    if not table_exists(src, "soccer_signals"):
        src.close(); return stats
    tgt = connect(target_db); init_db(target_db)
    snapshot = source_snapshot_at(source_db)
    for row in src.execute("SELECT * FROM soccer_signals ORDER BY id"):
        stats.rows_seen += 1
        r = rowdict(row)
        lifecycle = map_signal_lifecycle(r.get("status"))
        pick = {
            "source_table": "soccer_signals",
            "source_id": str(r["id"]),
            "source_db": source_db.name,
            "source_snapshot_at": snapshot,
            "sport": "soccer",
            "tracking_mode": "paper",
            "origin": "historical_signal",
            "lifecycle": lifecycle,
            "publish_state": "internal",
            "game_id": r.get("game_id"),
            "game_date": r.get("game_date"),
            "commence_time": r.get("commence_time"),
            "tournament": r.get("tournament"),
            "home_team": r.get("home_team"),
            "away_team": r.get("away_team"),
            "matchup_label": f"{r.get('away_team')} @ {r.get('home_team')}",
            "market": r.get("market"),
            "side": r.get("bet_side"),
            "line": r.get("total_line"),
            "book": r.get("book"),
            "odds_american": r.get("book_odds"),
            "implied_prob": r.get("book_prob"),
            "sharp_prob": r.get("pinnacle_prob"),
            "edge_pp": r.get("edge_pp"),
            "signal_strength": r.get("edge_pp"),
            "confidence_tier": calibrated_tier(r.get("edge_pp"), r.get("confidence_tier")),
            "confidence_model_version": CONFIDENCE_MODEL_VERSION if r.get("edge_pp") is not None else None,
            "kelly_fraction": r.get("kelly_fraction"),
            "stake_units": 1.0 if lifecycle in ("open", "graded") else None,
            "rationale_json": r.get("reasoning_json"),
            "notes": r.get("notes"),
            "closing_odds_american": r.get("closing_book_odds"),
            "closing_implied_prob": r.get("closing_pinnacle_prob"),
            "clv_pp": r.get("clv_pp"),
            "home_score": r.get("home_score"),
            "away_score": r.get("away_score"),
            "result": result_from_correct(r.get("status"), r.get("correct")),
            "result_detail": r.get("result"),
            "pnl_units": pnl_units(r.get("status"), r.get("correct"), 1.0),
            "detected_at": r.get("detected_at"),
            "tracked_at": r.get("detected_at") or r.get("created_at") or utc_now(),
            "graded_at": None,
        }
        action, _ = upsert_pick(tgt, pick, dry_run)
        if action == "inserted": stats.rows_inserted += 1
        else: stats.rows_updated += 1
    if not dry_run:
        tgt.commit()
    src.close(); tgt.close()
    return stats


def import_soccer_approved_picks(source_db: Path, target_db: Path, dry_run: bool = True) -> ImportStats:
    stats = ImportStats("soccer_approved_picks")
    src = readonly_connect(source_db)
    if not table_exists(src, "soccer_approved_picks"):
        src.close(); return stats
    tgt = connect(target_db); init_db(target_db)
    snapshot = source_snapshot_at(source_db)
    for row in src.execute("SELECT * FROM soccer_approved_picks ORDER BY id"):
        stats.rows_seen += 1
        r = rowdict(row)
        status = r.get("graded_status")
        lifecycle = lifecycle_from_approved(status)
        pick = {
            "source_table": "soccer_approved_picks",
            "source_id": str(r["id"]),
            "source_db": source_db.name,
            "source_snapshot_at": snapshot,
            "sport": "soccer",
            "tracking_mode": "paper",
            "origin": "model_approved",
            "lifecycle": lifecycle,
            "publish_state": "internal",
            "game_id": r.get("game_id"),
            "commence_time": r.get("commence_time"),
            "tournament": r.get("tournament"),
            "matchup_label": r.get("fixture_label"),
            "market": r.get("market"),
            "side": r.get("side"),
            "selection_label": r.get("bet_label"),
            "book": r.get("opening_book"),
            "odds_american": r.get("opening_price"),
            "implied_prob": r.get("implied_prob_at_pick"),
            "model_prob": r.get("model_prob_at_pick"),
            "edge_pp": r.get("edge_pp_at_pick"),
            "signal_strength": r.get("edge_pp_at_pick"),
            "kelly_fraction": r.get("kelly_full"),
            "stake_units": r.get("stake_units"),
            "model_version": r.get("model_version"),
            "rationale_json": r.get("rationale_json"),
            "notes": r.get("notes"),
            "closing_book": r.get("closing_book"),
            "closing_odds_american": r.get("closing_price"),
            "clv_pp": r.get("clv_pp"),
            "result": result_from_graded_status(status),
            "pnl_units": r.get("pnl_units"),
            "tracked_at": r.get("approved_at") or r.get("updated_at") or utc_now(),
            "graded_at": r.get("graded_at"),
        }
        action, _ = upsert_pick(tgt, pick, dry_run)
        if action == "inserted": stats.rows_inserted += 1
        else: stats.rows_updated += 1
    if not dry_run:
        tgt.commit()
    src.close(); tgt.close()
    return stats


def import_nba_signal_log(source_db: Path, target_db: Path, dry_run: bool = True, include_archived: bool = False) -> ImportStats:
    stats = ImportStats("nba_signal_log")
    src = readonly_connect(source_db)
    if not table_exists(src, "signal_log"):
        src.close(); return stats
    tgt = connect(target_db); init_db(target_db)
    snapshot = source_snapshot_at(source_db)
    for row in src.execute("SELECT * FROM signal_log ORDER BY id"):
        stats.rows_seen += 1
        r = rowdict(row)
        status = r.get("status")
        lifecycle = map_signal_lifecycle(status)
        if lifecycle in ("archived", "no_action") and not include_archived:
            stats.rows_skipped += 1
            continue
        result = None
        if lifecycle == "graded":
            # covered is stored relative to bet_side in this logger's report path.
            result = "win" if r.get("covered") == 1 else "loss" if r.get("covered") == 0 else "push"
        pick = {
            "source_table": "signal_log",
            "source_id": str(r["id"]),
            "source_db": source_db.name,
            "source_snapshot_at": snapshot,
            "sport": "nba",
            "tracking_mode": "paper",
            "origin": "historical_signal",
            "lifecycle": lifecycle,
            "publish_state": "internal",
            "game_id": r.get("game_id"),
            "game_date": r.get("game_date"),
            "commence_time": r.get("commence_time"),
            "league": "NBA",
            "home_team": r.get("home_team"),
            "away_team": r.get("away_team"),
            "matchup_label": f"{r.get('away_team')} @ {r.get('home_team')}",
            "market": r.get("signal_type"),
            "side": r.get("bet_side"),
            "line": r.get("line_at_signal"),
            "book": r.get("execution_source"),
            "odds_american": r.get("bet_odds"),
            "notes": r.get("notes") or r.get("signal_detail"),
            "closing_book": r.get("closing_source"),
            "clv_points": r.get("clv_points"),
            "home_score": r.get("score_home"),
            "away_score": r.get("score_away"),
            "result": result,
            "result_detail": None,
            "pnl_units": pnl_units("graded", r.get("covered"), 1.0) if lifecycle == "graded" else None,
            "detected_at": r.get("detected_at"),
            "tracked_at": r.get("detected_at") or r.get("created_at") or utc_now(),
            "graded_at": None,
        }
        action, _ = upsert_pick(tgt, pick, dry_run)
        if action == "inserted": stats.rows_inserted += 1
        else: stats.rows_updated += 1
    if not dry_run:
        tgt.commit()
    src.close(); tgt.close()
    return stats


def pnl_units(status: Optional[str], correct: Any, stake: float = 1.0, payout: float = 100/110) -> Optional[float]:
    if status != "graded":
        return None
    if correct == 1:
        return round(stake * payout, 6)
    if correct == 0:
        return round(-stake, 6)
    return 0.0


def import_all(source_dir: Path, target_db: Path, dry_run: bool = True, include_archived_nba: bool = False) -> List[ImportStats]:
    init_db(target_db)
    return [
        import_mlb_signals(source_dir / "mlb_signal_log.db", target_db, dry_run),
        import_soccer_signals(source_dir / "wc_signal_log.db", target_db, dry_run),
        import_soccer_approved_picks(source_dir / "wc_signal_log.db", target_db, dry_run),
        import_nba_signal_log(source_dir / "signal_log.db", target_db, dry_run, include_archived=include_archived_nba),
    ]


def summarize(target_db: Path = DEFAULT_TARGET_DB) -> Dict[str, Any]:
    init_db(target_db)
    conn = connect(target_db)
    def q(sql: str, params: Iterable[Any] = ()) -> List[Dict[str, Any]]:
        return [dict(r) for r in conn.execute(sql, tuple(params)).fetchall()]
    summary = {
        "total": q("SELECT COUNT(*) AS count FROM tracked_picks")[0]["count"],
        "by_sport": q("SELECT sport, COUNT(*) AS count FROM tracked_picks GROUP BY sport ORDER BY sport"),
        "by_lifecycle": q("SELECT lifecycle, COUNT(*) AS count FROM tracked_picks GROUP BY lifecycle ORDER BY lifecycle"),
        "by_origin": q("SELECT origin, COUNT(*) AS count FROM tracked_picks GROUP BY origin ORDER BY origin"),
        "by_source": q("SELECT source_table, COUNT(*) AS count FROM tracked_picks GROUP BY source_table ORDER BY source_table"),
        "results": q("""
            SELECT sport,
                   SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) AS wins,
                   SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END) AS losses,
                   SUM(CASE WHEN result='push' THEN 1 ELSE 0 END) AS pushes,
                   COUNT(*) AS graded
            FROM tracked_picks
            WHERE lifecycle='graded'
            GROUP BY sport
            ORDER BY sport
        """),
    }
    conn.close()
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description="ACE canonical tracked-picks ledger")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_init = sub.add_parser("init")
    p_init.add_argument("--target-db", type=Path, default=DEFAULT_TARGET_DB)

    p_import = sub.add_parser("import")
    p_import.add_argument("--source-dir", type=Path, default=DEFAULT_DATA_DIR)
    p_import.add_argument("--target-db", type=Path, default=DEFAULT_TARGET_DB)
    p_import.add_argument("--apply", action="store_true", help="write changes; default is dry-run")
    p_import.add_argument("--include-archived-nba", action="store_true")

    p_summary = sub.add_parser("summarize")
    p_summary.add_argument("--target-db", type=Path, default=DEFAULT_TARGET_DB)

    args = parser.parse_args()
    if args.cmd == "init":
        init_db(args.target_db)
        print(json.dumps({"ok": True, "target_db": str(args.target_db)}, indent=2))
    elif args.cmd == "import":
        stats = import_all(args.source_dir, args.target_db, dry_run=not args.apply, include_archived_nba=args.include_archived_nba)
        print(json.dumps({"dry_run": not args.apply, "target_db": str(args.target_db), "stats": [s.as_dict() for s in stats]}, indent=2))
        if args.apply:
            print(json.dumps({"summary": summarize(args.target_db)}, indent=2))
    elif args.cmd == "summarize":
        print(json.dumps(summarize(args.target_db), indent=2))

if __name__ == "__main__":
    main()
