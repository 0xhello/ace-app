"""
Tests for the defensive lineup availability adjustment (M8).

Targets _lineup_defensive_availability_adjustment in ml/soccer/model.py.
The function produces a vulnerability multiplier (≥ 1.0) applied to the
OPPONENT's λ when a team's keeper or defenders are unavailable.

Mirrors the structure of test_lineup_adjustment.py (M7) so the two
adjustments are validated under the same harness.
"""
from __future__ import annotations

import sqlite3

import pytest

from ml.soccer.model import (
    _lineup_defensive_availability_adjustment,
    predict_match,
    DCFit,
)


# ── Fixture ──────────────────────────────────────────────────────────────────

@pytest.fixture
def db_with_snapshot(tmp_path):
    """Temp DB with snapshot + stub team_form table (same shape as M7 tests)."""
    db = tmp_path / "test.db"
    conn = sqlite3.connect(str(db))
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE soccer_player_feature_snapshot (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            team TEXT, opponent TEXT, player_name TEXT,
            lineup_status TEXT, position_bucket TEXT,
            is_attacking_role INTEGER, attack_role_score REAL,
            projected_minutes REAL, unavailable_reason TEXT,
            updated_at TEXT DEFAULT (datetime('now'))
        );
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
    """)
    conn.commit()
    yield db, conn
    conn.close()


def _insert_player(conn, team, player, status, position, mins=90,
                   attack_role=0.0, updated_at=None):
    cols = ("team", "player_name", "lineup_status", "position_bucket",
            "projected_minutes", "attack_role_score")
    vals = (team, player, status, position, mins, attack_role)
    if updated_at:
        conn.execute(
            f"INSERT INTO soccer_player_feature_snapshot "
            f"({','.join(cols)}, updated_at) VALUES (?,?,?,?,?,?,?)",
            (*vals, updated_at),
        )
    else:
        conn.execute(
            f"INSERT INTO soccer_player_feature_snapshot "
            f"({','.join(cols)}) VALUES (?,?,?,?,?,?)",
            vals,
        )
    conn.commit()


def _insert_standard_back_five(conn, team):
    """Set up a standard back 5: GK + 2 CB + 2 FB, all confirmed starting."""
    _insert_player(conn, team, "GK Hero",  "confirmed_starting", "goalkeeper", mins=90)
    _insert_player(conn, team, "CB Right", "confirmed_starting", "defender",   mins=90)
    _insert_player(conn, team, "CB Left",  "confirmed_starting", "defender",   mins=90)
    _insert_player(conn, team, "RB",       "confirmed_starting", "defender",   mins=90)
    _insert_player(conn, team, "LB",       "confirmed_starting", "defender",   mins=90)


# ── Direct adjustment cases ──────────────────────────────────────────────────

def test_no_snapshot_is_noop(db_with_snapshot):
    _db, conn = db_with_snapshot
    mult, trace = _lineup_defensive_availability_adjustment("Liverpool", conn)
    assert mult == 1.0
    assert trace.get("reason") == "no-snapshot"


def test_no_defensive_players_in_snapshot(db_with_snapshot):
    """Team in snapshot but no GK/defender rows → still a no-op."""
    _db, conn = db_with_snapshot
    _insert_player(conn, "AllAttackFC", "Striker", "confirmed_starting",
                   "attacker", mins=90, attack_role=0.99)
    mult, trace = _lineup_defensive_availability_adjustment("AllAttackFC", conn)
    assert mult == 1.0
    assert trace.get("reason") == "no-defensive-players"


def test_full_back_five_returns_one(db_with_snapshot):
    _db, conn = db_with_snapshot
    _insert_standard_back_five(conn, "FortFC")
    mult, trace = _lineup_defensive_availability_adjustment("FortFC", conn)
    assert mult == pytest.approx(1.0, abs=0.005)
    assert trace["keepers_out"] == 0
    assert trace["defenders_out"] == 0


def test_keeper_out_increases_vulnerability(db_with_snapshot):
    """First-choice keeper unavailable → opponent λ should bump up."""
    _db, conn = db_with_snapshot
    _insert_player(conn, "OpenNet", "GK Hero", "out", "goalkeeper", mins=0)
    _insert_player(conn, "OpenNet", "CB1",     "confirmed_starting", "defender", mins=90)
    _insert_player(conn, "OpenNet", "CB2",     "confirmed_starting", "defender", mins=90)
    _insert_player(conn, "OpenNet", "RB",      "confirmed_starting", "defender", mins=90)
    _insert_player(conn, "OpenNet", "LB",      "confirmed_starting", "defender", mins=90)
    mult, trace = _lineup_defensive_availability_adjustment("OpenNet", conn)
    # expected = 1.0 (GK) + 4 × 0.5 (defs) = 3.0
    # available = 0 (GK out) + 4 × 0.5 = 2.0
    # coverage = 2.0 / 3.0 = 0.667
    # raw vuln = 1 / 0.667 = 1.50 → clamped to 1.20
    assert mult == pytest.approx(1.20, abs=0.01)
    assert trace["keepers_out"] == 1
    assert trace["defenders_out"] == 0


def test_one_defender_out_modest_vulnerability(db_with_snapshot):
    """One starting defender out → ~5pp opponent goal bump."""
    _db, conn = db_with_snapshot
    _insert_player(conn, "ShakyBackline", "GK",   "confirmed_starting", "goalkeeper", mins=90)
    _insert_player(conn, "ShakyBackline", "CB1",  "out",                "defender",   mins=0)
    _insert_player(conn, "ShakyBackline", "CB2",  "confirmed_starting", "defender",   mins=90)
    _insert_player(conn, "ShakyBackline", "RB",   "confirmed_starting", "defender",   mins=90)
    _insert_player(conn, "ShakyBackline", "LB",   "confirmed_starting", "defender",   mins=90)
    mult, trace = _lineup_defensive_availability_adjustment("ShakyBackline", conn)
    # expected = 1.0 + 4 × 0.5 = 3.0
    # available = 1.0 + 3 × 0.5 = 2.5
    # coverage = 2.5 / 3.0 = 0.833
    # vuln = 1 / 0.833 = 1.20 (right at the cap)
    assert 1.10 <= mult <= 1.20
    assert trace["defenders_out"] == 1
    assert trace["keepers_out"] == 0


def test_attacker_out_does_not_affect_defense(db_with_snapshot):
    """Out attacker should leave defensive vulnerability at 1.0."""
    _db, conn = db_with_snapshot
    _insert_standard_back_five(conn, "AttackerOutFC")
    _insert_player(conn, "AttackerOutFC", "Striker", "out", "attacker",
                   mins=0, attack_role=0.95)
    mult, trace = _lineup_defensive_availability_adjustment("AttackerOutFC", conn)
    assert mult == pytest.approx(1.0, abs=0.005)
    assert trace["keepers_out"] == 0
    assert trace["defenders_out"] == 0


def test_leakage_gate_excludes_future_snapshots(db_with_snapshot):
    _db, conn = db_with_snapshot
    _insert_player(conn, "FutureFC", "GK", "out", "goalkeeper", mins=0,
                   updated_at="2026-06-01T00:00:00")
    mult, trace = _lineup_defensive_availability_adjustment(
        "FutureFC", conn, before_date="2026-05-15",
    )
    assert mult == 1.0
    assert trace.get("reason") == "no-snapshot"


def test_leakage_gate_allows_prior_snapshots(db_with_snapshot):
    _db, conn = db_with_snapshot
    _insert_player(conn, "PriorFC", "GK", "out", "goalkeeper", mins=0,
                   updated_at="2026-05-01T00:00:00")
    _insert_player(conn, "PriorFC", "CB1", "confirmed_starting", "defender",
                   mins=90, updated_at="2026-05-01T00:00:00")
    mult, trace = _lineup_defensive_availability_adjustment(
        "PriorFC", conn, before_date="2026-05-15",
    )
    assert mult > 1.0
    assert trace.get("keepers_out", 0) >= 1


# ── Integration with predict_match ───────────────────────────────────────────

def _fake_fit(home: str, away: str) -> DCFit:
    return DCFit(
        league="Test League",
        alpha={home: 1.10, away: 1.00},
        delta={home: 0.95, away: 1.05},
        gamma=1.30, rho=-0.05,
        log_likelihood=-100.0,
        n_matches=200, n_teams=20,
        fit_at="2026-05-01T00:00:00",
    )


def test_predict_match_keeper_out_increases_opponent_lambda(db_with_snapshot):
    """Home team's keeper OUT should increase AWAY team's λ."""
    _db, conn = db_with_snapshot
    fit = _fake_fit("Home FC", "Away FC")

    # Baseline — no defensive snapshot, no adjustment
    baseline = predict_match(
        fit, "Home FC", "Away FC",
        league="Test League", conn=conn, apply_adjustments=True,
    )

    # Now home FC keeper goes out
    _insert_player(conn, "Home FC", "GK Hero", "out", "goalkeeper", mins=0)
    _insert_player(conn, "Home FC", "CB1",     "confirmed_starting", "defender", mins=90)
    _insert_player(conn, "Home FC", "CB2",     "confirmed_starting", "defender", mins=90)
    _insert_player(conn, "Home FC", "RB",      "confirmed_starting", "defender", mins=90)
    _insert_player(conn, "Home FC", "LB",      "confirmed_starting", "defender", mins=90)

    impacted = predict_match(
        fit, "Home FC", "Away FC",
        league="Test League", conn=conn, apply_adjustments=True,
    )

    # Away λ rises (home defense weakened); home λ unchanged (Away FC's
    # defense unchanged because no Away FC snapshot).
    assert impacted["lambda_a"] > baseline["lambda_a"]
    assert impacted["lambda_h"] == pytest.approx(baseline["lambda_h"], abs=0.001)
    # P(away win) should rise
    assert impacted["p_away"] > baseline["p_away"]


def test_predict_match_exposes_defense_trace_in_adj(db_with_snapshot):
    _db, conn = db_with_snapshot
    _insert_player(conn, "Home FC", "GK",  "out", "goalkeeper", mins=0)
    _insert_player(conn, "Home FC", "CB1", "confirmed_starting", "defender", mins=90)

    fit = _fake_fit("Home FC", "Away FC")
    pred = predict_match(
        fit, "Home FC", "Away FC",
        league="Test League", conn=conn, apply_adjustments=True,
    )
    adj = pred["_adj"]
    assert "defense_vuln_h" in adj
    assert "defense_vuln_a" in adj
    assert "defense_trace_h" in adj
    assert "defense_trace_a" in adj
    assert adj["defense_trace_h"].get("team") == "Home FC"
    assert adj["defense_vuln_h"] > 1.0   # home is weakened
    assert adj["defense_vuln_a"] == 1.0  # away unaffected


def test_attack_and_defense_compose_correctly(db_with_snapshot):
    """Combining attack and defense lineup adjustments on a single team
    should produce predictable joint effect:
      - Home FC loses both an attacker AND a defender
      - Home FC's λ_h falls (attack hit)
      - Away FC's λ_a rises (home defense hit)
    """
    _db, conn = db_with_snapshot
    _insert_player(conn, "Home FC", "Striker", "out",
                   "attacker", mins=0, attack_role=0.95)
    _insert_player(conn, "Home FC", "Backup",
                   "confirmed_starting", "attacker", mins=90,
                   attack_role=0.50)
    _insert_player(conn, "Home FC", "CB",     "out", "defender", mins=0)
    _insert_player(conn, "Home FC", "GK",     "confirmed_starting", "goalkeeper", mins=90)
    _insert_player(conn, "Home FC", "CB2",    "confirmed_starting", "defender", mins=90)
    _insert_player(conn, "Home FC", "RB",     "confirmed_starting", "defender", mins=90)
    _insert_player(conn, "Home FC", "LB",     "confirmed_starting", "defender", mins=90)

    fit = _fake_fit("Home FC", "Away FC")
    pred = predict_match(
        fit, "Home FC", "Away FC",
        league="Test League", conn=conn, apply_adjustments=True,
    )
    adj = pred["_adj"]
    # Home attack reduced
    assert adj["lineup_mult_h"] < 1.0
    # Home defense weakened → away vulnerability rises
    assert adj["defense_vuln_h"] > 1.0
    # Both effects on λ
    # λ_h should be lower than alpha[h] * delta[a] * gamma
    # λ_a should be higher than alpha[a] * delta[h]
