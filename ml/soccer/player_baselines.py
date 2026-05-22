"""
Per-player baseline rates for the player-prop model.

What this computes (from the 2,924 StatsBomb international rows we have):

  - Career intl g/90    — goals per 90 minutes (rolled up across all comps)
  - Career intl shots/90, SoT/90, conversion rate
  - Inferred position bucket (from shots/90 + g/90 patterns)
  - Bayesian-shrunk g/90 — pulls thin-sample players toward their position
    baseline so a guy with 1 goal in 90 minutes doesn't look like a
    1.0 g/90 superstar

Output: persisted to a player_baselines table for the player-prop model to
read at prediction time. Recomputed on each daily worker tick.

See docs/PLAYER_PROP_MODEL_SPEC_V1.md for the design.
"""
from __future__ import annotations

import sqlite3
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DB_PATH    = _REPO_ROOT / "ml" / "nba_spread" / "data" / "wc_signal_log.db"


def get_db(path: Optional[Path] = None) -> sqlite3.Connection:
    p = path or DB_PATH
    conn = sqlite3.connect(str(p))
    conn.row_factory = sqlite3.Row
    return conn


# ── Schema ───────────────────────────────────────────────────────────────────

def init_baselines_table(path: Optional[Path] = None) -> None:
    """Create the player_baselines cache. Additive only — safe re-run."""
    conn = get_db(path)
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS player_baselines (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            player_name        TEXT NOT NULL UNIQUE,
            total_goals        INTEGER NOT NULL DEFAULT 0,
            total_shots        INTEGER NOT NULL DEFAULT 0,
            total_sot          INTEGER NOT NULL DEFAULT 0,
            total_minutes      INTEGER NOT NULL DEFAULT 0,
            matches_played     INTEGER NOT NULL DEFAULT 0,
            n_competitions     INTEGER NOT NULL DEFAULT 0,
            g_per_90_raw       REAL,
            shots_per_90       REAL,
            sot_per_90         REAL,
            conversion_rate    REAL,   -- goals / shots
            position_bucket    TEXT,   -- 'forward' | 'attacker' | 'midfielder' | 'defender' | 'keeper'
            g_per_90_shrunk    REAL,   -- Bayesian-shrunk toward position baseline
            sample_confidence  TEXT,   -- 'high' | 'medium' | 'low' | 'minimal'
            computed_at        TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_player_baselines_name
            ON player_baselines(player_name);
    """)
    conn.commit()
    conn.close()


# ── Position inference ───────────────────────────────────────────────────────
# We don't have explicit position labels in our data. Infer from per-90 shot
# patterns — pretty stable signal once you have enough minutes.

_POSITION_RULES: List = [
    # (shots_per_90 >=, g_per_90 >=, bucket)
    (2.0,  0.0, "forward"),       # Out-and-out strikers
    (1.2,  0.0, "attacker"),      # Wingers / attacking mids
    (0.6,  0.0, "midfielder"),    # Box-to-box / playmakers
    (0.2,  0.0, "defender"),      # Defenders / DMs who occasionally shoot
    (0.0,  0.0, "keeper"),        # Effectively zero shots
]


def _infer_position(shots_per_90: float, g_per_90: float) -> str:
    """Heuristic position from shot pattern. Override-able if we ever add
    real position data (e.g. from squad sync)."""
    for threshold_shots, threshold_g, bucket in _POSITION_RULES:
        if shots_per_90 >= threshold_shots:
            return bucket
    return "keeper"


# Position baselines (g/90) used as Bayesian priors. Derived from the dataset
# itself — these update each run as the position distribution shifts.
# Caller can override by passing their own prior dict.

@dataclass
class PositionBaseline:
    bucket:        str
    n_players:     int
    avg_g_per_90:  float
    median_g_per_90: float


def compute_position_baselines(rows: List[Dict[str, Any]]) -> Dict[str, PositionBaseline]:
    """Compute per-position average g/90 from the players in the sample.
    Used as Bayesian prior in the shrinkage step."""
    buckets: Dict[str, List[float]] = {}
    for r in rows:
        if (r.get("total_minutes") or 0) < 270:
            continue  # only use established players to compute baselines
        rate = (r["total_goals"] or 0) / (r["total_minutes"] / 90.0)
        buckets.setdefault(r["position_bucket"], []).append(rate)
    out: Dict[str, PositionBaseline] = {}
    for b, vals in buckets.items():
        vals_sorted = sorted(vals)
        n = len(vals_sorted)
        avg = sum(vals_sorted) / n if n else 0.0
        med = vals_sorted[n // 2] if n else 0.0
        out[b] = PositionBaseline(
            bucket=b, n_players=n,
            avg_g_per_90=round(avg, 4),
            median_g_per_90=round(med, 4),
        )
    return out


# ── Bayesian shrinkage ───────────────────────────────────────────────────────
# Standard formulation: shrunk rate is weighted average of observed rate
# (weight = observed minutes) and prior rate (weight = prior strength in
# minutes equivalent). Stronger prior weight pulls thin-sample players
# harder toward the position baseline.

# Prior strength: 540 minutes (~6 full international matches). Tuned to be
# "you need ~6 matches of intl play before your raw rate is mostly trusted."
PRIOR_STRENGTH_MINUTES = 540.0


def _shrink_g_per_90(
    observed_goals: float, observed_minutes: float,
    prior_g_per_90: float,
) -> float:
    """Bayesian weighted mean. As observed_minutes → ∞, returns observed rate.
    With zero observed_minutes, returns prior."""
    if observed_minutes <= 0:
        return prior_g_per_90
    obs_rate  = observed_goals / (observed_minutes / 90.0)
    weight_obs   = observed_minutes
    weight_prior = PRIOR_STRENGTH_MINUTES
    shrunk_rate = (
        (obs_rate * weight_obs + prior_g_per_90 * weight_prior)
        / (weight_obs + weight_prior)
    )
    return round(float(shrunk_rate), 4)


def _sample_confidence(minutes: float) -> str:
    """Bucketed confidence label tied to total intl minutes played."""
    if minutes >= 1800:  return "high"      # 20+ full matches
    if minutes >= 900:   return "medium"    # 10-20 matches
    if minutes >= 270:   return "low"       # 3-10 matches
    return "minimal"                         # < 3 matches


# ── Main pipeline ────────────────────────────────────────────────────────────

def compute_and_persist(path: Optional[Path] = None) -> Dict[str, Any]:
    """Aggregate the StatsBomb data, infer positions, compute shrunk rates,
    persist to player_baselines. Returns a summary."""
    init_baselines_table(path)
    conn = get_db(path)

    # Step 1: aggregate per-player totals across all competitions
    agg_rows = conn.execute("""
        SELECT
            player_name,
            SUM(goals)            AS total_goals,
            SUM(shots)            AS total_shots,
            SUM(shots_on_target)  AS total_sot,
            SUM(minutes)          AS total_minutes,
            SUM(matches_played)   AS matches_played,
            COUNT(DISTINCT competition) AS n_competitions
        FROM wc_historical_form
        GROUP BY player_name
        HAVING total_minutes > 0
    """).fetchall()
    players: List[Dict[str, Any]] = []
    for r in agg_rows:
        m = r["total_minutes"] or 0
        g = r["total_goals"] or 0
        s = r["total_shots"] or 0
        sot = r["total_sot"] or 0
        g_per_90      = (g / (m / 90.0)) if m > 0 else 0.0
        shots_per_90  = (s / (m / 90.0)) if m > 0 else 0.0
        sot_per_90    = (sot / (m / 90.0)) if m > 0 else 0.0
        conv_rate     = (g / s) if s > 0 else None
        position      = _infer_position(shots_per_90, g_per_90)
        players.append({
            "player_name":      r["player_name"],
            "total_goals":      g,
            "total_shots":      s,
            "total_sot":        sot,
            "total_minutes":    m,
            "matches_played":   r["matches_played"] or 0,
            "n_competitions":   r["n_competitions"],
            "g_per_90_raw":     round(g_per_90, 4),
            "shots_per_90":     round(shots_per_90, 4),
            "sot_per_90":       round(sot_per_90, 4),
            "conversion_rate":  round(conv_rate, 4) if conv_rate is not None else None,
            "position_bucket":  position,
        })

    # Step 2: compute position baselines from the established-player subset
    baselines = compute_position_baselines(players)
    print("  [baselines] Position baselines (median g/90 per position):", flush=True)
    for b, info in sorted(baselines.items()):
        print(f"    {b:11s}  median={info.median_g_per_90:.3f}  "
              f"avg={info.avg_g_per_90:.3f}  n={info.n_players}", flush=True)

    # Step 3: apply Bayesian shrinkage per player
    for p in players:
        prior = baselines.get(p["position_bucket"])
        prior_rate = prior.median_g_per_90 if prior else 0.05
        p["g_per_90_shrunk"]   = _shrink_g_per_90(
            p["total_goals"], p["total_minutes"], prior_rate,
        )
        p["sample_confidence"] = _sample_confidence(p["total_minutes"])

    # Step 4: persist
    conn.execute("DELETE FROM player_baselines")
    for p in players:
        conn.execute("""
            INSERT INTO player_baselines
              (player_name, total_goals, total_shots, total_sot, total_minutes,
               matches_played, n_competitions,
               g_per_90_raw, shots_per_90, sot_per_90, conversion_rate,
               position_bucket, g_per_90_shrunk, sample_confidence)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            p["player_name"], p["total_goals"], p["total_shots"], p["total_sot"],
            p["total_minutes"], p["matches_played"], p["n_competitions"],
            p["g_per_90_raw"], p["shots_per_90"], p["sot_per_90"], p["conversion_rate"],
            p["position_bucket"], p["g_per_90_shrunk"], p["sample_confidence"],
        ))
    conn.commit()
    conn.close()

    # Summary
    by_pos: Dict[str, int] = {}
    by_conf: Dict[str, int] = {}
    for p in players:
        by_pos[p["position_bucket"]]  = by_pos.get(p["position_bucket"], 0) + 1
        by_conf[p["sample_confidence"]] = by_conf.get(p["sample_confidence"], 0) + 1
    return {
        "n_players":         len(players),
        "by_position":       by_pos,
        "by_confidence":     by_conf,
        "baselines":         {b: {"median": v.median_g_per_90, "avg": v.avg_g_per_90,
                                  "n_players": v.n_players}
                              for b, v in baselines.items()},
        "computed_at":       datetime.now(timezone.utc).isoformat(),
    }


# ── Read helpers (used by the player-prop model) ─────────────────────────────

def get_baseline(player_name: str, path: Optional[Path] = None) -> Optional[Dict[str, Any]]:
    """Look up a player's baseline. Returns None if not in StatsBomb dataset."""
    conn = get_db(path)
    try:
        r = conn.execute(
            "SELECT * FROM player_baselines WHERE player_name = ?",
            (player_name,),
        ).fetchone()
        return dict(r) if r else None
    finally:
        conn.close()


def top_scorers(n: int = 20, min_minutes: int = 540,
                path: Optional[Path] = None) -> List[Dict[str, Any]]:
    """Top intl scorers by shrunk g/90 (filtered to established players).
    Sanity-check view — should show actual top scorers."""
    conn = get_db(path)
    try:
        rows = conn.execute("""
            SELECT player_name, total_goals, total_minutes, matches_played,
                   g_per_90_raw, g_per_90_shrunk, position_bucket, sample_confidence
            FROM player_baselines
            WHERE total_minutes >= ?
            ORDER BY g_per_90_shrunk DESC LIMIT ?
        """, (min_minutes, n)).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# ── CLI ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "compute"
    if cmd == "compute":
        import json
        s = compute_and_persist()
        print("\n=== Summary ===")
        print(json.dumps(s, indent=2))
    elif cmd == "top":
        print("=== Top-20 intl scorers (Bayesian-shrunk g/90, ≥540 min only) ===")
        for r in top_scorers(20):
            print(f"  {r['player_name']:30s}  "
                  f"{r['total_goals']:3d}G / {r['total_minutes']:5d}min "
                  f"({r['matches_played']:3d}m)  "
                  f"raw={r['g_per_90_raw']:.3f}  shrunk={r['g_per_90_shrunk']:.3f}  "
                  f"[{r['position_bucket']}] {r['sample_confidence']}")
    elif cmd.startswith("show:"):
        name = cmd.split(":", 1)[1]
        r = get_baseline(name)
        print(json.dumps(r, indent=2, default=str) if r else f"Player not found: {name}")
    else:
        print("usage: python3 -m ml.soccer.player_baselines [compute|top|show:<player>]",
              file=sys.stderr)
        sys.exit(1)
