#!/usr/bin/env python3
"""
pick_explainer.py — turn a raw signal into a human-readable "why this pick".

Competitors give you the edge number. ACE gives you the story. The
explainer is the layer that lets a subscriber understand WHY we like
a pick — using OUR data:

  - StatsBomb historical aggregates (career g/90 across intl tournaments)
  - API-Football club form (recent club-season stats)
  - Computed goalscorer prior (anytime_scorer_prob, intl_uplift)
  - Game context (dead rubber, suspension risk, weather when available)
  - The actual divergence (Pinnacle vs soft book, or our prior vs book)

Why template-based, not LLM:
  - Free (no per-signal API cost)
  - Deterministic / verifiable
  - Same data competitors don't have — that's the moat, not prose quality
  - When we want richer prose later, swap the templates for an LLM call

Each explanation has three layers:
  1. Headline — what the pick is + the edge number
  2. Why — the prior / historical context that makes us think it's +EV
  3. Caveat — what could go wrong (small sample, dead rubber, etc.)
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional


# ────────── Formatters ──────────

def _fmt_odds(american: Optional[float]) -> str:
    if american is None: return "—"
    return f"+{int(american)}" if american >= 0 else f"{int(american)}"

def _fmt_pct(p: Optional[float], decimals: int = 1) -> str:
    if p is None: return "—"
    return f"{p * 100:.{decimals}f}%"

def _fmt_pp(p: Optional[float]) -> str:
    if p is None: return "—"
    return f"{p * 100:+.1f}pp"


# ────────── Market-specific headline builders ──────────

def _bet_label(market: str, bet_side: str, line: Optional[float],
               home_team: str, away_team: str,
               player_name: Optional[str] = None) -> str:
    """Pretty bet label: 'France ML', 'Over 2.5 goals', 'Mbappé anytime'."""
    if market == "player_goal_scorer_anytime":
        return f"{player_name or 'Player'} anytime scorer"
    if market == "h2h":
        if bet_side == "home":  return f"{home_team} moneyline"
        if bet_side == "away":  return f"{away_team} moneyline"
        if bet_side == "draw":  return "Draw"
    if market == "totals":
        return f"{bet_side.capitalize()} {line:g} goals" if line is not None else f"{bet_side.capitalize()} total"
    if market in ("asian_handicap", "spreads"):
        if line is None: return f"{bet_side.capitalize()} spread"
        sign = "+" if line >= 0 else ""
        team = home_team if bet_side == "home" else away_team
        return f"{team} {sign}{line:g}"
    if market == "run_line":
        if line is None: return f"{bet_side.capitalize()} run line"
        sign = "+" if line >= 0 else ""
        team = home_team if bet_side == "home" else away_team
        return f"{team} {sign}{line:g}"
    return f"{market}/{bet_side}"


# ────────── Tier-based confidence prose ──────────

def _confidence_phrase(tier: Optional[str], edge_pp: Optional[float]) -> str:
    """Map (tier, edge magnitude) → a casual confidence label."""
    if edge_pp is None: return "edge present"
    if tier == "A" or edge_pp >= 0.05:
        return "strong divergence"
    if tier == "B" or edge_pp >= 0.04:
        return "solid edge"
    return "modest edge"


# ────────── The main explainer ──────────

def explain_signal(
    signal: Dict[str, Any],
    historical_form: Optional[List[Dict[str, Any]]] = None,
    club_form: Optional[List[Dict[str, Any]]] = None,
    prior: Optional[Dict[str, Any]] = None,
    game_context: Optional[Dict[str, Any]] = None,
) -> Dict[str, str]:
    """Generate the 3-part explanation for a signal.

    Returns:
      {
        "headline": "France ML at +130 — +5.2pp edge vs Pinnacle",
        "why":      "Pinnacle de-vigged France at 45% but FanDuel implies 38%. ...",
        "caveat":   "Small sample (3 graded picks at this tier). ...",
      }

    All inputs except `signal` are optional — when missing we fall back
    to generic prose based on the signal alone. Richer when joined data
    is passed in.
    """
    market    = signal.get("market", "")
    bet_side  = signal.get("bet_side", "")
    home      = signal.get("home_team", "")
    away      = signal.get("away_team", "")
    book      = signal.get("book", "")
    book_odds = signal.get("book_odds")
    book_prob = signal.get("book_prob")
    pin_prob  = signal.get("pinnacle_prob")
    edge_pp   = signal.get("edge_pp")
    tier      = signal.get("confidence_tier")
    line      = signal.get("total_line") if signal.get("total_line") is not None else signal.get("line")
    player    = signal.get("player_name")
    tournament = signal.get("tournament") or ""

    # Routing: player props vs game-level get different "why" narratives
    if market == "player_goal_scorer_anytime":
        return _explain_player_prop(
            signal, historical_form, club_form, prior, player, edge_pp, tier, book, book_odds,
        )
    return _explain_game_level(
        signal, market, bet_side, home, away, book, book_odds,
        book_prob, pin_prob, edge_pp, tier, line, tournament, game_context,
    )


def _explain_game_level(
    signal: Dict[str, Any], market: str, bet_side: str,
    home: str, away: str, book: str, book_odds: Optional[float],
    book_prob: Optional[float], pin_prob: Optional[float], edge_pp: Optional[float],
    tier: Optional[str], line: Optional[float], tournament: str,
    game_context: Optional[Dict[str, Any]],
) -> Dict[str, str]:
    """Build the explanation for h2h / totals / spreads / run_line / AH."""
    bet = _bet_label(market, bet_side, line, home, away)
    odds_str = _fmt_odds(book_odds)
    edge_str = _fmt_pp(edge_pp)
    confidence = _confidence_phrase(tier, edge_pp)

    headline = f"{bet} at {book} {odds_str} — {edge_str} {confidence}"

    # ── Why ──
    why_parts: List[str] = []
    if pin_prob is not None and book_prob is not None:
        why_parts.append(
            f"Pinnacle de-vigged {bet_side} at {_fmt_pct(pin_prob)}, but {book} prices imply only "
            f"{_fmt_pct(book_prob)} — a soft-book gap of {edge_str}."
        )
        why_parts.append(
            "Pinnacle's closing line is widely considered the sharpest "
            "indicator of true probability; sustained divergence vs Pinnacle "
            "is the most-cited predictor of long-run +EV bets in published "
            "betting research."
        )
    elif edge_pp is not None:
        why_parts.append(
            f"Our model flagged a {edge_str} divergence between {book}'s line and the sharp benchmark."
        )

    if market == "totals" and line is not None:
        why_parts.append(
            f"Tournament average totals run ~2.7 goals; {line:g} {bet_side} at {edge_str} edge suggests "
            f"the {book} line is mispriced relative to expected pace."
        )

    if tournament == "FIFA World Cup":
        why_parts.append(
            "World Cup matches show structurally different scoring patterns than club football — "
            "tournament-context priors weight historical international form heavily, "
            "and our model accounts for this."
        )
    elif tournament == "UCL":
        why_parts.append(
            "UCL knockout matches feature aggressive tactical setups and higher variance; "
            "our model is conservative on sample-thin Champions League data but "
            "fires when the divergence is meaningful."
        )

    why = " ".join(why_parts) if why_parts else (
        "The signal cleared our 3pp divergence threshold against the sharp benchmark."
    )

    # ── Caveat ──
    caveat = _build_caveat(market, edge_pp, tier, game_context)

    return {
        "headline": headline,
        "why":      why,
        "caveat":   caveat,
    }


def _explain_player_prop(
    signal: Dict[str, Any],
    historical_form: Optional[List[Dict[str, Any]]],
    club_form: Optional[List[Dict[str, Any]]],
    prior: Optional[Dict[str, Any]],
    player: Optional[str],
    edge_pp: Optional[float],
    tier: Optional[str],
    book: str, book_odds: Optional[float],
) -> Dict[str, str]:
    """Build the explanation for a goalscorer-anytime pick. This is where
    ACE genuinely differentiates — we surface the historical career
    g/90 and recent club form behind every player-prop pick."""
    odds_str = _fmt_odds(book_odds)
    edge_str = _fmt_pp(edge_pp)
    confidence = _confidence_phrase(tier, edge_pp)

    headline = f"{player or 'Player'} anytime scorer at {book} {odds_str} — {edge_str} {confidence}"

    why_parts: List[str] = []

    # Layer 1: our prior probability
    if prior:
        prior_prob = prior.get("anytime_scorer_prob")
        intl_uplift = prior.get("intl_uplift", 1.0)
        if prior_prob is not None:
            why_parts.append(
                f"Our model puts {player}'s scoring probability at {_fmt_pct(prior_prob)} — "
                f"the {book} price implies a lower likelihood, creating the {edge_str} gap."
            )
        if intl_uplift and intl_uplift != 1.0:
            direction = "elevates" if intl_uplift > 1.0 else "regresses"
            why_parts.append(
                f"Historical tournament uplift of {intl_uplift:.2f}× — {player} "
                f"{direction} in international play vs club rate."
            )

    # Layer 2: historical g/90 (the StatsBomb unique data)
    if historical_form:
        total_g = sum(r.get("goals", 0) or 0 for r in historical_form)
        total_min = sum(r.get("minutes", 0) or 0 for r in historical_form)
        comps = len(historical_form)
        if total_min >= 180:
            rate = total_g / (total_min / 90.0)
            comp_labels = ", ".join(sorted(set(r.get("competition", "?") for r in historical_form))[:3])
            why_parts.append(
                f"Career international form: {total_g} goals in {total_min} min "
                f"({rate:.2f} g/90) across {comps} tournament{'s' if comps != 1 else ''} "
                f"({comp_labels}{', …' if comps > 3 else ''})."
            )

    # Layer 3: recent club form
    if club_form:
        # Sort by season desc, take most recent
        recent = sorted(club_form, key=lambda r: r.get("season", 0), reverse=True)[:1]
        for r in recent:
            mins = r.get("minutes", 0) or 0
            goals = r.get("goals", 0) or 0
            if mins >= 270:
                rate = goals / (mins / 90.0)
                why_parts.append(
                    f"Recent club season: {goals} goals in {mins} min "
                    f"({rate:.2f} g/90) for {r.get('club_name', 'their club')}."
                )

    if not why_parts:
        why_parts.append(
            f"Our goalscorer prior flagged {player} as undervalued at {book} — "
            f"the implied probability is {edge_str} below our model's estimate."
        )

    why = " ".join(why_parts)

    # ── Caveat ──
    caveats: List[str] = []
    if not historical_form or sum(r.get("minutes", 0) or 0 for r in historical_form) < 540:
        caveats.append(
            "Limited international sample — fewer than 6 full matches of intl form on file."
        )
    if not prior or (prior.get("intl_uplift", 1.0) == 1.0):
        caveats.append("No historical-tournament uplift data — pure club-form prior.")
    if club_form is None:
        caveats.append("Club-season form context not loaded for this player.")
    if not caveats:
        caveats.append(
            "Player props are higher variance than game-level markets — "
            "Pinnacle typically doesn't post these, so soft-book divergence here is OUR prior vs the book, "
            "not vs a sharp anchor."
        )

    return {
        "headline": headline,
        "why":      why,
        "caveat":   " ".join(caveats),
    }


def _build_caveat(
    market: str, edge_pp: Optional[float], tier: Optional[str],
    game_context: Optional[Dict[str, Any]],
) -> str:
    """Honest caveats. Subscribers should know what could go wrong."""
    parts: List[str] = []

    if game_context:
        notes = game_context.get("notes", [])
        for n in notes[:2]:
            parts.append(n)

    if tier == "C" or (edge_pp is not None and edge_pp < 0.04):
        parts.append(
            "Edge is on the smaller end of our range — Pinnacle and soft "
            "book may converge before kickoff."
        )

    if not parts:
        parts.append(
            "Soft-book divergence edges typically run 1-3% ROI long-run. "
            "Bet sizing per Kelly recommendation; variance dominates short-term."
        )

    return " ".join(parts)


# ────────── Convenience: explain straight from a signal id ──────────

def explain_from_db(
    signal_id: int,
    sport: str = "soccer",
    path: Optional["Any"] = None,
) -> Dict[str, str]:
    """Pull a signal from the DB and explain it. Joins historical + club
    form + prior data when available. The high-level entry point for the
    /api/ops/explain endpoint."""
    import sqlite3
    from .signal_logger import DB_PATH

    if path is None:
        path = DB_PATH

    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        sig_row = conn.execute(
            "SELECT * FROM soccer_signals WHERE id = ?", (signal_id,)
        ).fetchone()
        if not sig_row:
            return {"headline": "Signal not found", "why": "", "caveat": ""}
        signal = dict(sig_row)

        historical_form: Optional[List[Dict[str, Any]]] = None
        club_form: Optional[List[Dict[str, Any]]] = None
        prior: Optional[Dict[str, Any]] = None

        # Player-prop joins
        player_name = signal.get("player_name")
        api_player_id = signal.get("api_player_id")
        if player_name:
            try:
                hist_rows = conn.execute(
                    "SELECT * FROM wc_historical_form WHERE player_name = ?",
                    (player_name,),
                ).fetchall()
                historical_form = [dict(r) for r in hist_rows]
            except Exception:
                pass
        if api_player_id:
            try:
                form_rows = conn.execute(
                    "SELECT * FROM wc_player_form WHERE api_player_id = ?",
                    (api_player_id,),
                ).fetchall()
                club_form = [dict(r) for r in form_rows]
            except Exception:
                pass
            try:
                from .players import compute_goalscorer_prior
                prior = compute_goalscorer_prior(api_player_id, path=path)
            except Exception:
                pass
    finally:
        conn.close()

    return explain_signal(signal, historical_form, club_form, prior)
