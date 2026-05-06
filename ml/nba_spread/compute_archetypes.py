#!/usr/bin/env python3
"""
compute_archetypes.py

Converts raw team style stats into a structured archetype profile for each team.
Classification is percentile-based within the current season so thresholds
adapt as league-wide pace, shooting, etc. evolve over time.

Reads:  ml/nba_spread/data/team_style_stats.csv   (from fetch_team_styles.py)
        ml/nba_spread/artifacts/latest_team_state.json  (for home/away splits, travel)
Writes: ml/nba_spread/artifacts/team_archetypes.json

Archetype dimensions
────────────────────
pace_tier        fast / medium / slow
offense_style    three_heavy / balanced / paint_dominant
defense_tier     elite / good / average / poor
ball_movement    high_assist / balanced / iso_heavy
transition       high / medium / low
clutch           strong / neutral / weak
home_skew        home_dependent / neutral / road_capable
travel_risk      high / low
volatility       consistent / volatile

The archetype JSON also stores the raw percentile ranks so the explanation
layer can say things like "top-5 pace team" or "bottom-3 defense" rather
than just bucket labels.

Usage:
    python3 -m ml.nba_spread.compute_archetypes
    python3 -m ml.nba_spread.compute_archetypes --season 2025-26
    python3 -m ml.nba_spread.compute_archetypes --print
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

import pandas as pd

DATA_DIR   = Path(__file__).resolve().parent / "data"
ARTIFACT_DIR = Path(__file__).resolve().parent / "artifacts"
STYLE_PATH = DATA_DIR / "team_style_stats.csv"
STATE_PATH = ARTIFACT_DIR / "latest_team_state.json"
ARCHETYPE_PATH = ARTIFACT_DIR / "team_archetypes.json"


# ── Percentile → tier label ────────────────────────────────────────────────────

def _pct_tier_3(pct: float, high_good: bool = True) -> str:
    """
    Map percentile (0–1) into a 3-bucket label.
    high_good=True:  top 33% → 'high', bottom 33% → 'low'
    high_good=False: top 33% → 'low'  (for drtg: lower is better)
    """
    if high_good:
        if pct >= 0.67:  return "high"
        if pct >= 0.33:  return "medium"
        return "low"
    else:
        if pct <= 0.33:  return "high"   # low drtg = high quality defense
        if pct <= 0.67:  return "medium"
        return "low"


def _pct_tier_4(pct: float, high_good: bool = True) -> str:
    """4-bucket label. Used for defense/offense where fine-grained matters."""
    if high_good:
        if pct >= 0.75:  return "elite"
        if pct >= 0.50:  return "good"
        if pct >= 0.25:  return "average"
        return "poor"
    else:
        if pct <= 0.25:  return "elite"
        if pct <= 0.50:  return "good"
        if pct <= 0.75:  return "average"
        return "poor"


def _percentile_ranks(series: pd.Series) -> pd.Series:
    """Return 0–1 percentile rank for each element in a Series."""
    return series.rank(pct=True, na_option="keep")


# ── Core classification ────────────────────────────────────────────────────────

def _classify_offense_style(fg3a_pct: Optional[float], oreb_pct: Optional[float],
                             fg3a_rank: Optional[float]) -> str:
    """
    three_heavy  — top 33% 3PA rate
    paint_dominant — bottom 33% 3PA rate AND above-avg oreb_pct
    balanced     — everything else
    """
    if fg3a_rank is None or pd.isna(fg3a_rank):
        return "balanced"
    if fg3a_rank >= 0.67:
        return "three_heavy"
    if fg3a_rank <= 0.33 and oreb_pct is not None and not pd.isna(oreb_pct) and oreb_pct >= 0.28:
        return "paint_dominant"
    return "balanced"


def _classify_ball_movement(ast_pct: Optional[float], ast_pct_rank: Optional[float]) -> str:
    if ast_pct_rank is None or pd.isna(ast_pct_rank):
        return "balanced"
    if ast_pct_rank >= 0.67:
        return "high_assist"
    if ast_pct_rank <= 0.33:
        return "iso_heavy"
    return "balanced"


def _classify_transition(avg_speed: Optional[float], pace_rank: Optional[float],
                         speed_rank: Optional[float]) -> str:
    """
    Use avg_speed if available; fall back to pace_rank as proxy.
    """
    rank = speed_rank if (speed_rank is not None and not pd.isna(speed_rank)) else pace_rank
    if rank is None or pd.isna(rank):
        return "medium"
    return _pct_tier_3(rank)


def _classify_clutch(q4_margin_avg10: Optional[float],
                     q4_cover_rate5: Optional[float]) -> str:
    """
    Uses Q4 margin from team_state (not style stats).
    strong: positive q4 margin AND q4 cover > 0.5
    weak:   negative q4 margin AND q4 cover < 0.5
    """
    if q4_margin_avg10 is None:
        return "neutral"
    if q4_margin_avg10 > 1.5 and (q4_cover_rate5 or 0.5) >= 0.5:
        return "strong"
    if q4_margin_avg10 < -1.5 and (q4_cover_rate5 or 0.5) < 0.5:
        return "weak"
    return "neutral"


def _classify_home_skew(ortg_home: Optional[float], ortg_away: Optional[float]) -> str:
    """
    Compare ortg at home vs away.
    home_dependent: home is significantly better
    road_capable:   away is close to (or exceeds) home
    """
    if ortg_home is None or ortg_away is None:
        return "neutral"
    diff = ortg_home - ortg_away
    if diff > 8:
        return "home_dependent"
    if diff < 2:
        return "road_capable"
    return "neutral"


def _classify_travel_risk(tz_delta: Optional[float],
                           road_trip_games: Optional[float]) -> str:
    if tz_delta is None:
        return "low"
    if abs(tz_delta) >= 2 or (road_trip_games or 0) >= 3:
        return "high"
    return "low"


def _classify_volatility(margins: list[float]) -> str:
    """Compute stddev of recent margins. High variance = volatile."""
    if not margins:
        return "consistent"
    try:
        import statistics
        sd = statistics.stdev(margins) if len(margins) >= 2 else 0
        return "volatile" if sd > 14 else "consistent"
    except Exception:
        return "consistent"


# ── Main compute function ──────────────────────────────────────────────────────

def compute(season: Optional[str] = None) -> Dict[str, Any]:
    """
    Load style stats and team state, classify archetypes for all teams.
    Returns dict mapping team_code → archetype profile.
    """
    if not STYLE_PATH.exists():
        raise FileNotFoundError(
            f"team_style_stats.csv not found at {STYLE_PATH}.\n"
            "Run: python3 -m ml.nba_spread.fetch_team_styles first."
        )

    style_df = pd.read_csv(STYLE_PATH)

    # Filter to requested season and regular season data (fuller sample)
    if season:
        df = style_df[style_df["season"] == season].copy()
    else:
        # Use the most recent season available
        latest_season = style_df["season"].max()
        df = style_df[style_df["season"] == latest_season].copy()
        season = latest_season

    # Prefer Regular Season; fall back to whatever is available
    reg = df[df["season_type"] == "regular_season"]
    df = reg if not reg.empty else df

    if df.empty:
        raise ValueError(f"No style data found for season {season}.")

    # For each team with multiple fetches, use most recent
    df = df.sort_values("fetched_at").groupby("team_code", sort=False).last().reset_index()

    print(f"  Computing archetypes for {len(df)} teams  (season={season})")

    # Compute league-wide percentile ranks
    pace_rank    = _percentile_ranks(df["pace"])      if "pace"    in df else pd.Series()
    ortg_rank    = _percentile_ranks(df["ortg"])      if "ortg"    in df else pd.Series()
    drtg_rank    = _percentile_ranks(-df["drtg"])     if "drtg"    in df else pd.Series()  # lower drtg = better → negate
    fg3a_rank    = _percentile_ranks(df["fg3a_pct"])  if "fg3a_pct" in df else pd.Series()
    ast_rank     = _percentile_ranks(df["ast_pct"])   if "ast_pct" in df else pd.Series()
    speed_rank   = _percentile_ranks(df["avg_speed"]) if "avg_speed" in df else pd.Series()
    net_rtg_rank = _percentile_ranks(df["net_rtg"])   if "net_rtg" in df else pd.Series()

    # Load team state for Q4 / home-away / travel
    team_state: Dict[str, Any] = {}
    if STATE_PATH.exists():
        team_state = json.loads(STATE_PATH.read_text())

    archetypes: Dict[str, Any] = {}

    for idx, row in df.iterrows():
        team = str(row["team_code"])
        state = team_state.get(team, {})

        def _safe(col: str, default=None):
            v = row.get(col)
            return default if (v is None or pd.isna(v)) else v

        def _rank(rank_series: pd.Series, default=None):
            if rank_series.empty or idx >= len(rank_series):
                return default
            v = rank_series.iloc[idx] if isinstance(idx, int) else rank_series.loc[idx]
            return default if pd.isna(v) else float(v)

        # Gather raw values
        pace_val    = _safe("pace")
        ortg_val    = _safe("ortg")
        drtg_val    = _safe("drtg")
        fg3a_val    = _safe("fg3a_pct")
        fg3_pct     = _safe("fg3_pct")
        ast_pct_val = _safe("ast_pct")
        oreb_pct    = _safe("oreb_pct")
        dreb_pct    = _safe("dreb_pct")
        ts_pct      = _safe("ts_pct")
        tov_pct     = _safe("tov_pct")
        avg_speed   = _safe("avg_speed")
        net_rtg     = _safe("net_rtg")
        pts_pg      = _safe("pts_per_game")

        # Percentile ranks
        pr = _rank(pace_rank)
        or_ = _rank(ortg_rank)
        dr = _rank(drtg_rank)
        f3r = _rank(fg3a_rank)
        ar = _rank(ast_rank)
        sr = _rank(speed_rank)
        nr = _rank(net_rtg_rank)

        # From team_state
        q4_margin  = state.get("q4_margin_avg10")
        q4_cover   = state.get("q4_cover_rate5")
        ortg_home  = state.get("ortg_home_avg5")
        ortg_away  = state.get("ortg_away_avg5")
        tz_delta   = state.get("tz_delta")
        road_games = state.get("road_trip_games")

        # Volatility from margin history (approximated from available state)
        # Use margin_last1 variance signal — rough but available
        m5 = state.get("margin_avg_5")
        m3 = state.get("margin_avg_3")
        m1 = state.get("margin_last1")
        rough_margins = [x for x in [m1, m3, m5] if x is not None]

        archetype = {
            # Style classifications
            "pace_tier":      _pct_tier_3(pr) if pr is not None else "medium",
            "offense_style":  _classify_offense_style(fg3a_val, oreb_pct, f3r),
            "defense_tier":   _pct_tier_4(dr, high_good=True) if dr is not None else "average",
            "ball_movement":  _classify_ball_movement(ast_pct_val, ar),
            "transition":     _classify_transition(avg_speed, pr, sr),
            "clutch":         _classify_clutch(q4_margin, q4_cover),
            "home_skew":      _classify_home_skew(ortg_home, ortg_away),
            "travel_risk":    _classify_travel_risk(tz_delta, road_games),
            "volatility":     _classify_volatility(rough_margins),

            # Raw values for explanation layer and future use
            "raw": {
                "pace":        round(pace_val, 1) if pace_val is not None else None,
                "ortg":        round(ortg_val, 1) if ortg_val is not None else None,
                "drtg":        round(drtg_val, 1) if drtg_val is not None else None,
                "net_rtg":     round(net_rtg, 1) if net_rtg is not None else None,
                "fg3a_pct":    round(fg3a_val, 3) if fg3a_val is not None else None,
                "fg3_pct":     round(fg3_pct, 3) if fg3_pct is not None else None,
                "ast_pct":     round(ast_pct_val, 3) if ast_pct_val is not None else None,
                "oreb_pct":    round(oreb_pct, 3) if oreb_pct is not None else None,
                "dreb_pct":    round(dreb_pct, 3) if dreb_pct is not None else None,
                "ts_pct":      round(ts_pct, 3) if ts_pct is not None else None,
                "tov_pct":     round(tov_pct, 1) if tov_pct is not None else None,
                "avg_speed":   round(avg_speed, 2) if avg_speed is not None else None,
                "pts_per_game": round(pts_pg, 1) if pts_pg is not None else None,
                "q4_margin":   round(q4_margin, 2) if q4_margin is not None else None,
                "q4_cover":    round(q4_cover, 3) if q4_cover is not None else None,
                "ortg_home":   round(ortg_home, 1) if ortg_home is not None else None,
                "ortg_away":   round(ortg_away, 1) if ortg_away is not None else None,
            },

            # Percentile ranks (0-1, 1=best in league)
            "pct_ranks": {
                "pace":    round(pr, 3) if pr is not None else None,
                "offense": round(or_, 3) if or_ is not None else None,
                "defense": round(dr, 3) if dr is not None else None,
                "fg3a":    round(f3r, 3) if f3r is not None else None,
                "assist":  round(ar, 3) if ar is not None else None,
                "net_rtg": round(nr, 3) if nr is not None else None,
            },

            "season": season,
            "computed_at": datetime.now(timezone.utc).isoformat(),
        }

        archetypes[team] = archetype

    return archetypes


def save(archetypes: Dict[str, Any]) -> None:
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    ARCHETYPE_PATH.write_text(json.dumps(archetypes, indent=2))
    print(f"  Saved {len(archetypes)} team archetypes → {ARCHETYPE_PATH}")


def load() -> Dict[str, Any]:
    """Load computed archetypes. Returns empty dict if not yet computed."""
    if ARCHETYPE_PATH.exists():
        return json.loads(ARCHETYPE_PATH.read_text())
    return {}


def describe_matchup(home_code: str, away_code: str,
                     archetypes: Optional[Dict[str, Any]] = None) -> str:
    """
    Return a human-readable matchup context string for the explanation layer.
    Used by inference.py and signal_logger when building bet thesis.
    """
    if archetypes is None:
        archetypes = load()
    if not archetypes:
        return ""

    h = archetypes.get(home_code, {})
    a = archetypes.get(away_code, {})
    if not h or not a:
        return ""

    lines = []

    # Pace conflict
    h_pace = h.get("pace_tier", "medium")
    a_pace = a.get("pace_tier", "medium")
    if h_pace != a_pace:
        controller = home_code if h_pace == "slow" else away_code
        lines.append(f"pace conflict: {home_code}={h_pace} vs {away_code}={a_pace} → {controller} likely controls tempo")
    else:
        lines.append(f"pace: both {h_pace}")

    # Offense vs defense clash
    h_off  = h.get("offense_style", "balanced")
    a_def  = a.get("defense_tier", "average")
    a_off  = a.get("offense_style", "balanced")
    h_def  = h.get("defense_tier", "average")
    if h_off == "three_heavy" and a_def in ("elite", "good"):
        lines.append(f"clash: {home_code} 3-heavy offense vs {away_code} elite/good perimeter D")
    if a_off == "three_heavy" and h_def in ("elite", "good"):
        lines.append(f"clash: {away_code} 3-heavy offense vs {home_code} elite/good perimeter D")
    if h_off == "paint_dominant" and a_def in ("elite", "good"):
        lines.append(f"clash: {home_code} paint-dominant offense vs {away_code} strong D")

    # Ball movement mismatch
    h_bm = h.get("ball_movement", "balanced")
    a_bm = a.get("ball_movement", "balanced")
    if h_bm == "high_assist" and a_bm == "iso_heavy":
        lines.append(f"style: {home_code} system offense vs {away_code} iso-heavy — pace and flow conflict")
    elif a_bm == "high_assist" and h_bm == "iso_heavy":
        lines.append(f"style: {away_code} system offense vs {home_code} iso-heavy")

    # Home skew
    h_home_skew = h.get("home_skew", "neutral")
    if h_home_skew == "home_dependent":
        lines.append(f"note: {home_code} significantly better at home (home_dependent)")
    elif h_home_skew == "road_capable":
        lines.append(f"note: {home_code} road_capable — home advantage reduced")

    # Clutch
    h_clutch = h.get("clutch", "neutral")
    a_clutch = a.get("clutch", "neutral")
    if h_clutch == "strong" and a_clutch == "weak":
        lines.append(f"clutch edge: {home_code} strong in Q4, {away_code} weak")
    elif a_clutch == "strong" and h_clutch == "weak":
        lines.append(f"clutch edge: {away_code} strong in Q4, {home_code} weak")

    # Travel risk for away team
    a_travel = a.get("travel_risk", "low")
    if a_travel == "high":
        lines.append(f"travel risk: {away_code} high travel burden coming in")

    return " | ".join(lines) if lines else ""


def print_summary(archetypes: Dict[str, Any]) -> None:
    print(f"\n  {'Team':<6}  {'Pace':<8}  {'Offense':<16}  {'Defense':<8}  "
          f"{'Movement':<12}  {'Clutch':<8}  {'Home':<16}")
    print("  " + "─" * 88)
    for team, a in sorted(archetypes.items()):
        raw = a.get("raw", {})
        print(
            f"  {team:<6}  {a['pace_tier']:<8}  {a['offense_style']:<16}  "
            f"{a['defense_tier']:<8}  {a['ball_movement']:<12}  "
            f"{a['clutch']:<8}  {a['home_skew']:<16}"
            + (f"  ortg={raw.get('ortg')}"  if raw.get('ortg') else "")
            + (f"  drtg={raw.get('drtg')}"  if raw.get('drtg') else "")
            + (f"  3pa={raw.get('fg3a_pct')}" if raw.get('fg3a_pct') else "")
        )
    print()


def run(season: Optional[str] = None, print_output: bool = False) -> None:
    print("=" * 55)
    print("  ACE — Compute Team Archetypes")
    print("=" * 55)
    archetypes = compute(season)
    save(archetypes)
    if print_output:
        print_summary(archetypes)
    else:
        print(f"  Done.  Run with --print to view summary table.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--season", default=None,
                        help="NBA season string, e.g. 2025-26")
    parser.add_argument("--print", dest="print_output", action="store_true",
                        help="Print archetype summary table")
    args = parser.parse_args()

    try:
        run(season=args.season, print_output=args.print_output)
    except Exception as e:
        print(f"\n  ERROR: {e}", file=sys.stderr)
        sys.exit(1)
