#!/usr/bin/env python3
"""predictions_crosscheck.py — Sportmonks-as-second-opinion (M39).

Why this module exists
======================
Our existing 1X2 backtest is negative. BTTS / corners aren't backtested
yet. Only Totals 2.5 over has earned its keep. We need an INDEPENDENT
prediction stream to flag picks where the ACE model is probably wrong
*before* we surface them.

Sportmonks ships a pre-match probability for 28 markets per fixture
(see M38). We don't trust Sportmonks blindly — they're not Pinnacle —
but they're a useful disagreement signal: when ACE says home 65% and
Sportmonks says home 35%, at least one of us is wrong. Either way we
should NOT show the bettor an A-tier pick at that level of disagreement.

Decision policy (deliberately conservative)
-------------------------------------------
For a given (market, side) ACE pick with model probability ``p_ace``
and Sportmonks probability ``p_sm`` on the same market+side:

  abs(p_ace − p_sm) < 5pp     → agree         (tier unchanged)
  5pp ≤ abs(...) < 15pp       → mild_disagree (demote 1 tier: A→B, B→C)
  abs(...) ≥ 15pp             → strong_disagree (demote to watch)
  p_sm missing / not priced   → no_signal     (tier unchanged, no badge)

Direction-blind on purpose. We demote on EITHER over- or under-shoot
because we can't tell which model is wrong from a single fixture. The
M40 backtest harness will eventually tell us which direction to weight
more — for now, conservative demotion is the right move.

Market mapping
--------------
ACE market keys (used by approved_picks, candidates) → Sportmonks
prediction names (decoded via live probe). Whole-line shifts (Sportmonks
prices Corners O/U at integer thresholds 4..11, FanDuel at half-lines
8.5/9.5) require explicit pairing.

No live API calls — operates purely on a cached Sportmonks bundle from
ml/soccer/sportmonks_fixture.py.
"""
from __future__ import annotations

from typing import Any, Dict, Optional, Tuple


# ── Tier policy ────────────────────────────────────────────────────────────

_AGREE_THRESHOLD_PP = 5.0
_STRONG_DISAGREE_PP = 15.0

# Order of confidence tiers, highest → lowest. Used for the one-step
# demotion in the mild-disagree path.
_TIER_ORDER = ("A", "B", "C", "watch")


def _demote_one(tier: str) -> str:
    """A → B → C → watch (stays at watch)."""
    if tier not in _TIER_ORDER:
        return "watch"
    idx = _TIER_ORDER.index(tier)
    return _TIER_ORDER[min(idx + 1, len(_TIER_ORDER) - 1)]


# ── Market name mapping ────────────────────────────────────────────────────

# (ace_market, ace_side) → (sportmonks_market_name, sportmonks_side_key)
# ace_side keys mirror what `approved_picks.market/side` carries through
# the pipeline (lowercase, standard book-side names).
_MARKET_MAP: Dict[Tuple[str, str], Tuple[str, str]] = {
    # 1X2
    ("1x2",     "home"):  ("Fulltime Result Probability", "home"),
    ("1x2",     "draw"):  ("Fulltime Result Probability", "draw"),
    ("1x2",     "away"):  ("Fulltime Result Probability", "away"),
    ("h2h",     "home"):  ("Fulltime Result Probability", "home"),
    ("h2h",     "draw"):  ("Fulltime Result Probability", "draw"),
    ("h2h",     "away"):  ("Fulltime Result Probability", "away"),
    # Totals 2.5 — our validated market
    ("totals_2.5", "over"):  ("Over/Under 2.5 Probability", "yes"),
    ("totals_2.5", "under"): ("Over/Under 2.5 Probability", "no"),
    ("totals",     "over"):  ("Over/Under 2.5 Probability", "yes"),
    ("totals",     "under"): ("Over/Under 2.5 Probability", "no"),
    # BTTS
    ("btts", "yes"): ("Both Teams To Score Probability", "yes"),
    ("btts", "no"):  ("Both Teams To Score Probability", "no"),
    # First-to-score
    ("first_to_score", "home"): ("Team To Score First Probability", "home"),
    ("first_to_score", "away"): ("Team To Score First Probability", "away"),
    ("first_to_score", "draw"): ("Team To Score First Probability", "draw"),
    # Home / Away team-total over (uses 0.5/1.5/2.5/3.5 ladder)
    ("home_total_0.5", "over"): ("Home Over/Under 0.5 Probability", "yes"),
    ("home_total_0.5", "under"):("Home Over/Under 0.5 Probability", "no"),
    ("home_total_1.5", "over"): ("Home Over/Under 1.5 Probability", "yes"),
    ("home_total_1.5", "under"):("Home Over/Under 1.5 Probability", "no"),
    ("home_total_2.5", "over"): ("Home Over/Under 2.5 Probability", "yes"),
    ("home_total_2.5", "under"):("Home Over/Under 2.5 Probability", "no"),
    ("away_total_0.5", "over"): ("Away Over/Under 0.5 Probability", "yes"),
    ("away_total_0.5", "under"):("Away Over/Under 0.5 Probability", "no"),
    ("away_total_1.5", "over"): ("Away Over/Under 1.5 Probability", "yes"),
    ("away_total_1.5", "under"):("Away Over/Under 1.5 Probability", "no"),
    ("away_total_2.5", "over"): ("Away Over/Under 2.5 Probability", "yes"),
    ("away_total_2.5", "under"):("Away Over/Under 2.5 Probability", "no"),
}

# Corners use a per-integer-line ladder on the Sportmonks side. The book
# (FanDuel) prices at half-lines. To compare apples-to-apples we round
# the book line DOWN to the integer for the over side (Over 8.5 wins iff
# corners ≥ 9, same as Sportmonks "Corners Over/Under 8 Probability" yes
# = corners > 8) and the under side picks up the same.
_CORNERS_LINES = (4, 5, 6, 7, 8, 9, 10, 11)


def _corners_lookup(side: str, line: float) -> Optional[Tuple[str, str]]:
    """Pick the Sportmonks corners market that matches a book line."""
    # We support the most common half-lines (and the 10.5 special case
    # Sportmonks happens to also surface)
    try:
        # Sportmonks "Over/Under X" with yes = corners > X. To match
        # book "over 8.5" we want corners ≥ 9, i.e. corners > 8.
        threshold = int(round(line - 0.5)) if side == "over" else int(round(line - 0.5))
    except (TypeError, ValueError):
        return None
    if threshold not in _CORNERS_LINES:
        return None
    sm_market = f"Corners Over/Under {threshold} Probability"
    sm_side = "yes" if side == "over" else "no"
    return (sm_market, sm_side)


# ── Core API ───────────────────────────────────────────────────────────────

def lookup_sportmonks_prob(
    bundle: Optional[Dict[str, Any]],
    ace_market: str,
    ace_side: str,
    *,
    line: Optional[float] = None,
) -> Optional[float]:
    """Return Sportmonks' probability (in 0..1) for an ACE (market, side).

    Returns None when the bundle is missing OR Sportmonks doesn't price
    the market (player props are a notable example — they have no
    Sportmonks counterpart and always return None).
    """
    if not bundle:
        return None
    preds = bundle.get("predictions") or {}
    if not preds:
        return None

    ace_m = (ace_market or "").lower()
    ace_s = (ace_side or "").lower()

    # Corners need the line to pick the right Sportmonks integer threshold.
    if ace_m.startswith("corners") and line is not None:
        side_for_corners = "over" if "over" in ace_s or ace_s in ("yes", "over") else "under"
        lookup = _corners_lookup(side_for_corners, float(line))
        if not lookup:
            return None
        sm_market, sm_side = lookup
    else:
        sm = _MARKET_MAP.get((ace_m, ace_s))
        if not sm:
            return None
        sm_market, sm_side = sm

    market = preds.get(sm_market)
    if not isinstance(market, dict):
        return None
    raw = market.get(sm_side)
    if raw is None:
        return None
    try:
        # Sportmonks returns percentages in 0..100. Normalize.
        val = float(raw)
    except (TypeError, ValueError):
        return None
    return max(0.0, min(1.0, val / 100.0))


def evaluate_agreement(
    *,
    ace_prob: float,
    sportmonks_prob: Optional[float],
) -> Dict[str, Any]:
    """Score one (ace, sportmonks) probability pair.

    Returns:
      {
        "tier":         "agree" | "mild_disagree" | "strong_disagree" | "no_signal",
        "delta_pp":     ace_prob − sportmonks_prob, in pp (signed, may be None)
        "ace_prob":     0..1
        "sportmonks_prob": 0..1 or None
        "badge":        short English string for the UI
        "demote_steps": int — how many tiers to drop the ACE pick by
      }
    """
    if sportmonks_prob is None:
        return {
            "tier": "no_signal",
            "delta_pp": None,
            "ace_prob": round(float(ace_prob), 4),
            "sportmonks_prob": None,
            "badge": "no second-opinion price",
            "demote_steps": 0,
        }
    delta = float(ace_prob) - float(sportmonks_prob)
    delta_pp = abs(delta) * 100.0
    if delta_pp < _AGREE_THRESHOLD_PP:
        tier = "agree"
        badge = "Sportmonks agrees"
        steps = 0
    elif delta_pp < _STRONG_DISAGREE_PP:
        tier = "mild_disagree"
        badge = (
            f"Sportmonks {('lower' if delta > 0 else 'higher')} by {delta_pp:.0f} points"
        )
        steps = 1
    else:
        tier = "strong_disagree"
        badge = (
            f"model conflict — {delta_pp:.0f}-point gap vs Sportmonks"
        )
        steps = 99  # always to watch
    return {
        "tier": tier,
        "delta_pp": round(delta * 100.0, 2),  # signed
        "ace_prob": round(float(ace_prob), 4),
        "sportmonks_prob": round(float(sportmonks_prob), 4),
        "badge": badge,
        "demote_steps": steps,
    }


def apply_demotion(original_tier: str, agreement: Dict[str, Any]) -> str:
    """Return the new confidence tier after applying agreement demotion.

    - no_signal / agree: tier unchanged
    - mild_disagree:     one step down (A→B, B→C, C→watch)
    - strong_disagree:   straight to watch
    """
    steps = agreement.get("demote_steps", 0)
    if not steps:
        return original_tier
    if steps >= 99:
        return "watch"
    out = original_tier
    for _ in range(steps):
        out = _demote_one(out)
    return out


def crosscheck_pick(
    *,
    bundle: Optional[Dict[str, Any]],
    ace_market: str,
    ace_side: str,
    ace_prob: float,
    original_tier: str = "B",
    line: Optional[float] = None,
) -> Dict[str, Any]:
    """One-shot helper used by the picks pipeline.

    Returns a dict with the agreement record + the post-demotion tier so
    the caller can drop it straight into the approved_picks row or the
    prop card.
    """
    sm = lookup_sportmonks_prob(bundle, ace_market, ace_side, line=line)
    agree = evaluate_agreement(ace_prob=ace_prob, sportmonks_prob=sm)
    new_tier = apply_demotion(original_tier, agree)
    return {
        **agree,
        "original_tier": original_tier,
        "new_tier": new_tier,
        "tier_was_demoted": new_tier != original_tier,
    }


# ── CLI / quick verification ───────────────────────────────────────────────

if __name__ == "__main__":
    import argparse, json
    from ml.soccer.sportmonks_fixture import (
        get_cached_bundle_by_teams, get_cached_bundle_by_fixture_id,
    )

    p = argparse.ArgumentParser(description="Predictions cross-check (M39)")
    p.add_argument("--fixture-id", type=int, default=None,
                   help="Sportmonks fixture_id to look up")
    p.add_argument("--home", default=None)
    p.add_argument("--away", default=None)
    p.add_argument("--market", required=True,
                   help="ACE market key (e.g. 'totals_2.5', '1x2', 'btts', 'corners')")
    p.add_argument("--side", required=True,
                   help="ACE side (e.g. 'over', 'home', 'yes')")
    p.add_argument("--ace-prob", type=float, required=True,
                   help="ACE model probability (0..1)")
    p.add_argument("--original-tier", default="B", choices=["A", "B", "C", "watch"])
    p.add_argument("--line", type=float, default=None,
                   help="Book line (required for corners)")
    args = p.parse_args()

    bundle = None
    if args.fixture_id:
        bundle = get_cached_bundle_by_fixture_id(args.fixture_id)
    elif args.home and args.away:
        bundle = get_cached_bundle_by_teams(args.home, args.away)

    out = crosscheck_pick(
        bundle=bundle,
        ace_market=args.market,
        ace_side=args.side,
        ace_prob=args.ace_prob,
        original_tier=args.original_tier,
        line=args.line,
    )
    print(json.dumps(out, indent=2, ensure_ascii=False))
