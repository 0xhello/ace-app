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
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

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


def upsert_pick(conn: sqlite3.Connection, pick: Dict[str, Any], dry_run: bool) -> Tuple[str, Optional[int]]:
    existing = conn.execute(
        "SELECT id FROM tracked_picks WHERE source_table=? AND source_id=?",
        (pick["source_table"], pick["source_id"]),
    ).fetchone()
    if dry_run:
        return ("updated" if existing else "inserted", existing["id"] if existing else None)

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
            "confidence_tier": r.get("confidence_tier"),
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
            "confidence_tier": r.get("confidence_tier"),
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
