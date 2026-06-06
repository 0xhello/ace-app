#!/usr/bin/env python3
"""Build calibrated ACE confidence tiers from paper-tracked outcomes.

This is the data/model workstream behind Low / Medium / High confidence.
It reads canonical tracked picks, measures realized hit-rate/CLV by signal
strength, and writes a versioned artifact the app can consume.

The first version is deliberately conservative: when sample sizes are small, it
shrinks bucket hit rates toward the global observed win rate and reports a
maturity flag instead of pretending the tiers are fully validated.
"""
from __future__ import annotations

import argparse
import json
import math
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

APP_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_TRACKED_DB = APP_ROOT / "ml" / "nba_spread" / "data" / "tracked_picks.db"
DEFAULT_NBA_SIGNAL_DB = APP_ROOT / "ml" / "nba_spread" / "data" / "signal_log.db"
DEFAULT_ARTIFACT = APP_ROOT / "ml" / "ops" / "artifacts" / "confidence_calibration.json"
MODEL_VERSION = "ace_confidence_calibration_v0.2"

# Sports-betting calibration samples are noisy. These cutoffs describe artifact
# maturity, not whether the code can run.
MIN_SAMPLE_FULL = 250
MIN_SAMPLE_PROVISIONAL = 50
PRIOR_STRENGTH = 25

DEFAULT_BUCKETS: Tuple[Tuple[str, float, float], ...] = (
    ("low", 0.00, 0.03),
    ("medium", 0.03, 0.07),
    ("high", 0.07, math.inf),
)


@dataclass(frozen=True)
class CalibrationPick:
    sport: str
    market: str
    source: str
    score: float
    won: bool
    clv_pp: Optional[float]
    result: str


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(out):
        return None
    return out


def _score_from_row(row: sqlite3.Row) -> Tuple[Optional[float], str]:
    """Return the strongest available confidence feature and its source.

    Priority:
    1. model edge versus market if model_prob + implied_prob exist
    2. stored edge_pp
    3. stored signal_strength
    4. sharp edge versus book if sharp_prob + implied_prob exist

    Values are absolute percentage-point edges expressed as decimals, e.g. 0.05
    means 5 percentage points.
    """
    model_prob = _safe_float(row["model_prob"])
    implied_prob = _safe_float(row["implied_prob"])
    if model_prob is not None and implied_prob is not None:
        return abs(model_prob - implied_prob), "model_edge"

    edge_pp = _safe_float(row["edge_pp"])
    if edge_pp is not None:
        return abs(edge_pp), "edge_pp"

    signal_strength = _safe_float(row["signal_strength"])
    if signal_strength is not None:
        return abs(signal_strength), "signal_strength"

    sharp_prob = _safe_float(row["sharp_prob"])
    if sharp_prob is not None and implied_prob is not None:
        return abs(sharp_prob - implied_prob), "sharp_edge"

    return None, "missing"


def load_tracked_calibration_picks(db_path: Path = DEFAULT_TRACKED_DB) -> List[CalibrationPick]:
    if not db_path.exists():
        return []
    uri = f"file:{db_path}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """
            SELECT sport, market, result, model_prob, implied_prob, sharp_prob,
                   edge_pp, signal_strength, clv_pp
              FROM tracked_picks
             WHERE lifecycle = 'graded'
               AND result IN ('win', 'loss')
            """
        ).fetchall()
    finally:
        conn.close()

    picks: List[CalibrationPick] = []
    for row in rows:
        score, source = _score_from_row(row)
        if score is None:
            continue
        picks.append(
            CalibrationPick(
                sport=str(row["sport"] or "unknown"),
                market=str(row["market"] or "unknown"),
                source=source,
                score=score,
                won=row["result"] == "win",
                clv_pp=_safe_float(row["clv_pp"]),
                result=str(row["result"]),
            )
        )
    return picks



def load_nba_prediction_calibration_picks(db_path: Path = DEFAULT_NBA_SIGNAL_DB) -> List[CalibrationPick]:
    """Load historical NBA model predictions not yet fully represented in tracked_picks.

    `pick_confidence` is the model's selected-side cover probability. For tiering
    we use its margin over a coin flip, e.g. 0.58 -> 0.08. That makes it
    comparable to edge/signal-strength percentage-point scores.
    """
    if not db_path.exists():
        return []
    uri = f"file:{db_path}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """
            SELECT pick_confidence, correct, edge_vs_pinnacle
              FROM predictions
             WHERE result_status = 'graded'
               AND correct IN (0, 1)
               AND pick_confidence IS NOT NULL
            """
        ).fetchall()
    finally:
        conn.close()

    picks: List[CalibrationPick] = []
    for row in rows:
        pick_confidence = _safe_float(row["pick_confidence"])
        if pick_confidence is None:
            continue
        score = abs(pick_confidence - 0.5)
        picks.append(
            CalibrationPick(
                sport="nba",
                market="spread",
                source="nba_predictions.pick_confidence",
                score=score,
                won=int(row["correct"]) == 1,
                clv_pp=_safe_float(row["edge_vs_pinnacle"]),
                result="win" if int(row["correct"]) == 1 else "loss",
            )
        )
    return picks


def load_all_calibration_picks(
    tracked_db: Path = DEFAULT_TRACKED_DB,
    nba_signal_db: Path = DEFAULT_NBA_SIGNAL_DB,
) -> List[CalibrationPick]:
    return load_tracked_calibration_picks(tracked_db) + load_nba_prediction_calibration_picks(nba_signal_db)


def _maturity(n: int) -> str:
    if n >= MIN_SAMPLE_FULL:
        return "validated"
    if n >= MIN_SAMPLE_PROVISIONAL:
        return "provisional"
    return "insufficient_sample"


def _bucket_for_score(score: float, buckets: Sequence[Tuple[str, float, float]] = DEFAULT_BUCKETS) -> str:
    for label, lo, hi in buckets:
        if score >= lo and score < hi:
            return label
    return buckets[-1][0]


def _wilson_interval(wins: int, n: int, z: float = 1.96) -> Optional[Tuple[float, float]]:
    if n <= 0:
        return None
    phat = wins / n
    denom = 1 + z * z / n
    centre = phat + z * z / (2 * n)
    margin = z * math.sqrt((phat * (1 - phat) + z * z / (4 * n)) / n)
    return ((centre - margin) / denom, (centre + margin) / denom)


def _mean(values: Iterable[Optional[float]]) -> Optional[float]:
    vals = [v for v in values if v is not None and math.isfinite(v)]
    return sum(vals) / len(vals) if vals else None


def _bucket_summary(label: str, picks: Sequence[CalibrationPick], global_rate: float) -> Dict[str, Any]:
    n = len(picks)
    wins = sum(1 for p in picks if p.won)
    raw = wins / n if n else None
    # Bayesian shrinkage toward global hit rate keeps early tiers honest.
    shrunk = ((wins + PRIOR_STRENGTH * global_rate) / (n + PRIOR_STRENGTH)) if n else global_rate
    interval = _wilson_interval(wins, n)
    return {
        "tier": label,
        "n": n,
        "wins": wins,
        "losses": n - wins,
        "raw_hit_rate": raw,
        "shrunk_hit_rate": shrunk,
        "wilson_95": list(interval) if interval else None,
        "avg_score": _mean(p.score for p in picks),
        "avg_clv_pp": _mean(p.clv_pp for p in picks),
        "maturity": _maturity(n),
    }


def build_calibration(picks: Sequence[CalibrationPick]) -> Dict[str, Any]:
    n = len(picks)
    wins = sum(1 for p in picks if p.won)
    global_rate = wins / n if n else 0.5

    by_bucket: Dict[str, List[CalibrationPick]] = {label: [] for label, _, _ in DEFAULT_BUCKETS}
    for pick in picks:
        by_bucket[_bucket_for_score(pick.score)].append(pick)

    bucket_summaries = [_bucket_summary(label, by_bucket[label], global_rate) for label, _, _ in DEFAULT_BUCKETS]

    by_source: Dict[str, int] = {}
    for pick in picks:
        by_source[pick.source] = by_source.get(pick.source, 0) + 1

    by_sport: Dict[str, Dict[str, Any]] = {}
    for sport in sorted({p.sport for p in picks}):
        subset = [p for p in picks if p.sport == sport]
        sw = sum(1 for p in subset if p.won)
        by_sport[sport] = {
            "n": len(subset),
            "wins": sw,
            "hit_rate": sw / len(subset) if subset else None,
            "avg_score": _mean(p.score for p in subset),
            "avg_clv_pp": _mean(p.clv_pp for p in subset),
            "maturity": _maturity(len(subset)),
        }

    return {
        "model_version": MODEL_VERSION,
        "generated_at": _utc_now(),
        "source": "tracked_picks + nba_predictions",
        "score_definition": "absolute edge/signal strength in probability points; 0.05 = 5 percentage points",
        "tier_rules": [
            {"tier": label, "min_score": lo, "max_score": None if math.isinf(hi) else hi}
            for label, lo, hi in DEFAULT_BUCKETS
        ],
        "sample": {
            "n": n,
            "wins": wins,
            "losses": n - wins,
            "hit_rate": global_rate if n else None,
            "maturity": _maturity(n),
            "min_sample_provisional": MIN_SAMPLE_PROVISIONAL,
            "min_sample_validated": MIN_SAMPLE_FULL,
        },
        "buckets": bucket_summaries,
        "source_counts": dict(sorted(by_source.items())),
        "sports": by_sport,
        "warnings": _warnings(n, bucket_summaries),
    }


def _warnings(n: int, buckets: Sequence[Dict[str, Any]]) -> List[str]:
    warnings: List[str] = []
    if n < MIN_SAMPLE_FULL:
        warnings.append(
            "Sample is not large enough for fully validated confidence; use provisional/shrunk rates."
        )
    for bucket in buckets:
        if bucket["n"] < MIN_SAMPLE_PROVISIONAL:
            warnings.append(f"Tier {bucket['tier']} has only {bucket['n']} graded samples.")
    return warnings


def confidence_tier_for_score(score: float) -> str:
    return _bucket_for_score(abs(score))


def write_artifact(calibration: Dict[str, Any], artifact_path: Path = DEFAULT_ARTIFACT) -> None:
    artifact_path.parent.mkdir(parents=True, exist_ok=True)
    artifact_path.write_text(json.dumps(calibration, indent=2, sort_keys=True) + "\n")


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Build ACE confidence calibration artifact")
    parser.add_argument("--db", type=Path, default=DEFAULT_TRACKED_DB)
    parser.add_argument("--nba-signal-db", type=Path, default=DEFAULT_NBA_SIGNAL_DB)
    parser.add_argument("--out", type=Path, default=DEFAULT_ARTIFACT)
    args = parser.parse_args(argv)

    picks = load_all_calibration_picks(args.db, args.nba_signal_db)
    calibration = build_calibration(picks)
    write_artifact(calibration, args.out)
    print(json.dumps({"ok": True, "out": str(args.out), "sample": calibration["sample"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
