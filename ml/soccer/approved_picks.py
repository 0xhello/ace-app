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


# ── Lineup freshness ────────────────────────────────────────────────────────

def lineup_freshness(
    game_id: str,
    *,
    home_team: Optional[str] = None,
    away_team: Optional[str] = None,
    commence_time: Optional[str] = None,
    path: Optional[Path] = None,
) -> Dict[str, Any]:
    """How recent / confident is our lineup snapshot for this fixture?

    Returns a dict with a traffic-light tier the UI can color:
      green  — confirmed XI snapshot exists, refreshed < 90 min ago
      amber  — projected XI snapshot, refreshed < 24 h ago
      red    — no snapshot OR snapshot > 24 h old (stale; M7/M8 won't fire)

    We look up by game_id in soccer_player_feature_snapshot. When the row
    set is empty, we fall back to looking up by team_name (the snapshot
    table is sometimes populated team-keyed rather than game-keyed for
    fixtures the Sportmonks live pipeline hasn't yet mapped).
    """
    init_table(path)
    conn = _get_db(path)
    try:
        # Does the snapshot table even exist on this DB?
        row = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='soccer_player_feature_snapshot'"
        ).fetchone()
        if not row:
            return {"tier": "red", "reason": "no-snapshot-table"}

        # Try game_id first
        snaps = conn.execute(
            """SELECT lineup_status, MAX(updated_at) AS updated_at, COUNT(*) AS n_players
                 FROM soccer_player_feature_snapshot
                WHERE game_id = ?
             GROUP BY lineup_status""",
            (game_id,),
        ).fetchall()
        # Fall back to team_name when no game-keyed rows
        if not snaps and (home_team or away_team):
            params = []
            wheres = []
            if home_team:
                wheres.append("team = ?")
                params.append(home_team)
            if away_team:
                wheres.append("team = ?")
                params.append(away_team)
            sql = (
                "SELECT lineup_status, MAX(updated_at) AS updated_at, "
                "       COUNT(*) AS n_players "
                "  FROM soccer_player_feature_snapshot "
                f"WHERE ({' OR '.join(wheres)}) "
                "GROUP BY lineup_status"
            )
            snaps = conn.execute(sql, params).fetchall()

        if not snaps:
            return {"tier": "red", "reason": "no-snapshot-for-fixture"}

        # Aggregate: did we get confirmed_starting status? When was the
        # snapshot last refreshed?
        statuses = {r["lineup_status"]: dict(r) for r in snaps}
        confirmed = statuses.get("confirmed_starting")
        projected = statuses.get("projected_starting") or statuses.get("projected_unknown")

        latest_updated: Optional[str] = None
        n_players = 0
        for r in snaps:
            n_players += r["n_players"] or 0
            if r["updated_at"] and (latest_updated is None or r["updated_at"] > latest_updated):
                latest_updated = r["updated_at"]

        # Compute age in minutes
        age_min: Optional[int] = None
        if latest_updated:
            try:
                t = datetime.fromisoformat(latest_updated.replace("Z", "+00:00"))
                now = datetime.now(timezone.utc)
                age_min = max(0, int((now - t).total_seconds() / 60))
            except Exception:
                age_min = None

        # Distance to kickoff
        mins_to_kickoff: Optional[int] = None
        if commence_time:
            try:
                t = datetime.fromisoformat(commence_time.replace("Z", "+00:00"))
                now = datetime.now(timezone.utc)
                mins_to_kickoff = int((t - now).total_seconds() / 60)
            except Exception:
                mins_to_kickoff = None

        tier = "red"
        reason = ""
        if confirmed and age_min is not None and age_min <= 90:
            tier, reason = "green", f"confirmed XI refreshed {age_min}m ago"
        elif confirmed and age_min is not None and age_min <= 24 * 60:
            tier, reason = "amber", f"confirmed XI but {age_min}m old"
        elif projected and age_min is not None and age_min <= 24 * 60:
            tier, reason = "amber", f"projected XI {age_min}m ago"
        elif statuses:
            tier, reason = "red", "snapshot too stale (>24h)"

        return {
            "tier": tier,
            "reason": reason,
            "n_players": n_players,
            "latest_updated": latest_updated,
            "age_minutes": age_min,
            "minutes_to_kickoff": mins_to_kickoff,
            "has_confirmed": confirmed is not None,
            "has_projected": projected is not None,
        }
    finally:
        conn.close()


# ── Closing-price capture ───────────────────────────────────────────────────

def capture_closing_prices(
    *,
    open_odds_lookup: Any,  # Callable[(game_id, market, side) -> {price, book} | None]
    path: Optional[Path] = None,
    near_kickoff_minutes: int = 30,
) -> Dict[str, Any]:
    """For every open approved pick whose commence_time is within ±30 min
    of now, snapshot the current best price as closing_price and compute
    CLV pp.

    CLV math: positive when the market moved TOWARD our side (we got a
    price better than the close).
      clv_pp = implied_at_close − implied_at_open

    ``open_odds_lookup`` is dependency-injected so this module doesn't
    depend on the Odds API plumbing — the caller (worker tick) wires
    it to the cached odds. Signature:
        f(game_id: str, market: str, side: str) -> Dict | None
        returning {"price": int, "book": str} or None if unavailable.

    Idempotent: skips picks where closing_price is already set.
    """
    init_table(path)
    conn = _get_db(path)
    captured = 0
    skipped_no_quote = 0
    skipped_not_in_window = 0
    now = datetime.now(timezone.utc)
    try:
        rows = conn.execute(
            "SELECT * FROM soccer_approved_picks "
            " WHERE closing_price IS NULL AND graded_status = 'open'"
        ).fetchall()
        for r in rows:
            commence_time = r["commence_time"]
            if not commence_time:
                continue
            try:
                kickoff = datetime.fromisoformat(commence_time.replace("Z", "+00:00"))
            except Exception:
                continue
            delta_min = (kickoff - now).total_seconds() / 60
            # Window: within near_kickoff_minutes of kickoff time (before or after)
            if delta_min > near_kickoff_minutes:
                skipped_not_in_window += 1
                continue
            if delta_min < -near_kickoff_minutes * 2:
                # match started > 60 min ago → too late, skip
                skipped_not_in_window += 1
                continue
            try:
                quote = open_odds_lookup(r["game_id"], r["market"], r["side"])
            except Exception:
                quote = None
            if not quote or quote.get("price") is None:
                skipped_no_quote += 1
                continue

            close_price = float(quote["price"])
            close_book = quote.get("book") or "unknown"
            close_implied = 1.0 / american_to_decimal(close_price)
            open_implied = float(r["implied_prob_at_pick"] or 0.0)
            clv_pp = close_implied - open_implied
            conn.execute(
                """UPDATE soccer_approved_picks
                      SET closing_price = ?,
                          closing_book = ?,
                          clv_pp = ?,
                          updated_at = ?
                    WHERE id = ?""",
                (close_price, close_book, round(clv_pp, 4),
                 now.isoformat(), r["id"]),
            )
            captured += 1
        conn.commit()
    finally:
        conn.close()
    return {
        "captured": captured,
        "skipped_no_quote": skipped_no_quote,
        "skipped_not_in_window": skipped_not_in_window,
    }


# ── Post-match grading ──────────────────────────────────────────────────────

def grade_approved_picks(
    *,
    result_lookup: Any,  # Callable[(game_id) -> {home_score, away_score, status}] | None
    path: Optional[Path] = None,
) -> Dict[str, Any]:
    """Walk open approved picks. For any whose game has a final result,
    determine win/loss/push and set graded_status + pnl_units.

    ``result_lookup`` returns {"home_score": int, "away_score": int,
    "status": "final"|"in_progress"|None} or None if no result is known.

    pnl_units math (in 1u stake units):
        won  → stake_units × (decimal_odds − 1)
        lost → -stake_units
        push → 0
        void → 0
    """
    init_table(path)
    conn = _get_db(path)
    graded = 0
    skipped_no_result = 0
    try:
        rows = conn.execute(
            "SELECT * FROM soccer_approved_picks WHERE graded_status = 'open'"
        ).fetchall()
        for r in rows:
            try:
                res = result_lookup(r["game_id"]) if result_lookup else None
            except Exception:
                res = None
            if not res or res.get("status") != "final":
                skipped_no_result += 1
                continue
            hs = int(res.get("home_score") or 0)
            as_ = int(res.get("away_score") or 0)
            outcome = _resolve_outcome(r["market"], r["side"], hs, as_)
            if outcome is None:
                # Market we don't know how to grade yet — leave open, surface
                # so a follow-up can extend.
                continue
            decimal = american_to_decimal(float(r["opening_price"]))
            stake = float(r["stake_units"] or 0.0)
            if outcome == "won":
                pnl = stake * (decimal - 1.0)
            elif outcome == "lost":
                pnl = -stake
            else:
                pnl = 0.0
            conn.execute(
                """UPDATE soccer_approved_picks
                      SET graded_status = ?,
                          graded_at = ?,
                          pnl_units = ?,
                          updated_at = ?
                    WHERE id = ?""",
                (outcome,
                 datetime.now(timezone.utc).isoformat(),
                 round(pnl, 4),
                 datetime.now(timezone.utc).isoformat(),
                 r["id"]),
            )
            graded += 1
        conn.commit()
    finally:
        conn.close()
    return {"graded": graded, "skipped_no_result": skipped_no_result}


def _resolve_outcome(market: str, side: str, hs: int, as_: int) -> Optional[str]:
    """Return 'won' / 'lost' / 'push' for a given market+side and final score.
    None means we don't know how to grade this market yet."""
    s = side.lower()
    m = market.lower()
    total = hs + as_
    if m in ("1x2", "h2h"):
        winner = "home" if hs > as_ else "away" if as_ > hs else "draw"
        return "won" if s == winner else "lost"
    if m in ("totals 2.5", "totals_2.5", "totals_25", "totals"):
        if total == 2 and s in ("over", "under"):
            return "push" if False else ("won" if s == "over" and total > 2.5 else
                                          "won" if s == "under" and total < 2.5 else "lost")
        if total > 2.5:
            return "won" if s == "over" else "lost"
        if total < 2.5:
            return "won" if s == "under" else "lost"
        return "push"
    if m == "btts":
        both_scored = hs >= 1 and as_ >= 1
        if s == "yes":  return "won" if both_scored else "lost"
        if s == "no":   return "won" if not both_scored else "lost"
        return None
    return None


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
