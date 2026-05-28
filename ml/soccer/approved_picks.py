#!/usr/bin/env python3
"""approved_picks.py — turn surfaced edges into real, tracked bets.

What this module does
=====================
The match intelligence layer surfaces edges across markets. Some of those
are tier-A or tier-B and we want to actually bet them. This module is the
bridge between "the model likes it" and "I have money on it":

  1. approve_pick() — caller passes the market, side, model probability,
     and best book price. We compute the quarter-Kelly recommended stake,
     snapshot the opening line, and persist the pick.
  2. list_approved_picks() — surfaces them for the UI with CLV columns
     (closing price + edge-at-close, populated by the closing-snapshot
     capture job — wired in M19).
  3. mark_pick_status() — used by the grader once the match settles.

Kelly math
==========
We use quarter-Kelly to dampen short-term variance — a model with a
genuinely positive edge will compound at full-Kelly but with brutal
drawdowns. Quarter-Kelly retains ~94% of the geometric growth rate
with ~25% of the variance. Standard hedge-fund discipline.

  decimal_odds   = american_to_decimal(price)
  edge_in_units  = model_prob * decimal_odds - 1
  kelly_full     = edge_in_units / (decimal_odds - 1)
  kelly_quarter  = max(0, kelly_full) * 0.25

If full-Kelly is negative, we DON'T approve — the model thinks the bet is
losing. That should be caught upstream but the helper guards anyway.

Stake recommendation in units (1 unit = 1% of bankroll by convention)
is `kelly_quarter * 100`, capped at 5 units so a single bet can never
risk more than 5% of bankroll regardless of model conviction.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from ml.world_cup.signal_logger import DB_PATH as DEFAULT_DB_PATH


# Maximum unit stake regardless of Kelly output. Protects against a
# model error blowing up bankroll on a single confident-but-wrong pick.
_MAX_STAKE_UNITS = 5.0
_KELLY_FRACTION = 0.25  # quarter-Kelly


# ── Kelly helpers ────────────────────────────────────────────────────────────

def american_to_decimal(price: float) -> float:
    """+200 → 3.00, -150 → 1.667. Standard American → European odds conversion."""
    p = float(price)
    if p >= 0:
        return p / 100.0 + 1.0
    return 100.0 / (-p) + 1.0


def kelly_quarter_stake(model_prob: float, american_price: float) -> Dict[str, Any]:
    """Return a stake recommendation in units (1 unit = 1% of bankroll).

    Output:
      {
        "kelly_full": 0.087,        # full-Kelly fraction (informational)
        "kelly_quarter": 0.022,     # quarter-Kelly fraction (what we use)
        "stake_units": 2.18,        # quarter_kelly * 100, capped at 5
        "decimal_odds": 3.0,
        "edge_in_units": 1.10,      # model_prob * decimal_odds - 1
      }
    """
    decimal = american_to_decimal(american_price)
    edge_units = float(model_prob) * decimal - 1.0
    if edge_units <= 0:
        return {
            "kelly_full":     round(edge_units / (decimal - 1.0), 4) if decimal > 1.0 else 0.0,
            "kelly_quarter":  0.0,
            "stake_units":    0.0,
            "decimal_odds":   round(decimal, 4),
            "edge_in_units":  round(edge_units, 4),
        }
    kelly_full = edge_units / (decimal - 1.0)
    kelly_quarter = kelly_full * _KELLY_FRACTION
    stake_units = min(_MAX_STAKE_UNITS, kelly_quarter * 100.0)
    return {
        "kelly_full":     round(kelly_full, 4),
        "kelly_quarter":  round(kelly_quarter, 4),
        "stake_units":    round(stake_units, 2),
        "decimal_odds":   round(decimal, 4),
        "edge_in_units":  round(edge_units, 4),
    }


# ── Schema ───────────────────────────────────────────────────────────────────

def _get_db(path: Optional[Path] = None) -> sqlite3.Connection:
    p = path or DEFAULT_DB_PATH
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(p))
    conn.row_factory = sqlite3.Row
    return conn


def init_table(path: Optional[Path] = None) -> None:
    """Create soccer_approved_picks if it doesn't exist. Idempotent."""
    conn = _get_db(path)
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS soccer_approved_picks (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                game_id             TEXT NOT NULL,
                fixture_label       TEXT,         -- "PSG vs Arsenal · UCL"
                tournament          TEXT,
                commence_time       TEXT,         -- ISO; populated when known
                market              TEXT NOT NULL,
                side                TEXT NOT NULL,
                bet_label           TEXT NOT NULL,  -- "PSG to win" / "Over 2.5 goals"

                model_prob_at_pick  REAL,
                implied_prob_at_pick REAL,
                edge_pp_at_pick     REAL,
                opening_price       REAL,
                opening_book        TEXT,
                lineup_status_at_pick TEXT,  -- "confirmed" | "projected" | "none"

                kelly_full          REAL,
                stake_units         REAL,

                closing_price       REAL,    -- populated at kickoff (M19)
                closing_book        TEXT,
                clv_pp              REAL,    -- (1/opening_decimal - 1/closing_decimal)
                                              -- positive = we beat the close
                graded_status       TEXT NOT NULL DEFAULT 'open',
                                              -- open | won | lost | push | void
                graded_at           TEXT,
                pnl_units           REAL,

                rationale_json      TEXT,
                notes               TEXT,
                approved_at         TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(game_id, market, side)
            );
            CREATE INDEX IF NOT EXISTS idx_approved_picks_game
              ON soccer_approved_picks(game_id);
            CREATE INDEX IF NOT EXISTS idx_approved_picks_status
              ON soccer_approved_picks(graded_status);
            """
        )
        conn.commit()
    finally:
        conn.close()


# ── Public surface ──────────────────────────────────────────────────────────

def approve_pick(
    *,
    game_id: str,
    market: str,
    side: str,
    bet_label: str,
    model_prob: float,
    best_price: float,
    best_book: str,
    fixture_label: Optional[str] = None,
    tournament: Optional[str] = None,
    commence_time: Optional[str] = None,
    lineup_status: str = "projected",
    rationale: Optional[Dict[str, Any]] = None,
    notes: Optional[str] = None,
    path: Optional[Path] = None,
) -> Dict[str, Any]:
    """Persist an approved pick, snapshot the opening line, compute Kelly.

    Returns the full row dict so the UI can show the recommended stake
    immediately. Refuses to approve if the Kelly recommendation is 0
    (negative edge — guard against the UI passing through stale data).
    """
    kelly = kelly_quarter_stake(model_prob, best_price)
    if kelly["stake_units"] <= 0:
        raise ValueError(
            f"Refusing to approve: model_prob {model_prob:.4f} at price "
            f"{best_price} yields no positive Kelly. Re-check the data."
        )

    implied = 1.0 / kelly["decimal_odds"]
    edge_pp = float(model_prob) - implied

    init_table(path)
    conn = _get_db(path)
    now = datetime.now(timezone.utc).isoformat()
    try:
        # ON CONFLICT(game_id, market, side) DO UPDATE — re-approving the
        # same pick refreshes opening_price + Kelly but does NOT reset the
        # graded_status (so you can't accidentally un-grade a settled bet
        # by re-clicking approve).
        conn.execute(
            """
            INSERT INTO soccer_approved_picks (
                game_id, fixture_label, tournament, commence_time,
                market, side, bet_label,
                model_prob_at_pick, implied_prob_at_pick, edge_pp_at_pick,
                opening_price, opening_book, lineup_status_at_pick,
                kelly_full, stake_units,
                rationale_json, notes,
                approved_at, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(game_id, market, side) DO UPDATE SET
                fixture_label        = excluded.fixture_label,
                tournament           = excluded.tournament,
                commence_time        = excluded.commence_time,
                bet_label            = excluded.bet_label,
                model_prob_at_pick   = excluded.model_prob_at_pick,
                implied_prob_at_pick = excluded.implied_prob_at_pick,
                edge_pp_at_pick      = excluded.edge_pp_at_pick,
                opening_price        = excluded.opening_price,
                opening_book         = excluded.opening_book,
                lineup_status_at_pick = excluded.lineup_status_at_pick,
                kelly_full           = excluded.kelly_full,
                stake_units          = excluded.stake_units,
                rationale_json       = excluded.rationale_json,
                notes                = excluded.notes,
                updated_at           = excluded.updated_at
            """,
            (
                game_id, fixture_label, tournament, commence_time,
                market, side, bet_label,
                round(float(model_prob), 4),
                round(implied, 4),
                round(edge_pp, 4),
                float(best_price), best_book, lineup_status,
                kelly["kelly_full"], kelly["stake_units"],
                json.dumps(rationale, ensure_ascii=False) if rationale else None,
                notes,
                now, now,
            ),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM soccer_approved_picks WHERE game_id=? AND market=? AND side=?",
            (game_id, market, side),
        ).fetchone()
        return dict(row) if row else {}
    finally:
        conn.close()


def list_approved_picks(
    *,
    game_id: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = 50,
    path: Optional[Path] = None,
) -> List[Dict[str, Any]]:
    """Return approved picks, newest first. Filterable by game or status."""
    init_table(path)
    conn = _get_db(path)
    try:
        sql = "SELECT * FROM soccer_approved_picks WHERE 1=1"
        params: List[Any] = []
        if game_id:
            sql += " AND game_id = ?"; params.append(game_id)
        if status:
            sql += " AND graded_status = ?"; params.append(status)
        sql += " ORDER BY approved_at DESC LIMIT ?"; params.append(limit)
        return [dict(r) for r in conn.execute(sql, params).fetchall()]
    finally:
        conn.close()


def summary_stats(path: Optional[Path] = None) -> Dict[str, Any]:
    """Aggregate stats across all approved picks — graded + open."""
    init_table(path)
    conn = _get_db(path)
    try:
        rows = conn.execute("SELECT * FROM soccer_approved_picks").fetchall()
    finally:
        conn.close()

    n_total = len(rows)
    n_open  = sum(1 for r in rows if r["graded_status"] == "open")
    graded = [r for r in rows if r["graded_status"] in ("won", "lost", "push")]
    wins   = sum(1 for r in graded if r["graded_status"] == "won")
    losses = sum(1 for r in graded if r["graded_status"] == "lost")
    pushes = sum(1 for r in graded if r["graded_status"] == "push")
    pnl_units = sum((r["pnl_units"] or 0.0) for r in graded)
    staked    = sum((r["stake_units"] or 0.0) for r in graded)
    roi       = (pnl_units / staked) if staked > 0 else None
    clv_rows  = [r for r in rows if r["clv_pp"] is not None]
    avg_clv   = (sum(r["clv_pp"] for r in clv_rows) / len(clv_rows)) if clv_rows else None
    return {
        "total":       n_total,
        "open":        n_open,
        "graded":      len(graded),
        "wins":        wins,
        "losses":      losses,
        "pushes":      pushes,
        "win_rate":    (wins / len(graded)) if graded else None,
        "pnl_units":   round(pnl_units, 2),
        "staked_units": round(staked, 2),
        "roi":         round(roi, 4) if roi is not None else None,
        "avg_clv_pp":  round(avg_clv, 4) if avg_clv is not None else None,
        "clv_sample":  len(clv_rows),
    }
