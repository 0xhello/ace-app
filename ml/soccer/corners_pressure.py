"""
ml/soccer/corners_pressure.py  —  R1, Phase 1 of docs/MODEL_R&D_ROADMAP.md

Tests the core R&D thesis: do pressure-driven features (shots, crosses,
dangerous attacks, possession, game script) predict a match's corner total
well enough to BEAT the Sportmonks closing corners line — where the current
rolling-rate model loses (-4.5%, SOCCER_MODEL_BACKTEST_V2)?

Everything runs inside the Sportmonks universe keyed on fixture_id:
  soccer_hist_team_stats    per-team pressure stats   (rolling features + target context)
  soccer_hist_fixtures      date + teams + corners_total
  soccer_hist_closing_odds  corners_over_under (grade) + fulltime_result (game script)

Leakage discipline (non-negotiable):
  - Every feature for fixture M is a rolling average over each team's matches
    STRICTLY BEFORE M's kickoff date.
  - Chronological 60/20/20 split. Light config tuning on validation only;
    ROI reported on the never-tuned newest-20% test set.
  - Graded vs the CLOSING consensus price (de-vigged) — the hard benchmark.
  - Identical grading convention to backtest_v2.run_corners_backtest, and we
    run the rolling-rate baseline on the SAME test fixtures for an honest A/B:
    isolates "do pressure features beat raw corner rates?".

Run:
    python3 -m ml.soccer.corners_pressure run
"""
from __future__ import annotations

import json
import math
import sqlite3
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from ml.soccer import sportmonks_historical as H

# ── config ─────────────────────────────────────────────────────────────────
WINDOW = 10                 # rolling lookback (matches)
MIN_MATCHES = 5             # min prior matches required per team
TRAIN_FRAC = 0.60
VAL_FRAC = 0.20
MIN_EDGE_PP = 3.0           # edge floor to enter the bet pool
MAX_EDGE_PP = 15.0          # ceiling — above this is a data artifact, not edge
MIN_BOOKS = 3               # liquidity floor on a corners line
EDGE_THRESHOLDS = (3.0, 5.0, 7.0)
ARTIFACT_PATH = Path(__file__).parent / "artifacts" / "corners_pressure.json"

# Pressure stats we roll into team profiles (column names in soccer_hist_team_stats)
_STATS = ["shots_total", "shots_on_target", "shots_insidebox", "total_crosses",
          "accurate_crosses", "dangerous_attacks", "attacks", "possession",
          "key_passes", "corners"]


# ── data loading ────────────────────────────────────────────────────────────
def _load(conn: sqlite3.Connection):
    """Return (fixtures, team_history, corners_odds, game_script).

    fixtures: list of dicts {fixture_id, date, home_id, away_id, corners_total}
              sorted by date, only those with stats for BOTH teams + a target.
    team_history: team_id -> sorted list of {date, own:{stat..}, opp_corners}
    """
    # per-fixture stats keyed by location
    stat_cols = ",".join(_STATS)
    rows = conn.execute(
        f"SELECT fixture_id, location, team_id, {stat_cols} "
        f"FROM soccer_hist_team_stats").fetchall()
    by_fix: Dict[int, Dict[str, Dict[str, Any]]] = defaultdict(dict)
    for r in rows:
        fid, loc, team_id = r[0], r[1], r[2]
        d = {_STATS[i]: r[3 + i] for i in range(len(_STATS))}
        d["team_id"] = team_id
        by_fix[fid][loc] = d

    # fixture meta
    meta = {r[0]: {"date": r[1], "home_id": r[2], "away_id": r[3],
                   "corners_total": r[4]}
            for r in conn.execute(
                "SELECT fixture_id, starting_at, home_team_id, away_team_id, "
                "corners_total FROM soccer_hist_fixtures "
                "WHERE home_score IS NOT NULL").fetchall()}

    # build per-team chronological history (own stats + opponent corners)
    team_hist: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
    fixtures: List[Dict[str, Any]] = []
    for fid, locs in by_fix.items():
        if "home" not in locs or "away" not in locs:
            continue
        m = meta.get(fid)
        if not m or not m["date"]:
            continue
        date = m["date"]
        home, away = locs["home"], locs["away"]
        # record each team's match for rolling features
        for own, opp in ((home, away), (away, home)):
            opp_corners = opp.get("corners")
            team_hist[own["team_id"]].append(
                {"date": date, "own": own, "opp_corners": opp_corners})
        # actual total corners for the target (prefer stats sum, fall back to meta)
        hc, ac = home.get("corners"), away.get("corners")
        if hc is not None and ac is not None:
            total = int(hc) + int(ac)
        elif m["corners_total"] is not None:
            total = int(m["corners_total"])
        else:
            continue
        fixtures.append({"fixture_id": fid, "date": date,
                         "home_id": m["home_id"], "away_id": m["away_id"],
                         "corners_total": total})

    for tid in team_hist:
        team_hist[tid].sort(key=lambda e: e["date"])
    fixtures.sort(key=lambda f: f["date"])

    # corners odds: fixture -> {line: {"Over": dec, "Under": dec}}
    odds: Dict[int, Dict[float, Dict[str, float]]] = defaultdict(lambda: defaultdict(dict))
    for r in conn.execute(
            "SELECT fixture_id, line, selection, closing_decimal, n_books "
            "FROM soccer_hist_closing_odds WHERE market_name='corners_over_under' "
            "AND closing_decimal IS NOT NULL").fetchall():
        fid, line, sel, dec, nb = r
        if line is None or dec is None or (nb or 0) < MIN_BOOKS:
            continue
        odds[fid][float(line)][sel] = float(dec)

    # game script: fixture -> (p_home, p_away) from de-vigged 1X2 close
    gs_raw: Dict[int, Dict[str, float]] = defaultdict(dict)
    for r in conn.execute(
            "SELECT fixture_id, selection, closing_decimal FROM soccer_hist_closing_odds "
            "WHERE market_name='fulltime_result' AND closing_decimal IS NOT NULL").fetchall():
        gs_raw[r[0]][r[1]] = float(r[2])
    game_script: Dict[int, Tuple[float, float]] = {}
    for fid, sels in gs_raw.items():
        h, d, a = sels.get("Home"), sels.get("Draw"), sels.get("Away")
        if not (h and d and a):
            continue
        rh, rd, ra = 1 / h, 1 / d, 1 / a
        s = rh + rd + ra
        if s > 0:
            game_script[fid] = (rh / s, ra / s)

    return fixtures, team_hist, odds, game_script


def _rolling(hist: List[Dict[str, Any]], before_date: str) -> Optional[Dict[str, float]]:
    """Average of a team's last WINDOW matches strictly before before_date."""
    prior = [e for e in hist if e["date"] < before_date]
    if len(prior) < MIN_MATCHES:
        return None
    recent = prior[-WINDOW:]
    out: Dict[str, float] = {}
    for stat in _STATS:
        vals = [e["own"].get(stat) for e in recent if e["own"].get(stat) is not None]
        out[stat] = sum(vals) / len(vals) if vals else float("nan")
    ca = [e["opp_corners"] for e in recent if e["opp_corners"] is not None]
    out["corners_against"] = sum(ca) / len(ca) if ca else float("nan")
    return out


def build_dataset(conn: sqlite3.Connection):
    """Return (X feature rows, y targets, meta rows) — leakage-free, time-ordered."""
    fixtures, team_hist, odds, game_script = _load(conn)
    X: List[List[float]] = []
    y: List[float] = []
    rows: List[Dict[str, Any]] = []
    feat_names: List[str] = []
    for f in fixtures:
        fid = f["fixture_id"]
        if fid not in odds:                       # no grading target → skip
            continue
        hf = _rolling(team_hist.get(f["home_id"], []), f["date"])
        af = _rolling(team_hist.get(f["away_id"], []), f["date"])
        if hf is None or af is None:
            continue
        p_home, p_away = game_script.get(fid, (float("nan"), float("nan")))

        exp_home_c = (hf["corners"] + af["corners_against"]) / 2.0
        exp_away_c = (af["corners"] + hf["corners_against"]) / 2.0
        roll_lambda = exp_home_c + exp_away_c     # the baseline rolling-rate model

        feat = {
            **{f"h_{k}": hf[k] for k in hf},
            **{f"a_{k}": af[k] for k in af},
            "exp_home_corners": exp_home_c,
            "exp_away_corners": exp_away_c,
            "roll_lambda": roll_lambda,
            "tot_shots": hf["shots_total"] + af["shots_total"],
            "tot_crosses": hf["total_crosses"] + af["total_crosses"],
            "tot_dang_att": hf["dangerous_attacks"] + af["dangerous_attacks"],
            "p_home": p_home,
            "p_away": p_away,
            "mismatch": abs(p_home - p_away),
            "p_decisive": p_home + p_away,
        }
        if not feat_names:
            feat_names = list(feat.keys())
        X.append([feat[k] for k in feat_names])
        y.append(float(f["corners_total"]))
        rows.append({"fixture_id": fid, "date": f["date"],
                     "actual": f["corners_total"], "roll_lambda": roll_lambda,
                     "odds": odds[fid]})
    return X, y, rows, feat_names


# ── grading (mirrors backtest_v2.run_corners_backtest) ──────────────────────
def _poisson_at_least(lam: float, k: int) -> float:
    if k <= 0:
        return 1.0
    if lam <= 0:
        return 0.0
    cdf = math.exp(-lam)
    term = cdf
    for i in range(1, k):
        term *= lam / i
        cdf += term
    return max(0.0, min(1.0, 1.0 - cdf))


def _grade(rows: List[Dict[str, Any]], lambdas: List[float]) -> List[Dict[str, Any]]:
    """Produce the bet pool for a given list of per-fixture lambdas."""
    bets: List[Dict[str, Any]] = []
    for row, lam in zip(rows, lambdas):
        if lam is None or lam <= 0:
            continue
        actual = row["actual"]
        for line, sides in row["odds"].items():
            if "Over" not in sides or "Under" not in sides:
                continue
            # only clean half/whole lines — skip Asian quarter lines (.25/.75)
            if abs(line * 2 - round(line * 2)) > 1e-9:
                continue
            over_dec, under_dec = sides["Over"], sides["Under"]
            if over_dec <= 1.0 or under_dec <= 1.0:
                continue
            thr = int(line) + 1
            p_over = _poisson_at_least(lam, thr)
            p_under = 1.0 - p_over
            raw_o, raw_u = 1.0 / over_dec, 1.0 / under_dec
            s = raw_o + raw_u
            cons_over, cons_under = (raw_o / s, raw_u / s) if s > 0 else (0.5, 0.5)
            is_whole = abs(line - round(line)) < 1e-9
            for side, p_model, cons, dec in (
                ("over", p_over, cons_over, over_dec),
                ("under", p_under, cons_under, under_dec),
            ):
                edge = (p_model - cons) * 100.0
                if edge < MIN_EDGE_PP or edge > MAX_EDGE_PP:
                    continue
                if is_whole and actual == int(line):
                    continue                            # push — stake returned
                won = (actual > line) if side == "over" else (actual < line)
                profit = (dec - 1.0) if won else -1.0
                bets.append({"edge_pp": edge, "won": won, "profit": profit})
    return bets


def _roi_table(bets: List[Dict[str, Any]]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for thr in EDGE_THRESHOLDS:
        sel = [b for b in bets if b["edge_pp"] >= thr]
        if not sel:
            out[f"{int(thr)}pp"] = {"n_bets": 0, "roi": None}
            continue
        wins = sum(1 for b in sel if b["won"])
        ret = sum(b["profit"] for b in sel)
        out[f"{int(thr)}pp"] = {"n_bets": len(sel), "win_rate": round(wins / len(sel), 4),
                                "roi": round(ret / len(sel), 4), "units": round(ret, 2)}
    return out


# ── model ───────────────────────────────────────────────────────────────────
def _fit_predict(Xtr, ytr, Xval, yval, Xte, cfg) -> List[float]:
    from sklearn.ensemble import HistGradientBoostingRegressor
    import numpy as np
    model = HistGradientBoostingRegressor(loss="poisson", **cfg, random_state=42)
    Xfit = np.array(Xtr + Xval, dtype=float)
    yfit = np.array(ytr + yval, dtype=float)
    model.fit(Xfit, yfit)
    return [max(0.1, float(p)) for p in model.predict(np.array(Xte, dtype=float))]


def _val_select(Xtr, ytr, Xval, yval) -> Dict[str, Any]:
    """Pick a config by validation Poisson deviance (no test contact)."""
    from sklearn.ensemble import HistGradientBoostingRegressor
    from sklearn.metrics import mean_poisson_deviance
    import numpy as np
    Xtr_a, ytr_a = np.array(Xtr, dtype=float), np.array(ytr, dtype=float)
    Xval_a, yval_a = np.array(Xval, dtype=float), np.array(yval, dtype=float)
    grid = [
        {"max_iter": m, "learning_rate": lr, "max_leaf_nodes": ml,
         "min_samples_leaf": 40, "l2_regularization": 1.0}
        for m in (150, 300) for lr in (0.05, 0.08) for ml in (15, 31)
    ]
    best, best_dev = None, float("inf")
    for cfg in grid:
        model = HistGradientBoostingRegressor(loss="poisson", random_state=42, **cfg)
        model.fit(Xtr_a, ytr_a)
        pred = np.clip(model.predict(Xval_a), 0.1, None)
        dev = mean_poisson_deviance(yval_a, pred)
        if dev < best_dev:
            best_dev, best = dev, cfg
    return {"cfg": best, "val_deviance": round(best_dev, 5)}


def run(path: Optional[Path] = None) -> Dict[str, Any]:
    conn = H._db(path)
    try:
        X, y, rows, feat_names = build_dataset(conn)
    finally:
        conn.close()
    n = len(X)
    if n < 200:
        return {"error": f"insufficient dataset ({n} fixtures with features+odds). "
                         "Wait for the stats backfill to finish."}
    i_tr = int(n * TRAIN_FRAC)
    i_val = int(n * (TRAIN_FRAC + VAL_FRAC))
    Xtr, ytr = X[:i_tr], y[:i_tr]
    Xval, yval = X[i_tr:i_val], y[i_tr:i_val]
    Xte = X[i_val:]
    rows_te = rows[i_val:]

    sel = _val_select(Xtr, ytr, Xval, yval)
    lam_pressure = _fit_predict(Xtr, ytr, Xval, yval, Xte, sel["cfg"])
    lam_roll = [r["roll_lambda"] for r in rows_te]

    pressure_bets = _grade(rows_te, lam_pressure)
    roll_bets = _grade(rows_te, lam_roll)

    pressure_roi = _roi_table(pressure_bets)
    roll_roi = _roi_table(roll_bets)

    v = pressure_roi.get("5pp", {})
    roi3 = (pressure_roi.get("3pp") or {}).get("roi")
    lower_ok = roi3 is None or roi3 >= -0.01
    proven = (v.get("n_bets", 0) >= 30 and v.get("roi") is not None
              and v["roi"] > 0 and lower_ok)

    result = {
        "market": "corners (pressure model)",
        "generated": datetime.utcnow().isoformat(),
        "dataset": {"total_fixtures": n, "train": i_tr, "val": i_val - i_tr,
                    "test": n - i_val, "features": feat_names},
        "model": {"type": "HistGradientBoostingRegressor(loss=poisson)", **sel},
        "pressure_model": {"by_edge": pressure_roi, "pool": len(pressure_bets)},
        "rolling_baseline": {"by_edge": roll_roi, "pool": len(roll_bets)},
        "verdict": "PROVEN" if proven else "EXPERIMENTAL",
    }
    ARTIFACT_PATH.parent.mkdir(parents=True, exist_ok=True)
    ARTIFACT_PATH.write_text(json.dumps(result, indent=2))
    return result


def _print(res: Dict[str, Any]) -> None:
    if "error" in res:
        print("ERROR:", res["error"]); return
    print("\n" + "=" * 72)
    print("  CORNERS PRESSURE MODEL — leakage-free backtest (R1, Phase 1)")
    print("=" * 72)
    d = res["dataset"]
    print(f"  fixtures: {d['total_fixtures']}  (train {d['train']} / val {d['val']} / test {d['test']})")
    print(f"  model: {res['model']['type']}")
    print(f"  picked cfg: {res['model']['cfg']}  (val deviance {res['model']['val_deviance']})")
    print(f"\n  {'edge':>6} | {'PRESSURE model':^28} | {'ROLLING baseline':^28}")
    print(f"  {'':>6} | {'bets':>6} {'win%':>6} {'ROI':>8}  | {'bets':>6} {'win%':>6} {'ROI':>8}")
    print("  " + "-" * 70)
    for thr in ("3pp", "5pp", "7pp"):
        p = res["pressure_model"]["by_edge"].get(thr, {})
        r = res["rolling_baseline"]["by_edge"].get(thr, {})
        def fmt(x):
            n = x.get("n_bets", 0)
            wr = x.get("win_rate"); roi = x.get("roi")
            wr_s = f"{wr*100:5.1f}%" if wr is not None else "   -- "
            roi_s = f"{roi*100:+6.2f}%" if roi is not None else "   --  "
            return f"{n:>6} {wr_s:>6} {roi_s:>8}"
        print(f"  {thr:>6} | {fmt(p)}  | {fmt(r)}")
    print("  " + "-" * 70)
    print(f"  VERDICT: {res['verdict']}")
    print("=" * 72 + "\n")


if __name__ == "__main__":
    import sys
    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"
    if cmd == "run":
        _print(run())
    elif cmd == "report":
        _print(json.loads(ARTIFACT_PATH.read_text()))
    else:
        print("usage: python3 -m ml.soccer.corners_pressure [run|report]")
