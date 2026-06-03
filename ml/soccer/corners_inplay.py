"""
ml/soccer/corners_inplay.py  —  R1b, in-play corners signal test

Pre-match corner totals are near-random (corners_pressure.py: model corr 0.08
vs market 0.19). This tests a different hypothesis: maybe the edge is IN-PLAY.
Once you OBSERVE first-half pressure (shots, dangerous attacks, possession,
early corners, crosses), can you predict SECOND-HALF corners better than any
pre-match information allows?

It's the strongest available version of the user's "first 10-20 min" idea:
a full 45 minutes of observed pressure. If H1 can't predict H2 corners above
pre-match, finer slices can't either. If it can, that's the green light to
chase minute-level data + in-play odds.

HONEST SCOPE: we have pre-match closing odds, NOT historical in-play odds, so
this measures PREDICTIVE LIFT (is there signal?), not ROI. ROI vs a live line
is a separate future step that this result either justifies or kills.

Models compared (same HistGBR config, same train/test fixtures), target =
2nd-half total corners:
  NAIVE       constant mean
  PRE-MATCH   leakage-free pre-match rolling features (what the market knows)
  IN-PLAY     observed first-half pressure only
  BOTH        pre-match + first-half

Run:  python3 -m ml.soccer.corners_inplay run
"""
from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from ml.soccer import sportmonks_historical as H
from ml.soccer import corners_pressure as CP

ARTIFACT_PATH = Path(__file__).parent / "artifacts" / "corners_inplay.json"

# first-half stats we observe (columns in soccer_hist_period_stats)
_H1 = ["shots_total", "shots_on_target", "shots_insidebox", "total_crosses",
       "accurate_crosses", "dangerous_attacks", "attacks", "possession",
       "key_passes", "corners"]
_FIXED_CFG = {"max_iter": 300, "learning_rate": 0.05, "max_leaf_nodes": 31,
              "min_samples_leaf": 40, "l2_regularization": 1.0}


def build_inplay_dataset(conn):
    # 1) pre-match leakage-free features per fixture (reuse the corners model)
    X_pre, _y_full, rows_pre, pre_names = CP.build_dataset(conn)
    pre_by_fix: Dict[int, Tuple[List[float], str]] = {
        r["fixture_id"]: (x, r["date"]) for x, r in zip(X_pre, rows_pre)}

    # 2) per-half stats: fixture -> {(period, loc): {stat: val}}.
    #    NOTE: Sportmonks reports CUMULATIVE (full-match) values in the
    #    2nd-half period row for ~41% of fixtures, so we MUST NOT read the
    #    target from 2nd-half rows. 1st-half is the genuine first-period
    #    increment (nothing to accumulate). We derive true remaining corners
    #    as (reliable full-match total) - (H1 total). Verified: H1 mean 4.38,
    #    realistic; cumulative-2nd-half bug confirmed in the data audit.
    cols = ",".join(_H1)
    ps: Dict[int, Dict[Tuple[str, str], Dict[str, Any]]] = defaultdict(dict)
    for row in conn.execute(
            f"SELECT fixture_id, period, location, {cols} FROM soccer_hist_period_stats "
            f"WHERE period='1st-half'").fetchall():
        fid, period, loc = row[0], row[1], row[2]
        ps[fid][(period, loc)] = {_H1[i]: row[3 + i] for i in range(len(_H1))}

    # reliable full-match corners (aggregate full-match stats), for true H2 = full - H1
    full_corners = {r[0]: r[1] for r in conn.execute(
        "SELECT fixture_id, SUM(corners) FROM soccer_hist_team_stats GROUP BY fixture_id").fetchall()}

    pre_X, in_X, both_X, y, dates, h1c = [], [], [], [], [], []
    h1_names = ([f"h1_h_{k}" for k in _H1] + [f"h1_a_{k}" for k in _H1] +
                ["h1_total_corners", "h1_total_shots", "h1_total_sot",
                 "h1_total_dang", "h1_total_crosses"])

    for fid, (pre_vec, date) in pre_by_fix.items():
        p = ps.get(fid)
        if not p:
            continue
        try:
            h1h, h1a = p[("1st-half", "home")], p[("1st-half", "away")]
        except KeyError:
            continue
        if h1h.get("corners") is None or h1a.get("corners") is None:
            continue
        full_c = full_corners.get(fid)
        if full_c is None:
            continue
        h1_total_corners = float(h1h["corners"]) + float(h1a["corners"])
        target = float(full_c) - h1_total_corners      # TRUE 2nd-half (remaining) corners
        if target < 0 or target > 25:                  # drop data errors
            continue

        def g(d, k):
            v = d.get(k)
            return float(v) if v is not None else float("nan")

        h1_vec = [g(h1h, k) for k in _H1] + [g(h1a, k) for k in _H1]
        h1_vec += [
            h1_total_corners,
            g(h1h, "shots_total") + g(h1a, "shots_total"),
            g(h1h, "shots_on_target") + g(h1a, "shots_on_target"),
            g(h1h, "dangerous_attacks") + g(h1a, "dangerous_attacks"),
            g(h1h, "total_crosses") + g(h1a, "total_crosses"),
        ]
        pre_X.append(list(pre_vec))
        in_X.append(h1_vec)
        both_X.append(list(pre_vec) + h1_vec)
        y.append(target)
        dates.append(date)
        h1c.append(h1_total_corners)

    order = sorted(range(len(y)), key=lambda i: dates[i])
    pre_X = [pre_X[i] for i in order]
    in_X = [in_X[i] for i in order]
    both_X = [both_X[i] for i in order]
    y = [y[i] for i in order]
    h1c = [h1c[i] for i in order]
    return {"pre": pre_X, "in": in_X, "both": both_X, "y": y, "h1_corners": h1c,
            "pre_names": pre_names, "h1_names": h1_names}


def _fit_eval(Xtr, ytr, Xte, yte):
    import numpy as np
    from sklearn.ensemble import HistGradientBoostingRegressor
    from sklearn.metrics import mean_poisson_deviance
    m = HistGradientBoostingRegressor(loss="poisson", random_state=42, **_FIXED_CFG)
    m.fit(np.array(Xtr, dtype=float), np.array(ytr, dtype=float))
    pred = np.clip(m.predict(np.array(Xte, dtype=float)), 0.1, None)
    yte = np.array(yte, dtype=float)
    return {
        "mae": round(float(np.mean(np.abs(pred - yte))), 4),
        "rmse": round(float(np.sqrt(np.mean((pred - yte) ** 2))), 4),
        "corr": round(float(np.corrcoef(pred, yte)[0, 1]), 4),
        "deviance": round(float(mean_poisson_deviance(yte, pred)), 5),
        "mean_pred": round(float(pred.mean()), 3),
    }, pred


def run(path: Optional[Path] = None) -> Dict[str, Any]:
    import numpy as np
    conn = H._db(path)
    try:
        ds = build_inplay_dataset(conn)
    finally:
        conn.close()
    y = ds["y"]
    n = len(y)
    if n < 200:
        return {"error": f"insufficient dataset ({n})."}
    cut = int(n * 0.80)
    ytr, yte = y[:cut], y[cut:]
    yte_a = np.array(yte, dtype=float)

    naive_pred = np.full_like(yte_a, float(np.mean(ytr)))
    naive = {"mae": round(float(np.mean(np.abs(naive_pred - yte_a))), 4),
             "rmse": round(float(np.sqrt(np.mean((naive_pred - yte_a) ** 2))), 4),
             "corr": None, "mean_pred": round(float(np.mean(ytr)), 3)}

    pre_m, _ = _fit_eval(ds["pre"][:cut], ytr, ds["pre"][cut:], yte)
    in_m, in_pred = _fit_eval(ds["in"][:cut], ytr, ds["in"][cut:], yte)
    both_m, _ = _fit_eval(ds["both"][:cut], ytr, ds["both"][cut:], yte)

    # raw persistence: does H1 total corners alone track true H2 corners?
    h1_tot = np.array(ds["h1_corners"][cut:], dtype=float)
    pm = ~(np.isnan(h1_tot) | np.isnan(yte_a))
    persist_corr = round(float(np.corrcoef(h1_tot[pm], yte_a[pm])[0, 1]), 4)

    result = {
        "experiment": "in-play corners — does observed H1 pressure predict H2 corners?",
        "target": "2nd-half total corners",
        "dataset": {"fixtures": n, "train": cut, "test": n - cut,
                    "h2_mean": round(float(np.mean(y)), 2), "h2_std": round(float(np.std(y)), 2)},
        "raw_persistence_corr_h1corners_vs_h2corners": persist_corr,
        "models": {"naive": naive, "pre_match": pre_m, "in_play": in_m, "both": both_m},
        "lift_inplay_over_prematch": {
            "corr_gain": round((both_m["corr"] - pre_m["corr"]), 4),
            "mae_reduction": round((pre_m["mae"] - both_m["mae"]), 4),
        },
    }
    ARTIFACT_PATH.parent.mkdir(parents=True, exist_ok=True)
    ARTIFACT_PATH.write_text(json.dumps(result, indent=2))
    return result


def _print(r: Dict[str, Any]) -> None:
    if "error" in r:
        print("ERROR:", r["error"]); return
    d = r["dataset"]
    print("\n" + "=" * 70)
    print("  IN-PLAY CORNERS — does watching H1 predict H2 corners?")
    print("=" * 70)
    print(f"  target: 2nd-half total corners  (mean {d['h2_mean']}, std {d['h2_std']})")
    print(f"  fixtures: {d['fixtures']}  (train {d['train']} / test {d['test']})")
    print(f"\n  raw persistence  corr(H1 corners, H2 corners) = "
          f"{r['raw_persistence_corr_h1corners_vs_h2corners']}")
    print(f"\n  {'model':<12} {'MAE':>7} {'RMSE':>7} {'corr(pred,actual)':>18}")
    print("  " + "-" * 48)
    for key, label in (("naive", "NAIVE"), ("pre_match", "PRE-MATCH"),
                       ("in_play", "IN-PLAY (H1)"), ("both", "BOTH")):
        m = r["models"][key]
        corr = m["corr"]
        corr_s = f"{corr:>18.4f}" if corr is not None else f"{'~0':>18}"
        print(f"  {label:<12} {m['mae']:>7.3f} {m['rmse']:>7.3f}{corr_s}")
    print("  " + "-" * 48)
    lift = r["lift_inplay_over_prematch"]
    print(f"  LIFT of in-play over pre-match: corr +{lift['corr_gain']}, "
          f"MAE -{lift['mae_reduction']}")
    print("=" * 70 + "\n")


if __name__ == "__main__":
    import sys
    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"
    if cmd == "report":
        _print(json.loads(ARTIFACT_PATH.read_text()))
    else:
        _print(run())
