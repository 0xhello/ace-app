#!/usr/bin/env python3
"""
segment_model_performance.py

Reads model_performance.csv and segments model accuracy by situational context.
Context is extracted from the features_json column (full feature vector stored at
prediction time) so no external lookups are needed.

The output surfaces where the model looks strong vs weak across:
  - Regime (playoffs / regular season)
  - Bet direction (home / away)
  - Favorite vs underdog + spread size
  - Rest situation (b2b, rest advantage/disadvantage)
  - Confidence tier
  - Edge vs Pinnacle tier
  - Calibration (predicted confidence vs actual win rate)

Sample sizes are tiny right now (playoffs only) — the value is in the framework
accumulating data each season, not the current numbers.

Usage:
    python3 -m ml.nba_spread.segment_model_performance
    python3 -m ml.nba_spread.segment_model_performance --print
    python3 -m ml.nba_spread.segment_model_performance --min-n 5
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

import pandas as pd

DATA_DIR     = Path(__file__).resolve().parent / "data"
ARTIFACT_DIR = Path(__file__).resolve().parent / "artifacts"
PERF_PATH    = DATA_DIR / "model_performance.csv"
SEGMENT_PATH = ARTIFACT_DIR / "model_performance_segments.json"


# ── Context extraction ─────────────────────────────────────────────────────────

def _extract_context(df: pd.DataFrame) -> pd.DataFrame:
    """Enrich each row with context fields derived from features_json."""
    ctx_rows = []
    for _, row in df.iterrows():
        feats: Dict[str, Any] = {}
        if row.get("features_json") and str(row["features_json"]) not in ("", "nan"):
            try:
                feats = json.loads(str(row["features_json"]))
            except Exception:
                pass

        pick = str(row.get("pick_side", ""))
        home_line = float(row.get("home_line") or 0.0)
        conf = float(row.get("pick_confidence") or 0.5)
        edge = float(row["edge_vs_pinnacle"]) if str(row.get("edge_vs_pinnacle", "")) not in ("", "nan") else None
        correct = int(row["correct"]) if str(row.get("correct", "")) not in ("", "nan") else None

        home_rest = float(feats.get("home_rest_days", 2))
        away_rest = float(feats.get("away_rest_days", 2))
        is_playoffs = int(feats.get("is_playoffs", 0))
        home_b2b = int(feats.get("home_back2back", 0))
        away_b2b = int(feats.get("away_back2back", 0))

        # Bet side rest vs opponent rest
        bet_rest = home_rest if pick == "home" else away_rest
        opp_rest = away_rest if pick == "home" else home_rest
        bet_b2b  = home_b2b  if pick == "home" else away_b2b

        # Spread context: from home team perspective
        # home_line < 0 → home is favorite; pick determines if we're on the fave
        if pick == "home":
            is_fav = home_line < 0
            spread_abs = abs(home_line)
        else:
            is_fav = home_line > 0
            spread_abs = abs(home_line)

        # Buckets
        if spread_abs > 7:
            spread_bucket = "large_spread_7+"
        elif spread_abs > 3.5:
            spread_bucket = "mid_spread_3.5-7"
        elif spread_abs > 1:
            spread_bucket = "small_spread_1-3.5"
        else:
            spread_bucket = "pickem_0-1"

        if is_fav:
            dog_fav = f"fav_{spread_bucket}"
        else:
            dog_fav = f"dog_{spread_bucket}"

        if bet_b2b:
            rest_situation = "bet_side_b2b"
        elif bet_rest > opp_rest + 1:
            rest_situation = "rest_advantage_2+"
        elif bet_rest > opp_rest:
            rest_situation = "rest_advantage_1"
        elif opp_rest > bet_rest + 1:
            rest_situation = "rest_disadvantage_2+"
        elif opp_rest > bet_rest:
            rest_situation = "rest_disadvantage_1"
        else:
            rest_situation = "rest_even"

        if conf >= 0.65:
            conf_tier = "conf_65+"
        elif conf >= 0.60:
            conf_tier = "conf_60-65"
        elif conf >= 0.575:
            conf_tier = "conf_57.5-60"
        else:
            conf_tier = "conf_55-57.5"

        if edge is None:
            edge_tier = "no_pinnacle"
        elif abs(edge) >= 0.10:
            edge_tier = "edge_10+"
        elif abs(edge) >= 0.06:
            edge_tier = "edge_6-10"
        else:
            edge_tier = "edge_4-6"

        ctx_rows.append({
            "regime":         "playoffs" if is_playoffs else "regular_season",
            "direction":      pick,
            "dog_fav":        dog_fav,
            "spread_bucket":  spread_bucket,
            "is_fav":         is_fav,
            "rest_situation": rest_situation,
            "bet_rest":       bet_rest,
            "conf_tier":      conf_tier,
            "edge_tier":      edge_tier,
            # derived floats used by _stats (avoid colliding with CSV columns)
            "ctx_correct":    correct,
            "ctx_is_bet":     int(row.get("is_bet") or 0),
            "confidence":     conf,
            "edge":           edge,
        })

    ctx = pd.DataFrame(ctx_rows)
    return pd.concat([df.reset_index(drop=True), ctx], axis=1)


# ── Segment stats helper ───────────────────────────────────────────────────────

def _stats(subset: pd.DataFrame) -> Dict[str, Any]:
    graded = subset[subset["ctx_correct"].notna()]
    if graded.empty:
        return {"n": len(subset), "n_graded": 0}

    n = len(graded)
    wins = int(graded["ctx_correct"].sum())
    edges = graded["edge"].dropna()
    confidences = graded["confidence"]

    result: Dict[str, Any] = {
        "n":            n,
        "wins":         wins,
        "win_rate":     round(wins / n, 3) if n else None,
        "avg_conf":     round(float(confidences.mean()), 3),
    }
    if not edges.empty:
        result["avg_edge"] = round(float(edges.mean()), 4)
        result["n_with_edge"] = len(edges)

    return result


def _segment(df: pd.DataFrame, col: str) -> Dict[str, Any]:
    out = {}
    for val in sorted(df[col].dropna().unique()):
        out[str(val)] = _stats(df[df[col] == val])
    return out


# ── Calibration ────────────────────────────────────────────────────────────────

def _calibration(df: pd.DataFrame) -> List[Dict[str, Any]]:
    """Bin predicted confidence vs actual win rate — tests if model is well-calibrated."""
    graded = df[df["ctx_correct"].notna()].copy()
    if graded.empty:
        return []

    bins = [0.50, 0.55, 0.575, 0.60, 0.625, 0.65, 0.70, 1.01]
    labels = ["50-55", "55-57.5", "57.5-60", "60-62.5", "62.5-65", "65-70", "70+"]
    graded["cal_bucket"] = pd.cut(
        graded["confidence"], bins=bins, labels=labels, right=False
    )
    rows = []
    for label in labels:
        sub = graded[graded["cal_bucket"] == label]
        if sub.empty:
            continue
        rows.append({
            "conf_bucket":     label,
            "n":               len(sub),
            "predicted_avg":   round(float(sub["confidence"].mean()), 3),
            "actual_win_rate": round(float(sub["ctx_correct"].mean()), 3),
            "delta":           round(float(sub["ctx_correct"].mean()) - float(sub["confidence"].mean()), 3),
        })
    return rows


# ── Main compute ───────────────────────────────────────────────────────────────

def compute(min_n: int = 1) -> Dict[str, Any]:
    if not PERF_PATH.exists():
        raise FileNotFoundError(f"model_performance.csv not found: {PERF_PATH}")

    raw = pd.read_csv(PERF_PATH)
    graded_raw = raw[raw["result_status"] == "graded"].copy()
    if graded_raw.empty:
        return {"error": "no graded rows", "generated_at": datetime.now(timezone.utc).isoformat()}

    # Track features_json coverage before context extraction — rows without it
    # default to generic feature values (rest=2, is_playoffs=0, b2b=0), which
    # silently biases regime/rest segments toward regular-season defaults.
    has_features = graded_raw["features_json"].notna() & (graded_raw["features_json"].astype(str) != "")
    features_coverage = int(has_features.sum())
    features_missing  = int((~has_features).sum())

    df = _extract_context(graded_raw)
    bets = df[df["ctx_is_bet"] == 1]

    coverage_note = ""
    if features_missing > 0:
        pct = round(100 * features_coverage / len(df))
        coverage_note = (
            f" | WARN: {features_missing} rows missing features_json ({pct}% coverage) — "
            f"regime/rest segments for those rows default to regular_season/rest_even"
        )

    out: Dict[str, Any] = {
        "generated_at":      datetime.now(timezone.utc).isoformat(),
        "features_coverage": {"total": len(df), "has_features": features_coverage, "missing": features_missing},
        "sample_note":       f"n={len(df)} total graded, n_bets={len(bets)} — treat as directional only until n≥100{coverage_note}",
        "overall":      _stats(df),
        "bets_only":    _stats(bets) if not bets.empty else {"n": 0},
        "by_regime":    _segment(df, "regime"),
        "by_direction": _segment(df, "direction"),
        "by_dog_fav":   _segment(df, "dog_fav"),
        "by_rest":      _segment(df, "rest_situation"),
        "by_conf_tier": _segment(df, "conf_tier"),
        "by_edge_tier": _segment(bets, "edge_tier") if not bets.empty else {},
        "calibration":  _calibration(df),
    }

    # Flag any segment where win_rate < 0.40 with n >= min_n (potential weak spots)
    weak = []
    for section_key in ("by_regime", "by_direction", "by_dog_fav", "by_rest", "by_conf_tier"):
        for seg_val, stats in out[section_key].items():
            if stats.get("n", 0) >= min_n and stats.get("win_rate") is not None:
                if stats["win_rate"] < 0.40:
                    weak.append({"segment": f"{section_key}/{seg_val}", **stats})
    out["weak_spots"] = sorted(weak, key=lambda x: x["win_rate"])

    return out


def save(report: Dict[str, Any]) -> None:
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    SEGMENT_PATH.write_text(json.dumps(report, indent=2))
    print(f"  Saved → {SEGMENT_PATH}")


def print_report(report: Dict[str, Any], min_n: int = 3) -> None:
    def _row(label: str, stats: Dict[str, Any]) -> None:
        n = stats.get("n", 0)
        if n < min_n:
            return
        wr = f"{stats['win_rate']:.1%}" if stats.get("win_rate") is not None else " n/a "
        conf = f"{stats['avg_conf']:.3f}" if stats.get("avg_conf") else "  n/a"
        edge = f"edge={stats['avg_edge']:+.4f}" if stats.get("avg_edge") else ""
        flag = " ← WEAK" if (stats.get("win_rate") or 1) < 0.40 else ""
        print(f"    {label:<32}  n={n:>3}  win={wr}  conf={conf}  {edge}{flag}")

    print(f"\n  Note: {report['sample_note']}")

    for section, title in [
        ("overall",      "Overall"),
        ("bets_only",    "Bets only (is_bet=1)"),
    ]:
        print(f"\n  [{title}]")
        _row(title, report[section])

    for section, title in [
        ("by_regime",    "By regime"),
        ("by_direction", "By direction"),
        ("by_dog_fav",   "By fav/dog + spread"),
        ("by_rest",      "By rest situation"),
        ("by_conf_tier", "By confidence tier"),
        ("by_edge_tier", "By edge tier (bets only)"),
    ]:
        items = report.get(section, {})
        if not items:
            continue
        print(f"\n  [{title}]")
        for k, v in sorted(items.items()):
            _row(k, v)

    cal = report.get("calibration", [])
    if cal:
        print("\n  [Calibration — predicted conf vs actual win rate]")
        print(f"    {'bucket':<12}  {'n':>4}  {'pred':>6}  {'actual':>7}  {'delta':>7}")
        for r in cal:
            delta = r['delta']
            flag = " ← over" if delta < -0.05 else (" ← under" if delta > 0.05 else "")
            print(f"    {r['conf_bucket']:<12}  {r['n']:>4}  {r['predicted_avg']:.3f}  {r['actual_win_rate']:.3f}    {delta:+.3f}{flag}")

    weak = report.get("weak_spots", [])
    if weak:
        print(f"\n  [Weak spots — n≥{min_n}, win_rate < 40%]")
        for w in weak:
            print(f"    {w['segment']:<38}  n={w['n']}  win={w['win_rate']:.1%}")


def run(print_output: bool = False, min_n: int = 3) -> None:
    print("=" * 55)
    print("  ACE — Model Performance Segmentation")
    print("=" * 55)
    report = compute(min_n=min_n)
    save(report)
    if print_output:
        print_report(report, min_n=min_n)
    else:
        n = report.get("overall", {}).get("n", 0)
        wr = report.get("overall", {}).get("win_rate")
        print(f"  n={n}  overall_win_rate={wr}  (run with --print for full breakdown)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--print", dest="print_output", action="store_true")
    parser.add_argument("--min-n", type=int, default=3,
                        help="Minimum observations to show in report (default: 3)")
    args = parser.parse_args()
    try:
        run(print_output=args.print_output, min_n=args.min_n)
    except Exception as e:
        print(f"\n  ERROR: {e}", file=sys.stderr)
        sys.exit(1)
