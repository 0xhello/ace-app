"""
Tests for Sportmonks lineup availability adjustment in predict_match.

Bob's M7 handoff: verify _lineup_availability_adjustment is properly wired,
behaves as a no-op when no snapshot exists, drops α when key attackers are
out, and exposes its trace in the _adj transparency block.
"""
from __future__ import annotations

import sqlite3
import tempfile
from pathlib import Path

import pytest

from ml.soccer.model import (
    _lineup_availability_adjustment,
    predict_match,
    DCFit,
)


# ── Fixture: temp DB with a soccer_player_feature_snapshot table ──────────────

@pytest.fixture
def db_with_snapshot(tmp_path):
    """Build a tiny DB that has the snapshot schema + a known team."""
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
        -- Empty stub tables so the SoT/ref adjustments in predict_match
        -- can run without errors. They return no rows → multipliers = 1.0.
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


def _insert_player(conn, team, player, status, role, mins=90, updated_at=None):
    """Helper: insert a single player snapshot row."""
    if updated_at:
        conn.execute(
            "INSERT INTO soccer_player_feature_snapshot "
            "(team, player_name, lineup_status, attack_role_score, projected_minutes, updated_at) "
            "VALUES (?,?,?,?,?,?)",
            (team, player, status, role, mins, updated_at),
        )
    else:
        conn.execute(
            "INSERT INTO soccer_player_feature_snapshot "
            "(team, player_name, lineup_status, attack_role_score, projected_minutes) "
            "VALUES (?,?,?,?,?)",
            (team, player, status, role, mins),
        )
    conn.commit()


# ── Cases ────────────────────────────────────────────────────────────────────

def test_no_snapshot_is_noop(db_with_snapshot):
    """When the team isn't in the snapshot table at all, multiplier = 1.0."""
    _db, conn = db_with_snapshot
    mult, trace = _lineup_availability_adjustment("Liverpool", conn)
    assert mult == 1.0
    assert trace.get("reason") == "no-snapshot"


def test_all_attackers_starting_full_minutes_returns_one(db_with_snapshot):
    """All top attackers confirmed starting at full 90 → multiplier ≈ 1.0."""
    _db, conn = db_with_snapshot
    _insert_player(conn, "TestTeam", "Star A",   "confirmed_starting", 0.95, mins=90)
    _insert_player(conn, "TestTeam", "Star B",   "confirmed_starting", 0.85, mins=90)
    _insert_player(conn, "TestTeam", "Midfield", "confirmed_starting", 0.50, mins=90)
    mult, trace = _lineup_availability_adjustment("TestTeam", conn)
    assert mult == pytest.approx(1.0, abs=0.001)
    assert trace.get("team") == "TestTeam"


def test_top_attacker_out_drops_multiplier(db_with_snapshot):
    """If the team's top attacker (role 0.95) is OUT, available_attack /
    expected_attack should drop and the multiplier should fall noticeably."""
    _db, conn = db_with_snapshot
    _insert_player(conn, "TestTeam", "Top scorer",  "out",                0.95, mins=0)
    _insert_player(conn, "TestTeam", "Other star",  "confirmed_starting", 0.85, mins=90)
    _insert_player(conn, "TestTeam", "Midfielder",  "confirmed_starting", 0.50, mins=90)
    mult, trace = _lineup_availability_adjustment("TestTeam", conn)
    # expected = 0.95 + 0.85 + 0.50 = 2.30
    # available = 0 + 0.85 + 0.50 = 1.35
    # raw = 1.35 / 2.30 = 0.587 → clamped to 0.75
    assert mult == pytest.approx(0.75, abs=0.01)
    assert trace.get("key_attackers_out") == 1


def test_bench_player_partial_credit(db_with_snapshot):
    """A confirmed-bench attacker contributes 25% — not zero, not full."""
    _db, conn = db_with_snapshot
    _insert_player(conn, "TestTeam", "Starter A",  "confirmed_starting", 0.90, mins=90)
    _insert_player(conn, "TestTeam", "Sub A",      "bench",              0.80, mins=20)
    mult, trace = _lineup_availability_adjustment("TestTeam", conn)
    # expected = 0.90 + 0.80 = 1.70
    # available = 0.90 + (0.80 * 0.25) = 0.90 + 0.20 = 1.10
    # raw = 1.10 / 1.70 = 0.647 → clamped to 0.75
    assert mult == pytest.approx(0.75, abs=0.01)


def test_short_minutes_starter_partial(db_with_snapshot):
    """Confirmed starter projected for 45 minutes contributes 50%."""
    _db, conn = db_with_snapshot
    _insert_player(conn, "TestTeam", "Half-starter", "confirmed_starting", 1.00, mins=45)
    mult, _ = _lineup_availability_adjustment("TestTeam", conn)
    # expected = 1.00 ; available = 1.00 × (45/90) = 0.5 → raw 0.5 → clamped to 0.75
    assert mult == pytest.approx(0.75, abs=0.01)


def test_leakage_gate_excludes_future_snapshots(db_with_snapshot):
    """Snapshot updated AFTER before_date should be invisible to backtest."""
    _db, conn = db_with_snapshot
    _insert_player(conn, "TestTeam", "Star",
                   "confirmed_starting", 0.95, mins=90,
                   updated_at="2026-06-01T00:00:00")
    # Backtest of a 2026-05-15 match should NOT see this snapshot.
    mult, trace = _lineup_availability_adjustment(
        "TestTeam", conn, before_date="2026-05-15",
    )
    assert mult == 1.0
    assert trace.get("reason") == "no-snapshot"


def test_leakage_gate_allows_prior_snapshots(db_with_snapshot):
    """Snapshot updated BEFORE before_date should still be visible."""
    _db, conn = db_with_snapshot
    _insert_player(conn, "TestTeam", "Star",
                   "confirmed_starting", 0.95, mins=90,
                   updated_at="2026-05-01T00:00:00")
    mult, trace = _lineup_availability_adjustment(
        "TestTeam", conn, before_date="2026-05-15",
    )
    assert mult == pytest.approx(1.0, abs=0.001)
    assert trace.get("team") == "TestTeam"


def test_fuzzy_match_paris_sg(db_with_snapshot):
    """Query 'Paris SG' should match snapshot 'Paris Saint Germain' via
    token overlap fallback."""
    _db, conn = db_with_snapshot
    _insert_player(conn, "Paris Saint Germain", "Mbappe",
                   "confirmed_starting", 0.99, mins=90)
    mult, trace = _lineup_availability_adjustment("Paris SG", conn)
    assert trace.get("team") == "Paris Saint Germain"
    assert mult == pytest.approx(1.0, abs=0.001)


def test_fuzzy_match_rejects_unrelated_team(db_with_snapshot):
    """Query for a team with only generic-token overlap shouldn't false-match."""
    _db, conn = db_with_snapshot
    _insert_player(conn, "Paris Saint Germain", "Mbappe",
                   "confirmed_starting", 0.99, mins=90)
    mult, trace = _lineup_availability_adjustment("Saint Etienne", conn)
    # Should NOT match Paris Saint Germain just because they share "saint"
    assert mult == 1.0
    assert trace.get("reason") == "no-snapshot"


# ── Integration with predict_match ───────────────────────────────────────────

def _fake_fit(home: str, away: str) -> DCFit:
    """Tiny synthetic Dixon-Coles fit for integration testing."""
    return DCFit(
        league=  "Test League",
        alpha=   {home: 1.10, away: 0.95},
        delta=   {home: 0.90, away: 1.05},  # Lower δ = stronger defense
        gamma=   1.30,
        rho=    -0.05,
        log_likelihood=-100.0,
        n_matches=200,
        n_teams=20,
        fit_at="2026-05-01T00:00:00",
    )


def test_predict_match_exposes_lineup_trace_in_adj(db_with_snapshot):
    """The _adj transparency block must surface lineup_mult_h/_a + traces."""
    _db, conn = db_with_snapshot
    _insert_player(conn, "Home FC", "Star", "confirmed_starting", 0.95, mins=90)
    _insert_player(conn, "Home FC", "Sub",  "bench",              0.50, mins=20)
    _insert_player(conn, "Away FC", "Star", "out",                0.95, mins=0)
    _insert_player(conn, "Away FC", "Mid",  "confirmed_starting", 0.60, mins=90)

    fit = _fake_fit("Home FC", "Away FC")
    pred = predict_match(
        fit, "Home FC", "Away FC",
        league="Test League", conn=conn, apply_adjustments=True,
    )
    assert pred is not None
    adj = pred["_adj"]
    # Multipliers must appear
    assert "lineup_mult_h" in adj
    assert "lineup_mult_a" in adj
    # Home FC is mostly intact → mult higher than Away FC (top scorer out)
    assert adj["lineup_mult_h"] >= adj["lineup_mult_a"]
    # Traces must include matched team names
    assert adj["lineup_trace_h"].get("team") == "Home FC"
    assert adj["lineup_trace_a"].get("team") == "Away FC"
    assert adj["lineup_trace_a"].get("key_attackers_out", 0) >= 1


def test_predict_match_no_snapshot_returns_unit_multiplier(db_with_snapshot):
    """When neither team has a snapshot, lineup multipliers stay at 1.0
    and predictions match the no-adjustment case."""
    _db, conn = db_with_snapshot
    fit = _fake_fit("Home FC", "Away FC")
    pred = predict_match(
        fit, "Home FC", "Away FC",
        league="Test League", conn=conn, apply_adjustments=True,
    )
    adj = pred["_adj"]
    assert adj["lineup_mult_h"] == 1.0
    assert adj["lineup_mult_a"] == 1.0


def test_lineup_adjustment_actually_changes_lambdas(db_with_snapshot):
    """Sanity: same fit + same teams, but adding 'star out' for Away should
    drop λ_a noticeably below the no-snapshot baseline."""
    _db, conn = db_with_snapshot
    fit = _fake_fit("Home FC", "Away FC")

    # Baseline — no snapshot, lineup multiplier = 1.0
    baseline = predict_match(
        fit, "Home FC", "Away FC",
        league="Test League", conn=conn, apply_adjustments=True,
    )

    # Now add a heavy lineup hit for Away FC
    _insert_player(conn, "Away FC", "Top Star", "out",                0.95, mins=0)
    _insert_player(conn, "Away FC", "Other",    "confirmed_starting", 0.50, mins=90)

    impacted = predict_match(
        fit, "Home FC", "Away FC",
        league="Test League", conn=conn, apply_adjustments=True,
    )

    # Away λ should drop because the away attack mult is now < 1.0
    assert impacted["lambda_a"] < baseline["lambda_a"]
    # Resulting away win probability should also drop
    assert impacted["p_away"] < baseline["p_away"]
