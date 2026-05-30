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

# ── M40.6 — leakage-aware stake caps ──────────────────────────────────────
# Kelly assumes the model probability is perfectly calibrated. Per the
# 2026-05-29 leakage audit, our soccer model's edges are partially
# over-fit (shrinkage + M21 hyperparams tuned on the same holdout used
# to report ROI). Until M40.2 ships proper train/val/test splits, Kelly
# over-stakes on any pick the model surfaces.
#
# Until then, when a pick's rationale flags one of the audit caveats,
# we cap the displayed stake_units at a conservative ceiling. The
# underlying Kelly_full math stays honest in the DB so we can compare
# post-M40.2 calibration; only the recommended size is capped.
#
# Tiered caps (most → least confident):
#   - validated market (Totals 2.5) with leakage note:    1.0u
#   - cross-checked market w/ leakage note (BTTS, etc):   0.5u
#   - unvalidated market (backtest_support='NONE'):       0.25u
#
# Caps are NOT applied when rationale has no leakage flag — that path
# preserves the original Kelly behaviour for any future model that
# earns its keep through clean validation.
_LEAKAGE_CAP_VALIDATED   = 1.0
_LEAKAGE_CAP_CROSSCHECK  = 0.5
_LEAKAGE_CAP_UNVALIDATED = 0.25

# Markets we've measured positive ROI on in at least one backtest run
# (Over 2.5 over, post-M21). These get the highest leakage cap because
# the directional signal is more trustworthy even if magnitude is over-fit.
_VALIDATED_MARKETS = {"totals_2.5", "totals"}


def _apply_leakage_cap(
    raw_stake_units: float,
    market: str,
    rationale: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    """If the rationale block flags a leakage caveat, replace the raw
    Kelly recommendation with a tier-appropriate conservative cap.

    Returns:
      {
        "stake_units":      capped value (what the UI displays),
        "raw_stake_units":  original Kelly value (preserved for audit),
        "cap_applied":      bool — whether a cap took effect,
        "cap_reason":       short string for the badge,
      }
    """
    if not rationale:
        return {
            "stake_units":      raw_stake_units,
            "raw_stake_units":  raw_stake_units,
            "cap_applied":      False,
            "cap_reason":       None,
        }
    has_leakage_note = bool(rationale.get("leakage_note"))
    backtest_support_raw = (rationale.get("backtest_support") or "")
    backtest_support = backtest_support_raw.upper().strip()
    # Catch "NONE", "NONE — ...", "NOT YET BACKTESTED", "no backtest" etc.
    unvalidated = (
        backtest_support == "NONE"
        or backtest_support.startswith("NONE ")
        or backtest_support.startswith("NONE—")
        or backtest_support.startswith("NONE -")
        or backtest_support.startswith("NOT")
        or "untested" in backtest_support_raw.lower()
        or "never backtested" in backtest_support_raw.lower()
        or "no backtest" in backtest_support_raw.lower()
    )
    # Markets we treat as untested by default regardless of how the
    # caller phrased their rationale.  Player props have never had a
    # backtest harness; treat them as untested unless the rationale
    # explicitly cites a positive backtest.
    untested_markets = {
        "anytime_scorer", "shots", "shots_on_target",
        "anytime_assist", "first_scorer", "to_score_2_or_more",
    }
    if market.lower() in untested_markets and "POSITIVE" not in backtest_support:
        unvalidated = True

    # Pick the tightest applicable ceiling
    cap: Optional[float] = None
    reason: Optional[str] = None
    if unvalidated:
        cap = _LEAKAGE_CAP_UNVALIDATED
        reason = "untested market — leakage-aware cap"
    elif has_leakage_note and market.lower() in _VALIDATED_MARKETS:
        cap = _LEAKAGE_CAP_VALIDATED
        reason = "leakage-aware cap (validated market)"
    elif has_leakage_note:
        cap = _LEAKAGE_CAP_CROSSCHECK
        reason = "leakage-aware cap (cross-check market)"

    if cap is None or raw_stake_units <= cap:
        return {
            "stake_units":      raw_stake_units,
            "raw_stake_units":  raw_stake_units,
            "cap_applied":      False,
            "cap_reason":       None,
        }
    return {
        "stake_units":      round(cap, 2),
        "raw_stake_units":  raw_stake_units,
        "cap_applied":      True,
        "cap_reason":       reason,
    }


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


_CURRENT_MODEL_VERSION = "v2_post_m21"
_LEGACY_MODEL_VERSION  = "v1_pre_m21"


def init_table(path: Optional[Path] = None) -> None:
    """Create soccer_approved_picks if it doesn't exist. Idempotent.

    Also handles the M37 follow-up migration: add a `model_version` column
    on existing tables so the displayed track record can filter out
    legacy v1 picks (made before M9 xG priors + M21 calibration fixes).

    Migration steps (all idempotent — safe to run on every call):
      1. CREATE TABLE includes model_version column for fresh installs.
      2. ALTER TABLE adds the column to pre-existing DBs that lack it.
      3. Pre-existing rows are tagged `v1_pre_m21` (legacy backfill).
         The default for new rows is `v2_post_m21`, but we set it
         explicitly in approve_pick() so the source of truth is the
         module constant, not the SQL default.
    """
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

                model_version       TEXT NOT NULL DEFAULT 'v2_post_m21',
                                              -- v1_pre_m21 = legacy backfill
                                              -- v2_post_m21 = current model

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

        # Idempotent ALTER for pre-existing DBs created before M37. We can't
        # CREATE INDEX on model_version inside the executescript above
        # because pre-M37 DBs don't have that column yet — the executescript
        # would explode on the index DDL even though the CREATE TABLE is a
        # no-op. So we add the column first (if missing), then build the
        # index — both operations are idempotent.
        cols = {row["name"] for row in conn.execute(
            "PRAGMA table_info(soccer_approved_picks)"
        ).fetchall()}
        if "model_version" not in cols:
            # SQLite can't add NOT NULL columns without a default. The default
            # here is intentionally the LEGACY version, so every pre-existing
            # row gets tagged as backfill. New inserts overwrite this with
            # the current version explicitly.
            conn.execute(
                "ALTER TABLE soccer_approved_picks "
                f"ADD COLUMN model_version TEXT NOT NULL DEFAULT '{_LEGACY_MODEL_VERSION}'"
            )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_approved_picks_model_version "
            "ON soccer_approved_picks(model_version)"
        )

        # Belt-and-suspenders: any row that somehow ended up with NULL or
        # empty model_version gets tagged as legacy. New approvals always
        # set it explicitly to _CURRENT_MODEL_VERSION via approve_pick().
        conn.execute(
            "UPDATE soccer_approved_picks "
            "   SET model_version = ? "
            " WHERE model_version IS NULL OR model_version = ''",
            (_LEGACY_MODEL_VERSION,),
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

    # M40.6 — apply leakage-aware cap. Underlying Kelly stays in the
    # rationale (raw_stake_units, cap_applied, cap_reason) so we can
    # measure post-M40.2 calibration against the original recommendation.
    cap_result = _apply_leakage_cap(kelly["stake_units"], market, rationale)
    displayed_stake = cap_result["stake_units"]
    if cap_result["cap_applied"]:
        # Decorate the rationale so the UI can surface the badge cleanly
        rationale = dict(rationale or {})
        rationale["stake_cap_applied"] = True
        rationale["stake_cap_reason"] = cap_result["cap_reason"]
        rationale["raw_kelly_stake_units"] = cap_result["raw_stake_units"]

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
                model_version,
                rationale_json, notes,
                approved_at, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
                model_version        = excluded.model_version,
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
                kelly["kelly_full"], displayed_stake,
                _CURRENT_MODEL_VERSION,
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
    model_version: Optional[str] = _CURRENT_MODEL_VERSION,
    limit: int = 50,
    path: Optional[Path] = None,
) -> List[Dict[str, Any]]:
    """Return approved picks, newest first. Filterable by game or status.

    ``model_version`` defaults to the current model version so the UI never
    accidentally surfaces legacy v1 backfill picks alongside live picks.
    Pass ``model_version=None`` to include every version (ops debugging).
    Pass ``model_version="v1_pre_m21"`` to inspect the backfill cohort.
    """
    init_table(path)
    conn = _get_db(path)
    try:
        sql = "SELECT * FROM soccer_approved_picks WHERE 1=1"
        params: List[Any] = []
        if game_id:
            sql += " AND game_id = ?"; params.append(game_id)
        if status:
            sql += " AND graded_status = ?"; params.append(status)
        if model_version is not None:
            sql += " AND model_version = ?"; params.append(model_version)
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
    result_lookup: Any,  # Callable[(game_id) -> {home_score, away_score, status, goal_scorers?}] | None
    path: Optional[Path] = None,
) -> Dict[str, Any]:
    """Walk open approved picks. For any whose game has a final result,
    determine win/loss/push and set graded_status + pnl_units.

    ``result_lookup`` returns {"home_score": int, "away_score": int,
    "status": "final"|"in_progress"|None, "goal_scorers": List[str] | None}
    or None if no result is known.

    The optional ``goal_scorers`` list (every player who scored, ordered
    by event time) is required to grade player-prop markets like
    ``anytime_scorer``. Game-level markets (1X2, totals, BTTS) ignore it.

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
            goal_scorers = res.get("goal_scorers")  # may be None for game-level
            outcome = _resolve_outcome(
                r["market"], r["side"], hs, as_,
                goal_scorers=goal_scorers,
                bet_label=r["bet_label"],
            )
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


def _norm_player_name(s: Optional[str]) -> str:
    """Lowercase + accent-fold + alphanumeric-only. 'Ousmane Dembélé'
    → 'ousmanedembele'. Used as the full-name token."""
    if not s:
        return ""
    table = str.maketrans("àáâãäåèéêëìíîïòóôõöùúûüýÿñç",
                          "aaaaaaeeeeiiiiooooouuuuyync")
    return "".join(ch.lower() for ch in s.translate(table) if ch.isalnum())


def _last_name_token(s: Optional[str]) -> str:
    """Extract the LAST word from a player name + normalize. 'Ousmane
    Dembélé' → 'dembele', 'O. Dembele' → 'dembele'. This is the most
    stable identifier across Sportmonks' inconsistent display formats
    ('Ousmane Dembélé' / 'O. Dembele' / 'Dembele' all collapse the same).
    """
    if not s:
        return ""
    # Strip trailing dots/commas, split on whitespace, take last word
    parts = s.strip().rstrip(".").split()
    last = parts[-1] if parts else s
    return _norm_player_name(last)


def _player_name_match(target: str, candidate: str) -> bool:
    """Decide whether `candidate` refers to the same player as `target`.

    Order of evidence (strongest first):
      1. Last-name token match (most stable — survives 'O. Dembele'
         vs 'Ousmane Dembélé')
      2. Whole normalized name substring either direction (handles
         single-name players like 'Vinícius' or compound names)
    """
    t_full = _norm_player_name(target)
    c_full = _norm_player_name(candidate)
    if not t_full or not c_full:
        return False
    # 1. Last-name token
    t_last = _last_name_token(target)
    c_last = _last_name_token(candidate)
    if t_last and c_last and t_last == c_last:
        return True
    # 2. Full-name substring either direction
    if t_full == c_full or t_full in c_full or c_full in t_full:
        return True
    return False


def _extract_player_from_bet_label(bet_label: Optional[str]) -> Optional[str]:
    """Extract the player name from labels like 'Ousmane Dembélé to score
    anytime' or 'Bukayo Saka anytime'.  Strips the standard suffixes so
    we end with just the player's display name."""
    if not bet_label:
        return None
    cleaned = bet_label
    for sfx in (
        " to score anytime", " anytime scorer", " anytime",
        " to score 2 or more", " 2+ goals", " 2 or more goals",
        " first scorer", " to score first",
        " to record an assist", " anytime assist",
    ):
        if cleaned.lower().endswith(sfx.lower()):
            cleaned = cleaned[: -len(sfx)]
            break
    return cleaned.strip()


def _resolve_outcome(
    market: str,
    side: str,
    hs: int,
    as_: int,
    *,
    goal_scorers: Optional[List[str]] = None,
    bet_label: Optional[str] = None,
) -> Optional[str]:
    """Return 'won' / 'lost' / 'push' for a given market+side and final
    score. None means we don't know how to grade this market yet.

    For player-prop markets, ``goal_scorers`` is a list of player names
    who scored in the match (any goal type), and ``bet_label`` is the
    persisted bet_label so we can extract the target player name."""
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
    # ── Player props ──────────────────────────────────────────────
    if m == "anytime_scorer":
        # Need the bet label to know WHO; need the scorer list to know IF.
        # Without either we can't grade — leave open so a later run with
        # better data can settle.
        if not bet_label or goal_scorers is None:
            return None
        target = _extract_player_from_bet_label(bet_label)
        if not target:
            return None
        hit = any(_player_name_match(target, sc) for sc in goal_scorers)
        # anytime_scorer is a YES-side market — we only price the
        # "player to score" outcome, so a hit means won.
        return ("won" if hit else "lost") if s == "yes" else ("lost" if hit else "won")
    if m == "first_scorer":
        # Same logic but ONLY the FIRST entry in goal_scorers wins.
        if not bet_label or not goal_scorers:
            return None
        target = _extract_player_from_bet_label(bet_label)
        if not target:
            return None
        hit = _player_name_match(target, goal_scorers[0])
        return ("won" if hit else "lost") if s == "yes" else ("lost" if hit else "won")
    if m == "to_score_2_or_more":
        if not bet_label or goal_scorers is None:
            return None
        target = _extract_player_from_bet_label(bet_label)
        if not target:
            return None
        hits = sum(1 for sc in goal_scorers if _player_name_match(target, sc))
        won = hits >= 2
        return ("won" if won else "lost") if s == "yes" else ("lost" if won else "won")
    return None


def summary_stats(
    path: Optional[Path] = None,
    *,
    model_version: Optional[str] = _CURRENT_MODEL_VERSION,
) -> Dict[str, Any]:
    """Aggregate stats across approved picks — graded + open.

    Defaults to the current model version so the displayed track record
    never includes the legacy v1 backfill cohort (whose −25.8% ROI was
    misleading subscribers). Pass ``model_version=None`` to include every
    version, or ``"v1_pre_m21"`` to inspect the backfill cohort.

    The returned dict echoes which cohort was measured under
    ``model_version`` so the UI can label the number honestly
    ("current model · 0 graded picks" vs "all-time · 18 graded picks").
    """
    init_table(path)
    conn = _get_db(path)
    try:
        if model_version is None:
            rows = conn.execute(
                "SELECT * FROM soccer_approved_picks"
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM soccer_approved_picks WHERE model_version = ?",
                (model_version,),
            ).fetchall()
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
        "model_version": model_version,  # None = all-time
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
