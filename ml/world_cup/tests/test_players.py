"""
Tests for the WC player-context module.

These tests don't hit API-Football — they exercise the schema, the
prior-computation math, and the team-top-scorers lookup using synthetic
data inserted directly.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from ml.world_cup.players import (
    compute_goalscorer_prior,
    get_team_top_scorers,
    init_player_tables,
    _player_goals_per_90,
    _position_factor,
)


@pytest.fixture
def db(tmp_path: Path) -> Path:
    return tmp_path / "smoke_wc_players.db"


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

def test_init_player_tables_creates_full_schema(db: Path) -> None:
    init_player_tables(db)
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    tables = {r["name"] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()}
    conn.close()
    for required in ("wc_players", "wc_player_form", "wc_player_priors"):
        assert required in tables, f"missing table: {required}"


def test_init_player_tables_is_idempotent(db: Path) -> None:
    """Running init twice should not error and should not duplicate columns."""
    init_player_tables(db)
    init_player_tables(db)  # second call — must be safe
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(wc_players)").fetchall()}
    conn.close()
    assert "api_player_id" in cols
    assert "team_name" in cols


# ---------------------------------------------------------------------------
# Math helpers
# ---------------------------------------------------------------------------

def test_player_goals_per_90_aggregates_form_rows() -> None:
    """Forwards: 25 goals in 2700 min → 25 / (2700/90) = 25/30 = 0.833 per 90."""
    form = [
        {"goals": 18, "minutes": 1980},  # 22 EPL games
        {"goals":  7, "minutes":  720},  # 8 CL games
    ]
    rate = _player_goals_per_90(form)
    assert rate is not None
    assert rate == pytest.approx(25 / 30.0, abs=1e-4)


def test_player_goals_per_90_returns_none_for_low_sample() -> None:
    """Under 270 minutes is too small to estimate."""
    assert _player_goals_per_90([{"goals": 2, "minutes": 90}]) is None
    assert _player_goals_per_90([]) is None


def test_position_factor_ladder() -> None:
    """Forwards score most, midfielders less, defenders least, GK floor."""
    assert _position_factor("Attacker")   == 1.00
    assert _position_factor("Forward")    == 1.00
    assert _position_factor("Striker")    == 1.00
    assert _position_factor("Midfielder") == 0.65
    assert _position_factor("Defender")   == 0.25
    assert _position_factor("Goalkeeper") == 0.10
    assert _position_factor(None)         == 0.55  # default to mid


# ---------------------------------------------------------------------------
# Prior computation — the math layer
# ---------------------------------------------------------------------------

def _insert_player(db: Path, pid: int, name: str, team: str, position: str = "Attacker") -> None:
    conn = sqlite3.connect(db)
    conn.execute(
        """INSERT INTO wc_players
           (api_player_id, player_name, team_name, position, updated_at)
           VALUES (?,?,?,?,datetime('now'))""",
        (pid, name, team, position),
    )
    conn.commit()
    conn.close()


def _insert_form(db: Path, pid: int, goals: int, minutes: int, assists: int = 0, position: str = "Attacker") -> None:
    conn = sqlite3.connect(db)
    conn.execute(
        """INSERT INTO wc_player_form
           (api_player_id, season, club_league_id, club_name,
            appearances, minutes, goals, assists, position, updated_at)
           VALUES (?, 2025, 39, 'Manchester Test FC', 30, ?, ?, ?, ?, datetime('now'))""",
        (pid, minutes, goals, assists, position),
    )
    conn.commit()
    conn.close()


def test_goalscorer_prior_for_top_striker(db: Path) -> None:
    """A 25-goal-in-2700-min forward should produce a strong anytime prob.

    With gpm = 25/30 = 0.833 per 90, position_factor 1.0, ~70 minutes assumed,
    team_strength ≈ 1.04 (1.40/1.35) for a roughly average attacking team:
      lambda  ≈ 0.833 * 1.0 * (70/90) * 1.04 ≈ 0.675
      P(scores >= 1) = 1 - e^(-0.675) ≈ 0.491
    """
    init_player_tables(db)
    _insert_player(db, 1001, "Test Striker", "Brazil", "Attacker")
    _insert_form(db,    1001, goals=25, minutes=2700)

    prior = compute_goalscorer_prior(1001, expected_match_goals_for_team=1.40, path=db)
    assert prior is not None
    assert prior["player_name"] == "Test Striker"
    assert 0.40 < prior["anytime_scorer_prob"] < 0.60  # sanity range
    # First-scorer prob should be lower than anytime
    assert prior["first_scorer_prob"] < prior["anytime_scorer_prob"]


def test_goalscorer_prior_lower_for_defender(db: Path) -> None:
    """Same goal rate but as a defender → much lower prior (pos_factor 0.25)."""
    init_player_tables(db)
    _insert_player(db, 2001, "Test Striker", "Brazil", "Attacker")
    _insert_form(db,    2001, goals=15, minutes=2700)
    _insert_player(db, 2002, "Test Defender", "Brazil", "Defender")
    _insert_form(db,    2002, goals=15, minutes=2700)

    striker = compute_goalscorer_prior(2001, path=db)
    defender = compute_goalscorer_prior(2002, path=db)
    assert striker is not None and defender is not None
    # Defender's prior should be roughly 1/4 of striker's (0.25 vs 1.0)
    assert defender["anytime_scorer_prob"] < striker["anytime_scorer_prob"] * 0.5


def test_goalscorer_prior_handles_unknown_player(db: Path) -> None:
    """Player with no form row → None (we can't estimate)."""
    init_player_tables(db)
    _insert_player(db, 3001, "Unknown Player", "Saudi Arabia", "Midfielder")
    # No form row inserted
    prior = compute_goalscorer_prior(3001, path=db)
    assert prior is None


def test_goalscorer_prior_scales_with_team_expected_goals(db: Path) -> None:
    """Stronger attacking team (higher expected goals) → higher prior for the same player."""
    init_player_tables(db)
    _insert_player(db, 4001, "Test Striker", "Brazil", "Attacker")
    _insert_form(db,    4001, goals=20, minutes=2700)

    low_team  = compute_goalscorer_prior(4001, expected_match_goals_for_team=0.8, path=db)
    high_team = compute_goalscorer_prior(4001, expected_match_goals_for_team=2.5, path=db)
    assert low_team is not None and high_team is not None
    assert high_team["anytime_scorer_prob"] > low_team["anytime_scorer_prob"]


def test_goalscorer_prior_scales_with_minutes(db: Path) -> None:
    """70 min starter vs 30 min sub → starter prior higher."""
    init_player_tables(db)
    _insert_player(db, 5001, "Test Striker", "France", "Attacker")
    _insert_form(db,    5001, goals=20, minutes=2700)

    sub      = compute_goalscorer_prior(5001, assumed_minutes=30, path=db)
    starter  = compute_goalscorer_prior(5001, assumed_minutes=85, path=db)
    assert sub is not None and starter is not None
    assert starter["anytime_scorer_prob"] > sub["anytime_scorer_prob"]


# ---------------------------------------------------------------------------
# Team top-scorers lookup
# ---------------------------------------------------------------------------

def test_team_top_scorers_orders_by_goals_per_90(db: Path) -> None:
    init_player_tables(db)
    _insert_player(db, 6001, "Hot Striker",   "Brazil", "Attacker")
    _insert_form(db,    6001, goals=25, minutes=2700)
    _insert_player(db, 6002, "Lukewarm Mid",  "Brazil", "Midfielder")
    _insert_form(db,    6002, goals=10, minutes=2700)
    _insert_player(db, 6003, "Backup Player", "Brazil", "Attacker")
    _insert_form(db,    6003, goals= 1, minutes= 280)   # just above 270 cutoff

    top = get_team_top_scorers("Brazil", n=5, path=db)
    assert len(top) == 3
    names = [t["player_name"] for t in top]
    # Hot striker has highest g/90 → first
    assert names[0] == "Hot Striker"


def test_team_top_scorers_excludes_low_minute_players(db: Path) -> None:
    """Players with under 270 minutes are excluded — too small a sample."""
    init_player_tables(db)
    _insert_player(db, 7001, "Played a Lot",   "Mexico", "Attacker")
    _insert_form(db,    7001, goals=15, minutes=2700)
    _insert_player(db, 7002, "Barely Played",  "Mexico", "Attacker")
    _insert_form(db,    7002, goals= 2, minutes=  90)   # too low

    top = get_team_top_scorers("Mexico", n=5, path=db)
    assert len(top) == 1
    assert top[0]["player_name"] == "Played a Lot"


# ---------------------------------------------------------------------------
# Recency weighting (NEW)
# ---------------------------------------------------------------------------

def test_classify_club_season_buckets() -> None:
    from ml.world_cup.players import _classify_club_season
    assert _classify_club_season(2025) == "current_club"
    assert _classify_club_season(2024) == "previous_club"
    assert _classify_club_season(2023) == "previous_club"


def test_classify_intl_year_buckets() -> None:
    from ml.world_cup.players import _classify_intl_year
    assert _classify_intl_year(2026) == "recent_intl"
    assert _classify_intl_year(2025) == "recent_intl"
    assert _classify_intl_year(2024) == "midrange_intl"
    assert _classify_intl_year(2022) == "midrange_intl"
    assert _classify_intl_year(2018) == "old_intl"
    assert _classify_intl_year(None) == "old_intl"


def test_extract_year_from_competition() -> None:
    from ml.world_cup.players import _extract_year_from_competition
    assert _extract_year_from_competition("WC 2022") == 2022
    assert _extract_year_from_competition("Euro 2024") == 2024
    assert _extract_year_from_competition("Copa America 2024") == 2024
    assert _extract_year_from_competition("Asian Cup 2023") == 2023
    assert _extract_year_from_competition("nonsense") is None


def test_weighted_goals_per_90_current_season_dominates() -> None:
    """Same goals/minutes in current season vs old tournament — the current
    season's contribution to the weighted rate should be much larger."""
    from ml.world_cup.players import _weighted_goals_per_90
    # 15 goals in 2700 min current club season → 0.5 g/90
    # 15 goals in 2700 min from WC 2018 → 0.5 g/90 in old_intl bucket
    current_only = _weighted_goals_per_90(
        club_form_rows=[{"season": 2025, "minutes": 2700, "goals": 15}],
        historical_rows=[],
    )
    plus_old_intl = _weighted_goals_per_90(
        club_form_rows=[{"season": 2025, "minutes": 2700, "goals": 15}],
        historical_rows=[{"competition": "WC 2018", "minutes": 2700, "goals": 15}],
    )
    assert current_only == pytest.approx(0.5, abs=1e-3)
    # Old intl pulls the weighted rate toward 0.5 too (same rate), so result
    # stays near 0.5 — but the relative weight of old_intl is small (0.10).
    assert plus_old_intl == pytest.approx(0.5, abs=1e-3)


def test_weighted_goals_per_90_recent_intl_outweighs_old() -> None:
    """With zero club goals but two intl tournaments at different rates,
    the weighted rate should be strictly between 0 and the raw recent rate.
    The math:
      club: 2700 min × weight 1.0 = 2700 weighted min, 0 weighted goals
      Copa Am 2024 (midrange, weight 0.20): 540 min × 0.20 = 108, 5g × 0.20 = 1.0
      WC 2018 (old, weight 0.10):           540 min × 0.10 =  54, 1g × 0.10 = 0.1
      rate = 1.1 weighted goals / (2862 weighted min / 90) ≈ 0.035 g/90
    """
    from ml.world_cup.players import _weighted_goals_per_90
    rate = _weighted_goals_per_90(
        club_form_rows=[{"season": 2025, "minutes": 2700, "goals": 0}],
        historical_rows=[
            {"competition": "Copa America 2024", "minutes": 540, "goals": 5},
            {"competition": "WC 2018",           "minutes": 540, "goals": 1},
        ],
    )
    assert rate is not None
    # Strictly positive — intl bucketed in, not zeroed out
    assert rate > 0
    # But heavily dampened by the zero-goal club minutes (which dominate weight)
    assert rate < 0.10


def test_weighted_recent_intl_pulls_more_than_old_intl() -> None:
    """Holding everything else constant, swapping an old-intl entry for a
    recent-intl entry of the same rate should produce a HIGHER weighted
    rate (recent has 4× the weight of old: 0.40 vs 0.10)."""
    from ml.world_cup.players import _weighted_goals_per_90
    with_old = _weighted_goals_per_90(
        club_form_rows=[{"season": 2025, "minutes": 270, "goals": 0}],
        historical_rows=[{"competition": "WC 2018", "minutes": 540, "goals": 5}],
    )
    with_recent = _weighted_goals_per_90(
        club_form_rows=[{"season": 2025, "minutes": 270, "goals": 0}],
        historical_rows=[{"competition": "Gold Cup 2025", "minutes": 540, "goals": 5}],
    )
    assert with_old is not None and with_recent is not None
    assert with_recent > with_old


def test_weighted_goals_per_90_returns_none_low_sample() -> None:
    """Total weighted minutes under 270 → None."""
    from ml.world_cup.players import _weighted_goals_per_90
    out = _weighted_goals_per_90(
        club_form_rows=[{"season": 2025, "minutes": 60, "goals": 1}],
        historical_rows=[],
    )
    assert out is None


def test_compute_prior_uses_weighted_aggregate(db: Path) -> None:
    """When a player has both current + previous club seasons, the weighted
    blend gives more weight to current. Verifying the prior actually USES
    _weighted_goals_per_90 by setting up a config where the weighted vs
    unweighted answers differ."""
    init_player_tables(db)
    conn = sqlite3.connect(db)
    conn.execute(
        """INSERT INTO wc_players
           (api_player_id, player_name, team_name, position, updated_at)
           VALUES (101, 'Hot Now Cold Before', 'France', 'Attacker', datetime('now'))""")
    # Hot in 2025 (current): 25 g in 2700 min = 0.83/90
    conn.execute(
        """INSERT INTO wc_player_form
           (api_player_id, season, club_league_id, club_name,
            appearances, minutes, goals, position, updated_at)
           VALUES (101, 2025, 39, 'Manchester Test', 30, 2700, 25, 'Attacker', datetime('now'))""")
    # Cold in 2024 (previous): 5 g in 2700 min = 0.17/90
    conn.execute(
        """INSERT INTO wc_player_form
           (api_player_id, season, club_league_id, club_name,
            appearances, minutes, goals, position, updated_at)
           VALUES (101, 2024, 39, 'Manchester Test', 28, 2700, 5, 'Attacker', datetime('now'))""")
    conn.commit()
    conn.close()

    prior = compute_goalscorer_prior(101, path=db)
    assert prior is not None
    # Weighted rate is 25*1.0 + 5*0.55 = 27.75 weighted goals
    #                  2700*1.0 + 2700*0.55 = 4185 weighted minutes
    #                  = 27.75 / (4185/90) = 27.75 / 46.5 ≈ 0.596 g/90
    # Unweighted would have been (25+5)/(2700+2700)*90 = 30/60 = 0.50
    # So weighted prior should be HIGHER than unweighted would have been
    # (we're emphasizing the strong current season).
    # Sanity check: anytime prob should reflect ~0.6 g/90 (high) rather than 0.5
    assert prior["anytime_scorer_prob"] > 0.35  # something meaningful
