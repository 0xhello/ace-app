"""
Tests for the Understat xG prior adjustment (M9).

Targets _xg_prior_adjustment in ml/soccer/model.py. Verifies the function:
  - reads from soccer_source_team_match_stats correctly
  - maps DC league names to Understat conventions
  - resolves team names across providers
  - returns calibrated alpha/delta multipliers
  - respects the before_date leakage gate
  - is exposed via predict_match's _adj transparency block
"""
from __future__ import annotations

import sqlite3

import pytest

from ml.soccer.model import (
    _xg_prior_adjustment,
    _UNDERSTAT_LEAGUE_MAP,
    XG_ADJ_MIN, XG_ADJ_MAX, XG_MIN_MATCHES,
    predict_match,
    DCFit,
)


@pytest.fixture
def db_with_xg(tmp_path):
    """Temp DB with Understat source schema + stubs for other tables."""
    db = tmp_path / "test.db"
    conn = sqlite3.connect(str(db))
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE soccer_source_team_match_stats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            provider TEXT, league TEXT, season TEXT,
            game_id TEXT, match_date TEXT,
            team TEXT, opponent TEXT, venue TEXT,
            goals_for REAL, goals_against REAL,
            xg_for REAL, xg_against REAL,
            np_xg_for REAL, ppda REAL, deep_completions REAL,
            updated_at TEXT DEFAULT (datetime('now'))
        );
        -- Stub tables needed by predict_match's other adjustments
        CREATE TABLE soccer_team_form (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            team_name TEXT, opponent TEXT, league TEXT, venue TEXT,
            match_date DATE, goals_for INTEGER, goals_against INTEGER,
            sot INTEGER, sot_against INTEGER, shots INTEGER,
            shots_against INTEGER, corners INTEGER, corners_against INTEGER,
            fouls INTEGER, fouls_against INTEGER, yellows INTEGER,
            yellows_against INTEGER, reds INTEGER, reds_against INTEGER,
            referee TEXT
        );
        CREATE TABLE soccer_player_feature_snapshot (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            team TEXT, opponent TEXT, player_name TEXT,
            lineup_status TEXT, position_bucket TEXT,
            is_attacking_role INTEGER, attack_role_score REAL,
            projected_minutes REAL, unavailable_reason TEXT,
            updated_at TEXT DEFAULT (datetime('now'))
        );
    """)
    conn.commit()
    yield db, conn
    conn.close()


def _insert_xg(conn, team, league, opp, gf, ga, xgf, xga,
               match_date="2026-05-10T15:00:00"):
    conn.execute(
        """INSERT INTO soccer_source_team_match_stats
           (provider, league, season, team, opponent, venue,
            goals_for, goals_against, xg_for, xg_against, np_xg_for,
            match_date)
           VALUES ('soccerdata:understat', ?, '2526', ?, ?, 'home',
                   ?, ?, ?, ?, ?, ?)""",
        (league, team, opp, gf, ga, xgf, xga, xgf, match_date),
    )
    conn.commit()


# ── Direct adjustment cases ──────────────────────────────────────────────────

def test_no_xg_data_is_noop(db_with_xg):
    """When team has no Understat rows, both multipliers stay at 1.0."""
    _db, conn = db_with_xg
    alpha, delta, trace = _xg_prior_adjustment("UnknownFC", "Premier League", conn)
    assert alpha == 1.0
    assert delta == 1.0
    assert trace.get("reason") == "team-not-in-understat"


def test_unmapped_league_is_noop(db_with_xg):
    """When league isn't in the Understat map, no-op."""
    _db, conn = db_with_xg
    alpha, delta, trace = _xg_prior_adjustment("AnyTeam", "Eredivisie", conn)
    assert alpha == 1.0
    assert delta == 1.0
    assert trace.get("reason") == "league-not-in-understat-map"


def test_insufficient_matches_is_noop(db_with_xg):
    """A team with fewer than XG_MIN_MATCHES of Understat history no-ops."""
    _db, conn = db_with_xg
    for i in range(XG_MIN_MATCHES - 1):
        _insert_xg(conn, "ThinSample", "ENG-Premier League", f"Opp{i}",
                   gf=1, ga=1, xgf=1.0, xga=1.0,
                   match_date=f"2026-05-{i+1:02d}T15:00:00")
    alpha, delta, trace = _xg_prior_adjustment("ThinSample", "Premier League", conn)
    assert alpha == 1.0
    assert delta == 1.0
    assert trace.get("reason") == "insufficient-xg-history"


def test_unlucky_attacker_bumps_alpha(db_with_xg):
    """Team consistently outshooting their goals (high xG, low goals) →
    alpha_mult > 1.0 (regression upward expected)."""
    _db, conn = db_with_xg
    for i in range(10):
        _insert_xg(conn, "Unlucky", "ENG-Premier League", f"Opp{i}",
                   gf=0.5, ga=1.0, xgf=2.0, xga=1.0,  # xg_for >> goals_for
                   match_date=f"2026-05-{i+1:02d}T15:00:00")
    # Add other teams for league baseline
    for i in range(20):
        _insert_xg(conn, f"AvgTeam{i}", "ENG-Premier League", "X",
                   gf=1.4, ga=1.4, xgf=1.4, xga=1.4,
                   match_date="2026-05-01T15:00:00")
    alpha, delta, trace = _xg_prior_adjustment("Unlucky", "Premier League", conn)
    assert alpha > 1.0
    assert alpha == pytest.approx(XG_ADJ_MAX, abs=0.001)  # sqrt(2.0/0.5) = 2.0 → clamped to 1.15
    assert trace["team"] == "Unlucky"


def test_hot_finisher_drags_alpha_down(db_with_xg):
    """Team scoring above their xG (lucky finishing) → alpha_mult < 1.0
    (regression downward)."""
    _db, conn = db_with_xg
    for i in range(10):
        _insert_xg(conn, "HotStreak", "ENG-Premier League", f"Opp{i}",
                   gf=2.0, ga=1.0, xgf=1.0, xga=1.0,  # goals_for >> xg_for
                   match_date=f"2026-05-{i+1:02d}T15:00:00")
    alpha, delta, _ = _xg_prior_adjustment("HotStreak", "Premier League", conn)
    assert alpha < 1.0
    assert alpha == pytest.approx(XG_ADJ_MIN, abs=0.001)  # sqrt(0.5) clamped


def test_leaky_defense_bumps_delta_up(db_with_xg):
    """Team conceding high xG but few goals → delta_mult > 1.0 (defense
    expected to regress toward more goals against)."""
    _db, conn = db_with_xg
    for i in range(10):
        _insert_xg(conn, "LuckyDefense", "ENG-Premier League", f"Opp{i}",
                   gf=1.0, ga=0.5, xgf=1.0, xga=2.0,  # xg_against >> goals_against
                   match_date=f"2026-05-{i+1:02d}T15:00:00")
    _, delta, _ = _xg_prior_adjustment("LuckyDefense", "Premier League", conn)
    assert delta > 1.0


def test_strong_defense_drags_delta_down(db_with_xg):
    """Team conceding low xG but high goals (bad keeper / unlucky) →
    delta_mult < 1.0 (defense expected to improve)."""
    _db, conn = db_with_xg
    for i in range(10):
        _insert_xg(conn, "UnluckyKeeper", "ENG-Premier League", f"Opp{i}",
                   gf=1.0, ga=2.0, xgf=1.0, xga=1.0,
                   match_date=f"2026-05-{i+1:02d}T15:00:00")
    _, delta, _ = _xg_prior_adjustment("UnluckyKeeper", "Premier League", conn)
    assert delta < 1.0


def test_leakage_gate_excludes_future_matches(db_with_xg):
    """With before_date='2026-05-01', matches from 2026-05-10 must not
    leak into the team's xG history."""
    _db, conn = db_with_xg
    for i in range(10):
        _insert_xg(conn, "FutureTeam", "ENG-Premier League", "X",
                   gf=0.5, ga=1.0, xgf=2.0, xga=1.0,
                   match_date=f"2026-05-{i+10:02d}T15:00:00")
    alpha, delta, trace = _xg_prior_adjustment(
        "FutureTeam", "Premier League", conn,
        before_date="2026-05-01",
    )
    assert alpha == 1.0
    assert delta == 1.0
    # team-not-in-understat because the date filter excludes all rows


def test_fuzzy_team_match_man_united(db_with_xg):
    """DC fit uses 'Man United', Understat uses 'Manchester United' —
    token-overlap fallback should resolve."""
    _db, conn = db_with_xg
    for i in range(10):
        _insert_xg(conn, "Manchester United", "ENG-Premier League", "X",
                   gf=1.5, ga=1.0, xgf=1.5, xga=1.0,
                   match_date=f"2026-05-{i+1:02d}T15:00:00")
    alpha, delta, trace = _xg_prior_adjustment("Man United", "Premier League", conn)
    # We don't care about the exact value here — just that the team got matched
    assert trace.get("team") == "Manchester United"
    assert trace.get("matched_dc_name") == "Man United"


# ── Integration with predict_match ───────────────────────────────────────────

def _fake_fit(home: str, away: str) -> DCFit:
    return DCFit(
        league="Premier League",
        alpha={home: 1.10, away: 1.00},
        delta={home: 0.95, away: 1.05},
        gamma=1.30, rho=-0.05,
        log_likelihood=-100.0,
        n_matches=200, n_teams=20,
        fit_at="2026-05-01T00:00:00",
    )


def test_predict_match_exposes_xg_in_adj(db_with_xg):
    """xg_alpha_h/_a, xg_delta_h/_a + traces must appear in _adj."""
    _db, conn = db_with_xg
    # Seed enough Understat history for the home team
    for i in range(10):
        _insert_xg(conn, "Home FC", "ENG-Premier League", "Opp",
                   gf=1.0, ga=1.0, xgf=1.5, xga=1.0,
                   match_date=f"2026-05-{i+1:02d}T15:00:00")
    fit = _fake_fit("Home FC", "Away FC")
    pred = predict_match(fit, "Home FC", "Away FC",
                         league="Premier League", conn=conn,
                         apply_adjustments=True)
    adj = pred["_adj"]
    assert "xg_alpha_h" in adj
    assert "xg_alpha_a" in adj
    assert "xg_delta_h" in adj
    assert "xg_delta_a" in adj
    assert "xg_trace_h" in adj
    assert "xg_trace_a" in adj
    # Home FC has xG data; Away FC doesn't.
    assert adj["xg_trace_h"].get("team") == "Home FC"
    assert adj["xg_trace_a"].get("reason") == "team-not-in-understat"
    assert adj["xg_alpha_h"] != 1.0  # adjustment fired
    assert adj["xg_alpha_a"] == 1.0  # no-op


def test_predict_match_xg_moves_lambda(db_with_xg):
    """An unlucky home team (xG > goals) should see λ_h rise vs baseline."""
    _db, conn = db_with_xg
    fit = _fake_fit("Home FC", "Away FC")

    # Baseline — no xG data
    baseline = predict_match(fit, "Home FC", "Away FC",
                              league="Premier League", conn=conn,
                              apply_adjustments=True)

    # Add unlucky-attack xG history for Home FC
    for i in range(10):
        _insert_xg(conn, "Home FC", "ENG-Premier League", "X",
                   gf=0.5, ga=1.0, xgf=2.0, xga=1.0,
                   match_date=f"2026-05-{i+1:02d}T15:00:00")

    impacted = predict_match(fit, "Home FC", "Away FC",
                              league="Premier League", conn=conn,
                              apply_adjustments=True)

    # Home λ should rise (their attack is being regressed UP)
    assert impacted["lambda_h"] > baseline["lambda_h"]
    # Home win probability also rises
    assert impacted["p_home"] > baseline["p_home"]
