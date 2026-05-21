"""
Tests for the AI Pick Explainer.

These tests don't validate prose quality (that's subjective and we'd
spend more time tweaking than benefiting). They validate the structure:
  - Headline format includes bet label + book + odds + edge
  - "Why" section references actual data we joined in (historical g/90,
    club form, prior probability)
  - Caveats are honest (mentions limitations when sample is thin)
  - Different market types route to the right narrative
"""
from __future__ import annotations

from typing import Any, Dict, List


def _sig(**kwargs: Any) -> Dict[str, Any]:
    """Build a signal dict for testing."""
    base: Dict[str, Any] = {
        "market":          "h2h",
        "bet_side":        "home",
        "home_team":       "France",
        "away_team":       "Argentina",
        "book":            "fanduel",
        "book_odds":       +130,
        "book_prob":       0.43,
        "pinnacle_prob":   0.48,
        "edge_pp":         0.05,
        "confidence_tier": "A",
        "tournament":      "FIFA World Cup",
    }
    base.update(kwargs)
    return base


# ─── Headline format ─────────────────────────────────────────────────────────

def test_headline_h2h_home_includes_team_name() -> None:
    from ml.world_cup.pick_explainer import explain_signal
    out = explain_signal(_sig(market="h2h", bet_side="home", home_team="France"))
    assert "France" in out["headline"]
    assert "fanduel" in out["headline"].lower()
    assert "+130" in out["headline"]
    assert "5.0pp" in out["headline"] or "+5.0pp" in out["headline"]


def test_headline_totals_uses_line() -> None:
    from ml.world_cup.pick_explainer import explain_signal
    out = explain_signal(_sig(market="totals", bet_side="over", total_line=2.5))
    assert "Over 2.5 goals" in out["headline"]


def test_headline_player_prop_uses_player_name() -> None:
    from ml.world_cup.pick_explainer import explain_signal
    out = explain_signal(_sig(
        market="player_goal_scorer_anytime", bet_side="yes",
        player_name="Kylian Mbappe", book_odds=+150,
        # Player props don't carry pin_prob (no Pinnacle anchor)
        pinnacle_prob=None, book_prob=0.40, edge_pp=0.20,
    ))
    assert "Kylian Mbappe" in out["headline"]
    assert "anytime scorer" in out["headline"].lower()


def test_headline_asian_handicap_includes_team_and_line() -> None:
    from ml.world_cup.pick_explainer import explain_signal
    out = explain_signal(_sig(market="asian_handicap", bet_side="away",
                              total_line=-0.5, away_team="Argentina"))
    assert "Argentina" in out["headline"]
    assert "-0.5" in out["headline"]


# ─── Why section uses our data ───────────────────────────────────────────────

def test_why_references_pinnacle_vs_softbook_gap() -> None:
    from ml.world_cup.pick_explainer import explain_signal
    out = explain_signal(_sig())
    assert "Pinnacle" in out["why"]
    assert "fanduel" in out["why"].lower() or "FanDuel" in out["why"]
    assert "48.0%" in out["why"] or "48%" in out["why"]  # the pin_prob


def test_why_player_prop_uses_historical_data() -> None:
    """Player-prop explainer must surface the StatsBomb historical g/90 —
    that's THE differentiator competitors don't have."""
    from ml.world_cup.pick_explainer import explain_signal
    sig = _sig(
        market="player_goal_scorer_anytime", bet_side="yes",
        player_name="Kylian Mbappe", book_odds=+150,
        pinnacle_prob=None, book_prob=0.40, edge_pp=0.20,
    )
    historical = [
        {"competition": "WC 2018", "goals": 4, "minutes": 550,  "matches_played": 7},
        {"competition": "WC 2022", "goals": 8, "minutes": 603,  "matches_played": 7},
        {"competition": "Euro 2024", "goals": 1, "minutes": 557, "matches_played": 6},
    ]
    club_form = [
        {"season": 2025, "minutes": 2800, "goals": 28, "club_name": "Real Madrid"},
    ]
    prior = {
        "anytime_scorer_prob": 0.60,
        "intl_uplift":         1.18,
        "player_name":         "Kylian Mbappe",
    }
    out = explain_signal(sig, historical_form=historical, club_form=club_form, prior=prior)
    # Career international form should appear
    assert "13 goals" in out["why"]  # 4 + 8 + 1
    assert "1710" in out["why"] or "g/90" in out["why"]
    # Should also mention club season
    assert "28 goals" in out["why"] or "Real Madrid" in out["why"]
    # Should mention intl uplift since != 1.0
    assert "1.18" in out["why"] or "uplift" in out["why"].lower() or "international" in out["why"].lower()


def test_why_falls_back_gracefully_without_joined_data() -> None:
    """Without historical / club / prior joined, the explainer still works —
    just less rich. Important for the early days when joins are sparse."""
    from ml.world_cup.pick_explainer import explain_signal
    out = explain_signal(_sig(
        market="player_goal_scorer_anytime", bet_side="yes",
        player_name="Some Player", pinnacle_prob=None, book_prob=0.40, edge_pp=0.05,
    ))
    assert out["why"]
    assert "Some Player" in out["headline"]


# ─── Caveats are honest ──────────────────────────────────────────────────────

def test_caveat_warns_on_thin_intl_sample() -> None:
    """When a player has fewer than 540 min of intl history, the caveat
    should call that out — we don't want to oversell a thin sample."""
    from ml.world_cup.pick_explainer import explain_signal
    sig = _sig(
        market="player_goal_scorer_anytime", bet_side="yes",
        player_name="Young Player", pinnacle_prob=None, book_prob=0.40, edge_pp=0.10,
    )
    historical = [{"competition": "Euro 2024", "goals": 2, "minutes": 270, "matches_played": 3}]
    out = explain_signal(sig, historical_form=historical)
    assert "limited" in out["caveat"].lower() or "thin" in out["caveat"].lower() or "fewer" in out["caveat"].lower()


def test_caveat_mentions_dead_rubber_context_when_provided() -> None:
    """When game_context flags a dead rubber, surface that as a caveat —
    teams rest starters and the line may move significantly."""
    from ml.world_cup.pick_explainer import explain_signal
    out = explain_signal(_sig(), game_context={"notes": ["DEAD RUBBER — both teams qualified"]})
    assert "DEAD RUBBER" in out["caveat"] or "dead rubber" in out["caveat"].lower()


def test_caveat_warns_on_low_edge() -> None:
    """C-tier picks should have a humility caveat — the edge is real but small."""
    from ml.world_cup.pick_explainer import explain_signal
    out = explain_signal(_sig(edge_pp=0.032, confidence_tier="C"))
    # The C-tier path mentions converge / smaller / variance
    text = out["caveat"].lower()
    assert "converge" in text or "smaller" in text or "modest" in text or "variance" in text or "soft-book" in text


# ─── Confidence phrase mapping ───────────────────────────────────────────────

def test_strong_edge_strong_label() -> None:
    from ml.world_cup.pick_explainer import explain_signal
    out = explain_signal(_sig(edge_pp=0.07, confidence_tier="A"))
    assert "strong" in out["headline"].lower()


def test_modest_edge_modest_label() -> None:
    from ml.world_cup.pick_explainer import explain_signal
    out = explain_signal(_sig(edge_pp=0.032, confidence_tier="C"))
    assert "modest" in out["headline"].lower()


# ─── Tournament-specific narrative ───────────────────────────────────────────

def test_wc_tournament_adds_context() -> None:
    """WC matches get a sentence about tournament-context priors —
    surfaces our unique StatsBomb work."""
    from ml.world_cup.pick_explainer import explain_signal
    out = explain_signal(_sig(tournament="FIFA World Cup"))
    assert "tournament" in out["why"].lower() or "world cup" in out["why"].lower()


def test_ucl_tournament_adds_context() -> None:
    from ml.world_cup.pick_explainer import explain_signal
    out = explain_signal(_sig(tournament="UCL"))
    assert "UCL" in out["why"] or "Champions League" in out["why"]


# ─── Return structure ────────────────────────────────────────────────────────

def test_returns_three_keys_always() -> None:
    """Every signal type must return {headline, why, caveat}. The frontend
    relies on this contract."""
    from ml.world_cup.pick_explainer import explain_signal
    for market in ("h2h", "totals", "asian_handicap", "spreads",
                   "player_goal_scorer_anytime", "run_line"):
        out = explain_signal(_sig(market=market, bet_side="home", player_name="Test Player"))
        assert set(out.keys()) == {"headline", "why", "caveat"}
        assert out["headline"]   # non-empty
        assert out["why"]
        assert out["caveat"]
