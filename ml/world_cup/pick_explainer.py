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
    """Build the explanation for h2h / totals / spreads / run_line / AH.

    Narrative anatomy (subscriber-grade, not statistical filler):
      1. Lead with the BET — what to take, at the BEST price.
      2. Form context — both teams' recent results from free FBref-equivalent
         data. The "why this team wins" part subscribers actually care about.
      3. Best price + alternative books — actionable. Where to bet.
      4. Edge math — supporting, not headline. (One sentence, not a paragraph.)
      5. Caveat — honest risk callouts. Heavy fav warning, form variance, etc.
    """
    bet = _bet_label(market, bet_side, line, home, away)

    # Pull book_offers + best price from the signal (added in the multi-book
    # transparency pass). Falls back to the triggering soft book for older
    # signals where book_offers is NULL.
    offers = _parse_offers(signal.get("book_offers"))
    # Filter out Pinnacle — US retail can't bet there, so it's noise.
    showable = [o for o in offers if o.get("book") != "pinnacle"]
    best       = showable[0] if showable else None
    best_book  = best["book"] if best else book
    best_odds  = best["odds"] if best else book_odds
    alt_books  = showable[1:4]

    odds_str = _fmt_odds(best_odds)

    # Headline: lead with the bet, name the book at the best price.
    headline = f"{bet} {odds_str} at {_book_nice(best_book)}"
    if alt_books:
        headline += f" — also live at {len(alt_books)} other book{'s' if len(alt_books) != 1 else ''}"

    # ── Form context (the real "why this team wins") ──
    why_parts: List[str] = []
    game_date = signal.get("game_date")

    home_summary = _form_summary_safe(home, n=5, before_date=game_date)
    away_summary = _form_summary_safe(away, n=5, before_date=game_date)

    # Specific home/away splits when we're on h2h or asian_handicap
    if market in ("h2h", "asian_handicap"):
        home_home = _form_summary_safe(home, n=5, before_date=game_date, venue="home")
        away_away = _form_summary_safe(away, n=5, before_date=game_date, venue="away")
        home_used = home_home if home_home["n"] >= 3 else home_summary
        away_used = away_away if away_away["n"] >= 3 else away_summary
        home_qual = " at home" if home_used is home_home else " overall"
        away_qual = " on the road" if away_used is away_away else " overall"
    else:
        home_used, away_used = home_summary, away_summary
        home_qual = away_qual = " last 5"

    if home_used["n"] > 0:
        why_parts.append(
            f"{home}{home_qual}: {home_used['record']}, "
            f"{home_used['gf']} scored / {home_used['ga']} conceded."
        )
    if away_used["n"] > 0:
        why_parts.append(
            f"{away}{away_qual}: {away_used['record']}, "
            f"{away_used['gf']} scored / {away_used['ga']} conceded."
        )

    # Form-derived takeaway — only when we have data for both sides AND the
    # imbalance is large enough to be meaningful (not just a noisy 5-game blip).
    if home_used["n"] >= 3 and away_used["n"] >= 3:
        takeaway = _form_takeaway(bet_side, market, home, away, home_used, away_used)
        if takeaway:
            why_parts.append(takeaway)

    # H2H history — pulls last 5 meetings between these specific teams across
    # the seasons we have ingested. Only added when:
    #   - We have at least 2 prior meetings (1-game H2H is meaningless noise)
    #   - The H2H signal aligns with the bet OR is notably one-sided
    if market in ("h2h", "asian_handicap"):
        h2h_line = _h2h_takeaway(home, away, game_date, bet_side, market)
        if h2h_line:
            why_parts.append(h2h_line)

    # ── Best price call-out ──
    if best and alt_books:
        alt_str = ", ".join(f"{_book_nice(o['book'])} {_fmt_odds(o['odds'])}" for o in alt_books)
        why_parts.append(
            f"Take {_book_nice(best_book)} at {odds_str} — also {alt_str}."
        )

    # ── Supporting edge math (one sentence, not the lead) ──
    if pin_prob is not None and book_prob is not None:
        edge_str = _fmt_pp(edge_pp)
        why_parts.append(
            f"Model edge: Pinnacle de-vigs {bet_side} to {_fmt_pct(pin_prob)}; "
            f"best soft-book price implies {_fmt_pct(book_prob)} ({edge_str} gap)."
        )

    why = " ".join(why_parts) if why_parts else (
        "Sharp-book line meaningfully different from soft-book consensus — "
        "value detected without enough team context to narrate."
    )

    # ── Caveat ──
    caveat = _build_caveat_v2(
        market, bet_side, best_odds, edge_pp, tier, game_context,
        home_used, away_used,
    )

    return {"headline": headline, "why": why, "caveat": caveat}


# ────────── Form / book helpers used by the rewritten game-level path ──────────

def _parse_offers(raw: Any) -> List[Dict[str, Any]]:
    """book_offers is stored as a JSON string; parse it lazily."""
    if not raw:
        return []
    if isinstance(raw, list):
        return raw  # already parsed
    if isinstance(raw, str):
        try:
            import json as _json
            v = _json.loads(raw)
            return v if isinstance(v, list) else []
        except Exception:
            return []
    return []


_BOOK_NAMES: Dict[str, str] = {
    "fanduel":       "FanDuel",
    "draftkings":    "DraftKings",
    "betmgm":        "BetMGM",
    "betrivers":     "BetRivers",
    "williamhill_us":"Caesars",
    "pointsbet_us":  "PointsBet",
    "pinnacle":      "Pinnacle",
}


def _book_nice(key: Optional[str]) -> str:
    if not key:
        return "—"
    return _BOOK_NAMES.get(key, key.capitalize())


def _form_summary_safe(
    team: str, n: int, before_date: Optional[str],
    venue: Optional[str] = None,
) -> Dict[str, Any]:
    """Load + summarize team form, returning the empty-summary shape on any
    failure so the explainer never crashes when the form ingestor hasn't
    synced yet."""
    try:
        from ml.soccer.form import get_recent_form, summarize_form  # type: ignore
        rows = get_recent_form(team, n=n, before_date=before_date, venue=venue)
        return summarize_form(rows)
    except Exception:
        return {"record": "—", "n": 0, "gf": 0, "ga": 0, "xg_for": None, "xg_against": None}


def _h2h_takeaway(
    home: str, away: str, before_date: Optional[str],
    bet_side: str, market: str,
) -> Optional[str]:
    """Compose a one-line H2H sentence — when the data actually supports
    saying something. Skips silently when:
      - We have <2 prior meetings (noise)
      - The H2H record is genuinely balanced (1W-0D-1L, no story)
    """
    try:
        from ml.soccer.form import get_h2h, summarize_h2h  # type: ignore
        # From home team's perspective
        rows = get_h2h(home, away, n=5, before_date=before_date)
        sm = summarize_h2h(rows, home, away)
    except Exception:
        return None

    if sm["n"] < 2:
        return None

    # Parse the record into separate W/D/L counts
    try:
        w_s, d_s, l_s = sm["record"].split("-")
        w = int(w_s.rstrip("W")); d = int(d_s.rstrip("D")); l = int(l_s.rstrip("L"))
    except (ValueError, AttributeError):
        return None

    # Skip when neither team meaningfully leads
    if abs(w - l) < 2 and abs(sm["goal_diff"]) < 3:
        return None

    diff_sign = "+" if sm["goal_diff"] > 0 else ""
    home_leads = w > l
    record_label = f"{home} {sm['record']}" if home_leads else f"{away} {l}W-{d}D-{w}L"

    # Tailor the framing to which side we're betting
    if market == "h2h":
        if bet_side == "home":
            if home_leads:
                return (
                    f"Last {sm['n']} H2H: {record_label}, "
                    f"{diff_sign}{sm['goal_diff']} goal differential — "
                    f"history supports the side."
                )
            return (
                f"Last {sm['n']} H2H: {record_label} — "
                f"history runs the other way, edge has to overcome that."
            )
        if bet_side == "away":
            if not home_leads:
                return (
                    f"Last {sm['n']} H2H: {record_label} — history supports the side."
                )
            return (
                f"Last {sm['n']} H2H: {record_label} — "
                f"history runs the other way."
            )
        # draw
        return f"Last {sm['n']} H2H: {record_label}."

    # asian_handicap path — just surface the H2H record neutrally
    return f"Last {sm['n']} H2H: {record_label}, {diff_sign}{sm['goal_diff']} GD."


def _form_takeaway(
    bet_side: str, market: str,
    home: str, away: str,
    home_used: Dict[str, Any], away_used: Dict[str, Any],
) -> Optional[str]:
    """One-sentence narrative when the form picture actually supports the bet.
    Returns None when the data is too neutral to add anything.

    Looks at net goal differential (GF - GA) over the sample. A team running
    +5 vs the other at -3 is a real form gap worth highlighting; +1 vs 0 is
    noise, skipped.
    """
    h_diff = (home_used["gf"] or 0) - (home_used["ga"] or 0)
    a_diff = (away_used["gf"] or 0) - (away_used["ga"] or 0)
    gap = h_diff - a_diff

    if abs(gap) < 4:
        return None  # form too close to draw a conclusion from 5-game sample

    # Which side has the form advantage?
    stronger = home if gap > 0 else away
    weaker   = away if gap > 0 else home

    if market == "h2h":
        if (bet_side == "home" and gap > 0) or (bet_side == "away" and gap < 0):
            return f"Recent form lines up with the bet — {stronger} markedly outperforming {weaker} on goal differential."
        if (bet_side == "home" and gap < 0) or (bet_side == "away" and gap > 0):
            return (
                f"Form points the other way — {stronger} has been the stronger side recently. "
                f"The model still likes this because the price gap exceeds the form gap."
            )
        # bet_side == "draw"
        return f"Form: {stronger} clearly ahead of {weaker}. Draw value comes from market overpricing the favorite."

    if market in ("asian_handicap", "spreads"):
        if (bet_side == "home" and gap > 0) or (bet_side == "away" and gap < 0):
            return f"Recent form supports the spread — {stronger} on the right side of goal differential."
        return None

    if market == "totals":
        # Goals scored is what matters here, not net diff
        total_recent = (home_used["gf"] or 0) + (away_used["gf"] or 0) + \
                       (home_used["ga"] or 0) + (away_used["ga"] or 0)
        n_total = (home_used["n"] or 0) + (away_used["n"] or 0)
        if n_total > 0:
            per_game = total_recent / n_total
            return f"Combined recent goal pace: {per_game:.1f} per game across both sides' last {n_total // 2} matches."
        return None

    return None


def _build_caveat_v2(
    market: str, bet_side: str,
    best_odds: Optional[float], edge_pp: Optional[float],
    tier: Optional[str], game_context: Optional[Dict[str, Any]],
    home_used: Dict[str, Any], away_used: Dict[str, Any],
) -> str:
    """Honest caveats with real teeth, not boilerplate."""
    parts: List[str] = []

    # Game-context warnings (dead rubber, etc.) come first when present
    if game_context:
        notes = game_context.get("notes", [])
        for n in notes[:2]:
            parts.append(str(n))

    # Heavy-favorite warning — single most important honest callout
    if best_odds is not None and best_odds <= -250:
        risk = abs(int(best_odds))
        parts.append(
            f"Heavy favorite — laying ${risk} to win $100. Even at +EV, a single "
            f"loss costs {risk/100:.1f} units of upside. Size accordingly or "
            f"consider parlaying with another A-tier favorite."
        )
    elif best_odds is not None and best_odds <= -150:
        parts.append("Favorite is priced -150 or shorter — modest payout for the risk; size matters more than usual.")

    # Form sample warning
    if (home_used.get("n", 0) < 3) or (away_used.get("n", 0) < 3):
        parts.append("Recent-form sample is thin (<3 matches per side) — narrative weight should be lower than the numbers suggest.")

    # Small-edge warning
    if tier == "C" or (edge_pp is not None and edge_pp < 0.04):
        parts.append("Edge sits at the smaller end of the range — soft and sharp books may converge before kickoff.")

    if not parts:
        parts.append("Soccer game-level edges tend to run 1-3% ROI long-run; variance dominates over sub-50-pick samples.")

    return " ".join(parts)


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
