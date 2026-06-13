#!/usr/bin/env python3
"""
ml/soccer/match_takes.py — grounded "analyst takes" for one fixture.

Honest pre-match reads across the markets a sports fan actually cares about:
match result, total goals, both-teams-to-score, corners, first to score, and
(when lineups are posted) anytime-scorer / shots player props.

Design decisions (set with the product owner):
  • The backbone is Sportmonks' own pre-match PREDICTIONS model, which — unlike
    our Elo+Dixon-Coles club model — actually covers national teams (our
    soccer_team_form table has ZERO World Cup nations). It is a real external
    probabilistic model, not a de-vig of the betting line.
  • Player props use our Understat-derived player_baselines (g/90, shots/90,
    sot/90) mapped to the posted XI via name. Only big-club players have a
    baseline, so this is best-effort and clearly gated.
  • NO fabricated confidence. Each take carries the real model probability and
    an evidence TIER derived from how decisive that probability is. When nothing
    clears the bar, we say so rather than inventing a pick.
  • The betting line is at most a quiet cross-check, never the thesis.

CLI:
    python3 -m ml.soccer.match_takes <fixture_id> "<home>" "<away>" [corner_line]
"""
from __future__ import annotations

import json
import math
import sqlite3
from typing import Any, Dict, List, Optional

from ml.soccer.sportmonks_fixture import (
    fetch_fixture_bundle,
    _normalize_predictions,
    _normalize_lineups,
)

try:
    from ml.world_cup.signal_logger import DB_PATH as _DB_PATH
except Exception:  # pragma: no cover - fallback to the known location
    _DB_PATH = "ml/nba_spread/data/wc_signal_log.db"


# ── tiering ──────────────────────────────────────────────────────────────────
# A take's tier is empirical, not invented: it reflects how decisive the model
# probability is. "Strong" = the model is confident; "Lean" = a real edge of
# opinion; "Slight" = a nudge. Below SLIGHT we show no take for that market.
TIER_STRONG = "Strong"
TIER_LEAN = "Lean"
TIER_SLIGHT = "Slight"


def _binary_tier(p: float) -> Optional[str]:
    """Tier a two-way probability by distance from a coin flip."""
    if p >= 0.62:
        return TIER_STRONG
    if p >= 0.56:
        return TIER_LEAN
    if p >= 0.525:
        return TIER_SLIGHT
    return None


def _pct(p: float) -> int:
    return int(round(p * 100))


def _find(preds: Dict[str, Any], *tokens: str, exclude: Optional[List[str]] = None) -> Optional[Dict[str, Any]]:
    """Tolerant lookup: first prediction whose key contains all tokens and none
    of the `exclude` tokens. Exclusion matters because Sportmonks ships team-
    scoped variants (e.g. "Away Over/Under 2.5 Probability") alongside the
    match-level market — matching the wrong one silently corrupts the take."""
    toks = [t.lower() for t in tokens]
    ex = [e.lower() for e in (exclude or [])]
    for key, val in preds.items():
        k = key.lower()
        if all(t in k for t in toks) and not any(e in k for e in ex) and isinstance(val, dict):
            return val
    return None


# ── team-market takes (Sportmonks predictions) ──────────────────────────────
def _result_take(preds: Dict[str, Any], home: str, away: str) -> List[Dict[str, Any]]:
    r = _find(preds, "fulltime", "result")
    if not r:
        return []
    try:
        h, a, d = float(r.get("home", 0)) / 100, float(r.get("away", 0)) / 100, float(r.get("draw", 0)) / 100
    except Exception:
        return []
    outcomes = [(home, h), (away, a), ("Draw", d)]
    outcomes.sort(key=lambda x: x[1], reverse=True)
    (top_name, top_p), (_, second_p) = outcomes[0], outcomes[1]
    margin = top_p - second_p
    # Tier the moneyline lean by how clearly it separates from the next outcome.
    if margin >= 0.22:
        tier = TIER_STRONG
    elif margin >= 0.10:
        tier = TIER_LEAN
    elif margin >= 0.05:
        tier = TIER_SLIGHT
    else:
        return []  # genuine coin-flip — no honest lean
    if top_name == "Draw":
        return []  # we do not lead with draw picks (owner call + de-vig bias)
    reasons = [
        f"Sportmonks' match model makes it {top_name} {_pct(top_p)}% / Draw {_pct(d)}% / {away if top_name==home else home} {_pct(a if top_name==home else h)}%.",
        f"That's a {int(round(margin*100))}-point edge over the next most likely result.",
    ]
    return [{
        "market": "result", "market_label": "Match result",
        "selection": f"{top_name} to win",
        "tier": tier, "model_pct": _pct(top_p),
        "reasons": reasons, "source": "Sportmonks match model",
    }]


def _totals_take(preds: Dict[str, Any]) -> List[Dict[str, Any]]:
    r = _find(preds, "over/under", "2.5", exclude=["home", "away"])
    if not r:
        return []
    try:
        over = float(r.get("yes", 0)) / 100
    except Exception:
        return []
    under = 1 - over
    side, p = ("Over 2.5 goals", over) if over >= under else ("Under 2.5 goals", under)
    tier = _binary_tier(p)
    if not tier:
        return []
    return [{
        "market": "totals", "market_label": "Total goals",
        "selection": side, "tier": tier, "model_pct": _pct(p),
        "reasons": [f"The match model lands on {side.lower()} at {_pct(p)}%."],
        "source": "Sportmonks match model",
    }]


def _btts_take(preds: Dict[str, Any]) -> List[Dict[str, Any]]:
    r = _find(preds, "both", "teams", "score")
    if not r:
        return []
    try:
        yes = float(r.get("yes", 0)) / 100
    except Exception:
        return []
    no = 1 - yes
    side, p = ("Both teams to score", yes) if yes >= no else ("Not both teams to score", no)
    tier = _binary_tier(p)
    if not tier:
        return []
    return [{
        "market": "btts", "market_label": "Both teams to score",
        "selection": side, "tier": tier, "model_pct": _pct(p),
        "reasons": [f"Model probability {_pct(p)}%."],
        "source": "Sportmonks match model",
    }]


def _corners_take(preds: Dict[str, Any], book_line: Optional[float]) -> List[Dict[str, Any]]:
    """Use the Sportmonks corners ladder; lean on the side of the book's line."""
    # If we know the book's corner line, evaluate that exact line; else default 9.
    line = book_line if book_line is not None else 9.0
    # Sportmonks ladders are integer "Over/Under N" where yes = corners > N.
    n = int(math.floor(line))
    r = _find(preds, "corners", f"over/under {n} ")
    if not r:
        # try without trailing space / common lines
        for cand in (n, 9, 10, 8):
            r = _find(preds, "corners", f"over/under {cand}")
            if r:
                n = cand
                break
    if not r:
        return []
    try:
        over = float(r.get("yes", 0)) / 100
        under = float(r.get("no", 0)) / 100
    except Exception:
        return []
    # renormalize over/under ignoring the "equal" push bucket
    tot = over + under
    if tot <= 0:
        return []
    over_n, under_n = over / tot, under / tot
    side, p = (f"Over {n + 0.5:g} corners", over_n) if over_n >= under_n else (f"Under {n + 0.5:g} corners", under_n)
    tier = _binary_tier(p)
    if not tier:
        return []
    return [{
        "market": "corners", "market_label": "Corners",
        "selection": side, "tier": tier, "model_pct": _pct(p),
        "reasons": [f"Corners model leans {side.lower()} ({_pct(p)}% excluding push)."],
        "source": "Sportmonks corners model",
    }]


def _first_scorer_take(preds: Dict[str, Any], home: str, away: str) -> List[Dict[str, Any]]:
    r = _find(preds, "team", "score", "first")
    if not r:
        return []
    try:
        h, a = float(r.get("home", 0)) / 100, float(r.get("away", 0)) / 100
    except Exception:
        return []
    side, p = (home, h) if h >= a else (away, a)
    tier = _binary_tier(p)
    if not tier:
        return []
    return [{
        "market": "first_to_score", "market_label": "First to score",
        "selection": f"{side} score first",
        "tier": tier, "model_pct": _pct(p),
        "reasons": [f"{side} are {_pct(p)}% to open the scoring per the match model."],
        "source": "Sportmonks match model",
    }]


# ── player-prop takes (player_baselines × posted XI) ─────────────────────────
def _poisson_at_least_one(lam: float) -> float:
    return 1.0 - math.exp(-max(lam, 0.0))


def _load_baselines(names: List[str]) -> Dict[str, sqlite3.Row]:
    """Map XI names → club baselines. EXACT full-name match preferred. A last-
    name fallback is only accepted when it resolves to exactly ONE player —
    otherwise it's a collision (e.g. defender "Gustavo Gómez" stealing a
    forward's shot rate) and we skip rather than surface a wrong-player take."""
    if not names:
        return {}
    try:
        conn = sqlite3.connect(_DB_PATH)
        conn.row_factory = sqlite3.Row
    except Exception:
        return {}
    cols = "player_name, g_per_90_shrunk, shots_per_90, sot_per_90, sample_confidence, position_bucket"
    out: Dict[str, sqlite3.Row] = {}
    try:
        for nm in names:
            row = conn.execute(
                f"SELECT {cols} FROM player_baselines WHERE player_name = ? LIMIT 1", (nm,)
            ).fetchone()
            if not row and nm and " " in nm:
                last = nm.split()[-1]
                cands = conn.execute(
                    f"SELECT {cols} FROM player_baselines WHERE player_name LIKE ?", (f"% {last}",)
                ).fetchall()
                row = cands[0] if len(cands) == 1 else None  # only accept unambiguous
            if row:
                out[nm] = row
    finally:
        conn.close()
    return out


def _player_takes(lineups: List[Dict[str, Any]], home_id: Optional[int]) -> List[Dict[str, Any]]:
    starters = [r for r in lineups if r.get("is_starter")]
    if len(starters) < 11:
        return []  # XIs not posted yet — no honest player props
    names = [r.get("player_name") or r.get("common_name") for r in starters if r.get("player_name") or r.get("common_name")]
    base = _load_baselines([n for n in names if n])
    if not base:
        return []
    # Thin samples are common for WC players (limited Understat club data). We
    # still surface the clear threats — a fan expects a take on Afif or Embolo —
    # but a thin sample CAPS the tier and is stated plainly in the reason. Tier
    # is never inflated by a number we don't trust.
    thin = lambda c: c in ("low", "minimal")
    # Attacking outfielders only — never surface a keeper/centre-back as a
    # scorer or shots threat (guards against any remaining name ambiguity).
    attack = lambda r: (r["position_bucket"] or "").upper() in ("FWD", "MID", "ATT", "FORWARD", "MIDFIELDER", "")
    scorers, shooters = [], []
    for nm, row in base.items():
        if not attack(row):
            continue
        g90 = row["g_per_90_shrunk"] or 0
        sh90 = row["shots_per_90"] or 0
        conf = row["sample_confidence"]
        p_score = _poisson_at_least_one(g90 * 80 / 90)  # ~80 mins for a starter
        if p_score >= 0.25 and g90 > 0:
            scorers.append((nm, p_score, conf))
        if sh90 >= 2.0:
            shooters.append((nm, sh90, conf))
    out: List[Dict[str, Any]] = []
    scorers.sort(key=lambda x: x[1], reverse=True)
    for nm, p, conf in scorers[:2]:
        if thin(conf):
            tier = TIER_LEAN if p >= 0.40 else TIER_SLIGHT
        else:
            tier = TIER_STRONG if p >= 0.42 else TIER_LEAN if p >= 0.32 else TIER_SLIGHT
        note = " (limited club sample)" if thin(conf) else ""
        out.append({
            "market": "anytime_scorer", "market_label": "Anytime scorer",
            "selection": f"{nm} to score",
            "tier": tier, "model_pct": _pct(p),
            "reasons": [f"Projects ~{_pct(p)}% to score on his club goal rate{note}."],
            "source": "ACE player baseline",
        })
    shooters.sort(key=lambda x: x[1], reverse=True)
    for nm, sh90, conf in shooters[:2]:
        if thin(conf):
            tier = TIER_LEAN if sh90 >= 3.0 else TIER_SLIGHT
        else:
            tier = TIER_STRONG if sh90 >= 3.2 else TIER_LEAN if sh90 >= 2.5 else TIER_SLIGHT
        note = ", limited sample" if thin(conf) else ""
        out.append({
            "market": "shots", "market_label": "Player shots",
            "selection": f"{nm} 2+ shots",
            "tier": tier, "model_pct": None,
            "reasons": [f"Averages {sh90:.1f} shots/90 at club level{note}."],
            "source": "ACE player baseline",
        })
    return out


def row_conf(conf: str) -> str:
    return {"high": "strong", "medium": "solid", "low": "thin"}.get(conf, "club")


# ── public entrypoint ────────────────────────────────────────────────────────
def build_match_takes(fixture_id: int, home: str, away: str, corner_line: Optional[float] = None) -> Dict[str, Any]:
    try:
        bundle = fetch_fixture_bundle(int(fixture_id))
    except Exception as e:
        return {"fixture_id": fixture_id, "takes": [], "error": str(e)[:160]}
    preds = _normalize_predictions(bundle.get("predictions"))
    lineups = _normalize_lineups(bundle.get("lineups"))
    parts = bundle.get("participants") or []
    home_id = next((p.get("id") for p in parts if (p.get("meta") or {}).get("location") == "home"), None)

    takes: List[Dict[str, Any]] = []
    takes += _result_take(preds, home, away)
    takes += _totals_take(preds)
    takes += _btts_take(preds)
    takes += _corners_take(preds, corner_line)
    takes += _first_scorer_take(preds, home, away)
    takes += _player_takes(lineups, home_id)

    return {
        "fixture_id": fixture_id,
        "home": home, "away": away,
        "has_predictions": bool(preds),
        "lineups_posted": sum(1 for r in lineups if r.get("is_starter")) >= 22,
        "takes": takes,
        "generated_at": bundle.get("starting_at"),
    }


if __name__ == "__main__":
    import sys
    fid = int(sys.argv[1])
    home = sys.argv[2] if len(sys.argv) > 2 else "Home"
    away = sys.argv[3] if len(sys.argv) > 3 else "Away"
    cl = float(sys.argv[4]) if len(sys.argv) > 4 else None
    print(json.dumps(build_match_takes(fid, home, away, cl), indent=2, default=str))
