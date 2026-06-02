#!/usr/bin/env python3
"""backtest_v2.py — leakage-free 3-way-split backtest (M40.2).

Why this exists
===============
The 2026-05-29 leakage audit (docs/SOCCER_LEAKAGE_AUDIT_2026-05-29.md)
found that the V1 backtest's headline ROIs were over-fit: the shrinkage
factors and the M21 hyperparameters were tuned by inspecting the SAME
holdout they were reported on. That's concept-level leakage — the
reported numbers are optimistic.

V2 fixes it with a proper three-way chronological split:

    train (oldest 60%)  →  fit Dixon-Coles
    validation (20%)    →  tune the calibration shrinkage (by log-loss)
    test (newest 20%)   →  report ROI — never touched during tuning

The shrinkage transform is applied IN THIS HARNESS (not inside
predict_match), so we can grid-search it on validation without
contaminating the model. The model only ever hands us RAW probabilities
(apply_shrinkage=False).

Final-fit protocol: once the shrinkage factor is chosen on validation,
we refit Dixon-Coles on train+val and evaluate the held-out test with
that fit. Standard practice — validation data is fair game for the
final model once hyperparameters are locked; the test set still never
informs any choice.

Markets covered here: 1X2 (moneyline) + Totals 2.5. These are the two
markets with closing odds in soccer_team_form (football-data.co.uk).
BTTS / corners / anytime-scorer get their own harness once the M48
Sportmonks historical odds finish loading (they carry the closing
prices football-data didn't).

Verdict per market:
    PROVEN       — test ROI > 0 at the chosen edge threshold,
                   with >= MIN_TEST_BETS bets (meaningful sample)
    EXPERIMENTAL — everything else (calibrated but no proven edge)

This file produces no module-level side effects; run via CLI.
"""
from __future__ import annotations

import json
import math
import sqlite3
import sys
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from ml.soccer.model import (
    DCFit, LEAGUES_TO_FIT, get_db,
    fit_dixon_coles, predict_match, MODEL_DIR, _logit_shrink,
)
from ml.soccer.hist_join import HistJoiner


# ── Settings ─────────────────────────────────────────────────────────────────

TRAIN_FRAC = 0.60
VAL_FRAC   = 0.20
# test = remaining 20%

# Shrinkage grid searched on validation. 1.0 = no shrink (raw model).
# < 1.0 pulls toward 0.5 (the v1 model is over-confident on favorites).
SHRINK_GRID = [1.00, 0.92, 0.85, 0.78, 0.72, 0.65, 0.58, 0.50]

EDGE_THRESHOLDS = [0.03, 0.05, 0.07]
MIN_TEST_BETS = 30           # below this, a market can't earn "Proven"
PROVEN_ROI_BAR = 0.0         # test ROI must beat break-even vs the close

# Verdict edge threshold — the one we judge "Proven" on.
VERDICT_EDGE = 0.05


# ── Data structures ──────────────────────────────────────────────────────────

@dataclass
class MarketRow:
    """One (fixture × market-selection) evaluation row."""
    league:    str
    date:      str
    group:     str          # "1x2" | "totals"
    selection: str          # h2h_home/draw/away | over_2.5 | under_2.5
    raw_prob:  float        # model probability BEFORE shrinkage
    book_prob: float        # de-vigged closing prob
    book_odds: float        # decimal closing odds
    outcome:   int          # 1 win, 0 lose


# ── Odds helpers ─────────────────────────────────────────────────────────────

def _devig3(oh: float, od: float, oa: float) -> Optional[Tuple[float, float, float]]:
    if not all([oh, od, oa]):
        return None
    raw = [1.0 / oh, 1.0 / od, 1.0 / oa]
    s = sum(raw)
    return (raw[0] / s, raw[1] / s, raw[2] / s) if s > 0 else None


def _devig2(oo: float, ou: float) -> Optional[Tuple[float, float]]:
    if not all([oo, ou]):
        return None
    raw = [1.0 / oo, 1.0 / ou]
    s = sum(raw)
    return (raw[0] / s, raw[1] / s) if s > 0 else None


def _safe_log(p: float) -> float:
    return math.log(max(p, 1e-12))


# ── Split ────────────────────────────────────────────────────────────────────

def _league_matches(league: str, conn: sqlite3.Connection) -> List[Dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT match_date, team_name AS home, opponent AS away,
               goals_for AS gh, goals_against AS ga,
               close_home_odds, close_draw_odds, close_away_odds,
               close_over_odds, close_under_odds, referee
          FROM soccer_team_form
         WHERE league = ? AND venue = 'home'
               AND goals_for IS NOT NULL AND goals_against IS NOT NULL
         ORDER BY match_date ASC
        """,
        (league,),
    ).fetchall()
    return [dict(r) for r in rows]


def _three_way_split(matches: List[Dict[str, Any]]):
    n = len(matches)
    i_train = int(n * TRAIN_FRAC)
    i_val   = int(n * (TRAIN_FRAC + VAL_FRAC))
    train, val, test = matches[:i_train], matches[i_train:i_val], matches[i_val:]
    val_start  = val[0]["match_date"]  if val  else None
    test_start = test[0]["match_date"] if test else None
    return train, val, test, val_start, test_start


# ── Prediction → market rows ─────────────────────────────────────────────────

def _rows_for_match(league: str, fit: DCFit, conn: sqlite3.Connection,
                    m: Dict[str, Any],
                    joiner: Optional[HistJoiner] = None) -> List[MarketRow]:
    """Raw (un-shrunk) model probabilities for one match, paired with the
    closing odds + realized outcome. 1X2 + totals use football-data odds;
    BTTS uses Sportmonks closing odds via the joiner (M48)."""
    pred = predict_match(
        fit, m["home"], m["away"], league=league, referee=m.get("referee"),
        apply_adjustments=True, apply_shrinkage=False,  # RAW probs only
        conn=conn, before_date=m["match_date"],
    )
    if pred is None:
        return []
    gh, ga = int(m["gh"]), int(m["ga"])
    out: List[MarketRow] = []

    book3 = _devig3(m["close_home_odds"], m["close_draw_odds"], m["close_away_odds"])
    if book3:
        for sel, p, bp, bo, win in [
            ("h2h_home", pred["p_home"], book3[0], m["close_home_odds"], 1 if gh > ga else 0),
            ("h2h_draw", pred["p_draw"], book3[1], m["close_draw_odds"], 1 if gh == ga else 0),
            ("h2h_away", pred["p_away"], book3[2], m["close_away_odds"], 1 if gh < ga else 0),
        ]:
            out.append(MarketRow(league, m["match_date"], "1x2", sel,
                                 float(p), float(bp), float(bo), win))

    book2 = _devig2(m["close_over_odds"], m["close_under_odds"])
    if book2:
        total = gh + ga
        for sel, p, bp, bo, win in [
            ("over_2.5",  pred["over_2.5"],  book2[0], m["close_over_odds"],  1 if total > 2.5 else 0),
            ("under_2.5", pred["under_2.5"], book2[1], m["close_under_odds"], 1 if total < 2.5 else 0),
        ]:
            out.append(MarketRow(league, m["match_date"], "totals", sel,
                                 float(p), float(bp), float(bo), win))

    # ── BTTS — model prob from predict_match, benchmark from Sportmonks ──
    if joiner is not None:
        btts = joiner.btts_odds(m["match_date"], m["home"], m["away"])
        if btts:
            yes_dec, no_dec = btts
            book_btts = _devig2(yes_dec, no_dec)
            if book_btts:
                both_scored = 1 if (gh >= 1 and ga >= 1) else 0
                for sel, p, bp, bo, win in [
                    ("btts_yes", pred["btts_yes"], book_btts[0], yes_dec, both_scored),
                    ("btts_no",  pred["btts_no"],  book_btts[1], no_dec,  1 - both_scored),
                ]:
                    out.append(MarketRow(league, m["match_date"], "btts", sel,
                                         float(p), float(bp), float(bo), win))
    return out


def _collect_rows(league: str, fit: DCFit, conn: sqlite3.Connection,
                  matches: List[Dict[str, Any]],
                  joiner: Optional[HistJoiner] = None) -> List[MarketRow]:
    rows: List[MarketRow] = []
    for m in matches:
        rows.extend(_rows_for_match(league, fit, conn, m, joiner))
    return rows


# ── Shrinkage application (in-harness, tunable) ─────────────────────────────

def _apply_shrink_group(rows: List[MarketRow], group: str, factor: float) -> Dict[int, float]:
    """Return {id(row): shrunk_prob} for one market group, renormalized so a
    fixture's selections sum to 1 (1X2: 3-way, totals: 2-way)."""
    # group rows by (date, league) — a single fixture's selections
    out: Dict[int, float] = {}
    by_fixture: Dict[Tuple[str, str], List[MarketRow]] = {}
    for r in rows:
        if r.group != group:
            continue
        by_fixture.setdefault((r.league, r.date), []).append(r)
    for _key, sel_rows in by_fixture.items():
        shrunk = [(_logit_shrink(r.raw_prob, factor), r) for r in sel_rows]
        s = sum(p for p, _ in shrunk)
        for p, r in shrunk:
            out[id(r)] = (p / s) if s > 0 else r.raw_prob
    return out


def _logloss_for(rows: List[MarketRow], group: str, factor: float) -> float:
    shrunk = _apply_shrink_group(rows, group, factor)
    total, n = 0.0, 0
    for r in rows:
        if r.group != group:
            continue
        p = shrunk.get(id(r), r.raw_prob)
        total += -_safe_log(p if r.outcome == 1 else (1.0 - p))
        n += 1
    return total / n if n else 0.0


def _roi_for(rows: List[MarketRow], group: str, factor: float,
             edge_thr: float) -> Dict[str, Any]:
    shrunk = _apply_shrink_group(rows, group, factor)
    bets = []
    for r in rows:
        if r.group != group:
            continue
        p = shrunk.get(id(r), r.raw_prob)
        edge = p - r.book_prob
        if edge >= edge_thr:
            bets.append(r)
    if not bets:
        return {"n_bets": 0, "roi": None, "wins": 0, "win_rate": None}
    wins = sum(1 for r in bets if r.outcome == 1)
    ret = sum((r.book_odds - 1.0) for r in bets if r.outcome == 1) - sum(1 for r in bets if r.outcome == 0)
    return {
        "n_bets": len(bets),
        "wins": wins,
        "win_rate": round(wins / len(bets), 4),
        "roi": round(ret / len(bets), 4),
        "units": round(ret, 2),
    }


# ── Orchestration ────────────────────────────────────────────────────────────

def run_backtest_v2(leagues: Optional[List[str]] = None) -> Dict[str, Any]:
    leagues = leagues or LEAGUES_TO_FIT
    conn = get_db()

    # Sportmonks historical odds join (M48) — adds BTTS (and later corners /
    # anytime) closing prices that football-data never carried.
    try:
        joiner: Optional[HistJoiner] = HistJoiner(conn)
    except Exception:
        joiner = None

    val_rows_all: List[MarketRow] = []
    test_rows_all: List[MarketRow] = []
    per_league_meta: Dict[str, Any] = {}

    for league in leagues:
        matches = _league_matches(league, conn)
        if len(matches) < 200:
            per_league_meta[league] = {"skipped": f"only {len(matches)} matches"}
            continue
        train, val, test, val_start, test_start = _three_way_split(matches)
        per_league_meta[league] = {
            "n": len(matches), "train": len(train),
            "val": len(val), "test": len(test),
            "val_start": val_start, "test_start": test_start,
        }

        # Pass A — fit on TRAIN only, predict VALIDATION (for tuning)
        fit_train = fit_dixon_coles(league, conn,
                                    reference_date=val_start, train_before=val_start)
        if fit_train is None:
            per_league_meta[league]["skipped"] = "train fit failed"
            continue
        val_rows_all.extend(_collect_rows(league, fit_train, conn, val, joiner))

        # Pass B — fit on TRAIN+VAL, predict TEST (for the verdict)
        fit_trainval = fit_dixon_coles(league, conn,
                                       reference_date=test_start, train_before=test_start)
        if fit_trainval is None:
            per_league_meta[league]["skipped_test"] = "train+val fit failed"
            continue
        test_rows_all.extend(_collect_rows(league, fit_trainval, conn, test, joiner))

    conn.close()

    # ── Tune shrinkage per market group on pooled VALIDATION (by log-loss) ──
    tuned: Dict[str, Dict[str, Any]] = {}
    for group in ("1x2", "totals", "btts"):
        best_factor, best_ll = 1.0, float("inf")
        sweep = []
        for f in SHRINK_GRID:
            ll = _logloss_for(val_rows_all, group, f)
            sweep.append({"factor": f, "val_logloss": round(ll, 4)})
            if ll < best_ll:
                best_ll, best_factor = ll, f
        tuned[group] = {"best_factor": best_factor,
                        "val_logloss": round(best_ll, 4),
                        "sweep": sweep}

    # ── Report on held-out TEST with the validation-selected factor ──
    # Verdicts are PER SELECTION, not per market-group: "Over 2.5" and
    # "Under 2.5" share a shrink factor but are opposite bets — one can be
    # Proven while the other is a clear avoid. The product only ever bets
    # one side, so that's the granularity that matters.
    markets_report: Dict[str, Any] = {}
    for group in ("1x2", "totals", "btts"):
        factor = tuned[group]["best_factor"]
        shrunk = _apply_shrink_group(test_rows_all, group, factor)
        sels = sorted({r.selection for r in test_rows_all if r.group == group})
        for sel in sels:
            sel_rows = [r for r in test_rows_all if r.selection == sel]
            by_edge: Dict[str, Any] = {}
            for t in EDGE_THRESHOLDS:
                bets = [r for r in sel_rows if (shrunk.get(id(r), r.raw_prob) - r.book_prob) >= t]
                if bets:
                    wins = sum(1 for r in bets if r.outcome == 1)
                    ret = sum((r.book_odds - 1.0) for r in bets if r.outcome == 1) - sum(1 for r in bets if r.outcome == 0)
                    by_edge[f"{int(t*100)}pp"] = {
                        "n_bets": len(bets), "wins": wins,
                        "win_rate": round(wins/len(bets), 4),
                        "roi": round(ret/len(bets), 4), "units": round(ret, 2),
                    }
                else:
                    by_edge[f"{int(t*100)}pp"] = {"n_bets": 0, "roi": None}

            verdict_roi = by_edge[f"{int(VERDICT_EDGE*100)}pp"]
            n_bets = verdict_roi.get("n_bets", 0)
            roi = verdict_roi.get("roi")
            if n_bets >= MIN_TEST_BETS and roi is not None and roi > PROVEN_ROI_BAR:
                verdict = "PROVEN"
                # honest sample-size caveat
                sample_note = "robust" if n_bets >= 60 else "small sample"
            else:
                verdict = "EXPERIMENTAL"
                sample_note = ("losing on test" if (roi is not None and roi <= 0)
                               else "too few test bets" if n_bets < MIN_TEST_BETS
                               else "n/a")
            markets_report[sel] = {
                "group": group,
                "shrink_factor": factor,
                "by_edge": by_edge,
                "verdict": verdict,
                "sample_note": sample_note,
            }

    summary = {
        "ran_at": datetime.now(timezone.utc).isoformat(),
        "method": "3-way chronological split (60/20/20); shrink tuned on val by log-loss; ROI reported on held-out test",
        "split": {"train": TRAIN_FRAC, "val": VAL_FRAC, "test": round(1 - TRAIN_FRAC - VAL_FRAC, 2)},
        "verdict_edge": VERDICT_EDGE,
        "min_test_bets": MIN_TEST_BETS,
        "per_league": per_league_meta,
        "tuned_shrinkage": tuned,
        "markets": markets_report,
        "pooled_counts": {
            "val_rows": len(val_rows_all),
            "test_rows": len(test_rows_all),
        },
    }

    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    out_path = MODEL_DIR / "backtest_v2.json"
    out_path.write_text(json.dumps(summary, indent=2))
    return summary


def _print_report(s: Dict[str, Any]) -> None:
    print("\n" + "=" * 74)
    print("BACKTEST V2 — leakage-free 3-way split")
    print("=" * 74)
    print(f"  {s['method']}")
    print(f"  pooled: {s['pooled_counts']['val_rows']} val rows, "
          f"{s['pooled_counts']['test_rows']} test rows")
    print()
    # Order: proven first, then by best 5pp ROI
    def _key(item):
        sel, rep = item
        v = rep["by_edge"].get("5pp", {})
        return (0 if rep["verdict"] == "PROVEN" else 1, -(v.get("roi") or -99))
    for sel, rep in sorted(s["markets"].items(), key=_key):
        verdict = rep["verdict"]
        badge = "✓ PROVEN" if verdict == "PROVEN" else "· experimental"
        print(f"  {sel:11s} shrink={rep['shrink_factor']:.2f}   [{badge} — {rep['sample_note']}]")
        for thr, roi in rep["by_edge"].items():
            if roi.get("n_bets"):
                print(f"      edge≥{thr:4s}: {roi['n_bets']:4d} bets  "
                      f"{roi['win_rate']*100:5.1f}% win  ROI {roi['roi']*100:+6.2f}%  ({roi['units']:+.1f}u)")
        print()


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"
    if cmd == "run":
        summary = run_backtest_v2()
        _print_report(summary)
        print(f"  Wrote {MODEL_DIR / 'backtest_v2.json'}")
    elif cmd == "report":
        p = MODEL_DIR / "backtest_v2.json"
        if p.exists():
            _print_report(json.loads(p.read_text()))
        else:
            print("No v2 backtest yet — run it first.", file=sys.stderr)
            sys.exit(1)
