"""
Integration smoke test — full pipeline with a temp DB, no real API calls.

Scenario
--------
BOS hosts MIA on 2026-04-26.
  Morning snapshot  : BOS -3.5
  6pm_proxy snapshot: BOS -6.0  (2.5 pt move toward home)
  → detect_line_movements() should auto-log a line_movement signal

Then:
  record_closing_proxy() stamps closing_line = -7.5
    (simulates line continuing to move after the proxy snapshot)
  CLV = direction * (line_at_signal - closing_line)
      = +1 * (-6.0 - -7.5) = +1.5 pts  (we got a better number than true close)

  grade_signal() with home 112, away 104:
    cover_margin = (112-104) + (-7.5) = +0.5  → home covered
    covered = 1  →  WIN on a home bet

Report shows avg_clv=+1.50, win_rate=100%.
"""
import pytest

from ml.nba_spread.signal_logger import (
    save_snapshot,
    detect_line_movements,
    record_closing_proxy,
    grade_signal,
    get_open_signals,
    get_report,
    print_report,
)

GAME_ID   = "SMOKE_TEST_001"
GAME_DATE = "2026-04-26"
HOME      = "bos"
AWAY      = "mia"


@pytest.fixture
def db(tmp_path):
    return tmp_path / "smoke_test.db"


# ---------------------------------------------------------------------------
# Step 1: morning snapshot
# ---------------------------------------------------------------------------

def test_morning_snapshot_saved(db):
    save_snapshot(
        game_id=GAME_ID,
        game_date=GAME_DATE,
        home_team=HOME,
        away_team=AWAY,
        home_line=-3.5,
        snapshot_label="morning",
        over_under=215.5,
        source="odds_api",
        db_path=db,
    )

    from ml.nba_spread.signal_logger import get_db
    conn = get_db(db)
    row = conn.execute(
        "SELECT * FROM line_snapshots WHERE game_id=? AND snapshot_label='morning'",
        (GAME_ID,),
    ).fetchone()
    conn.close()

    assert row is not None
    assert row["home_line"] == -3.5
    assert row["over_under"] == 215.5


# ---------------------------------------------------------------------------
# Step 2: 6pm_proxy snapshot (2.5 pt move)
# ---------------------------------------------------------------------------

def test_proxy_snapshot_saved(db):
    save_snapshot(
        game_id=GAME_ID, game_date=GAME_DATE,
        home_team=HOME, away_team=AWAY,
        home_line=-3.5, snapshot_label="morning",
        db_path=db,
    )
    save_snapshot(
        game_id=GAME_ID, game_date=GAME_DATE,
        home_team=HOME, away_team=AWAY,
        home_line=-6.0, snapshot_label="6pm_proxy",
        db_path=db,
    )

    from ml.nba_spread.signal_logger import get_db
    conn = get_db(db)
    rows = conn.execute(
        "SELECT snapshot_label, home_line FROM line_snapshots WHERE game_id=?",
        (GAME_ID,),
    ).fetchall()
    conn.close()

    labels = {r["snapshot_label"]: r["home_line"] for r in rows}
    assert labels["morning"]   == -3.5
    assert labels["6pm_proxy"] == -6.0


# ---------------------------------------------------------------------------
# Step 3: detect_line_movements auto-logs the signal
# ---------------------------------------------------------------------------

def test_line_movement_detected(db):
    save_snapshot(game_id=GAME_ID, game_date=GAME_DATE,
                  home_team=HOME, away_team=AWAY,
                  home_line=-3.5, snapshot_label="morning", db_path=db)
    save_snapshot(game_id=GAME_ID, game_date=GAME_DATE,
                  home_team=HOME, away_team=AWAY,
                  home_line=-6.0, snapshot_label="6pm_proxy", db_path=db)

    created = detect_line_movements(game_date=GAME_DATE, threshold=1.5, db_path=db)

    assert len(created) == 1
    s = created[0]
    assert s["game_id"]      == GAME_ID
    assert s["morning_line"] == -3.5
    assert s["proxy_line"]   == -6.0
    assert s["movement"]     == pytest.approx(-2.5)
    assert s["bet_side"]     == "home"   # line moved more negative → home favored


def test_line_movement_below_threshold_not_logged(db):
    save_snapshot(game_id=GAME_ID, game_date=GAME_DATE,
                  home_team=HOME, away_team=AWAY,
                  home_line=-3.5, snapshot_label="morning", db_path=db)
    save_snapshot(game_id=GAME_ID, game_date=GAME_DATE,
                  home_team=HOME, away_team=AWAY,
                  home_line=-4.0, snapshot_label="6pm_proxy", db_path=db)  # only 0.5 pts

    created = detect_line_movements(game_date=GAME_DATE, threshold=1.5, db_path=db)
    assert len(created) == 0


def test_detection_is_idempotent(db):
    """Running detect twice should not create a duplicate signal."""
    save_snapshot(game_id=GAME_ID, game_date=GAME_DATE,
                  home_team=HOME, away_team=AWAY,
                  home_line=-3.5, snapshot_label="morning", db_path=db)
    save_snapshot(game_id=GAME_ID, game_date=GAME_DATE,
                  home_team=HOME, away_team=AWAY,
                  home_line=-6.0, snapshot_label="6pm_proxy", db_path=db)

    detect_line_movements(game_date=GAME_DATE, db_path=db)
    second_run = detect_line_movements(game_date=GAME_DATE, db_path=db)

    assert second_run == []


def test_away_bet_side_when_line_moves_positive(db):
    """Line moves from -6.0 to -3.5 → away is now better → bet_side='away'."""
    save_snapshot(game_id=GAME_ID, game_date=GAME_DATE,
                  home_team=HOME, away_team=AWAY,
                  home_line=-6.0, snapshot_label="morning", db_path=db)
    save_snapshot(game_id=GAME_ID, game_date=GAME_DATE,
                  home_team=HOME, away_team=AWAY,
                  home_line=-3.5, snapshot_label="6pm_proxy", db_path=db)

    created = detect_line_movements(game_date=GAME_DATE, db_path=db)
    assert len(created) == 1
    assert created[0]["bet_side"] == "away"
    assert created[0]["movement"] == pytest.approx(2.5)


# ---------------------------------------------------------------------------
# Step 4: signal is open, visible in get_open_signals
# ---------------------------------------------------------------------------

def test_signal_appears_as_open(db):
    save_snapshot(game_id=GAME_ID, game_date=GAME_DATE,
                  home_team=HOME, away_team=AWAY,
                  home_line=-3.5, snapshot_label="morning", db_path=db)
    save_snapshot(game_id=GAME_ID, game_date=GAME_DATE,
                  home_team=HOME, away_team=AWAY,
                  home_line=-6.0, snapshot_label="6pm_proxy", db_path=db)
    detect_line_movements(game_date=GAME_DATE, db_path=db)

    open_sigs = get_open_signals(db_path=db)
    assert len(open_sigs) == 1
    assert open_sigs[0]["status"] == "open"
    assert open_sigs[0]["signal_type"] == "line_movement"


# ---------------------------------------------------------------------------
# Step 5: record_closing_proxy stamps the closing line
# ---------------------------------------------------------------------------

def test_closing_proxy_stamped(db):
    save_snapshot(game_id=GAME_ID, game_date=GAME_DATE,
                  home_team=HOME, away_team=AWAY,
                  home_line=-3.5, snapshot_label="morning", db_path=db)
    save_snapshot(game_id=GAME_ID, game_date=GAME_DATE,
                  home_team=HOME, away_team=AWAY,
                  home_line=-6.0, snapshot_label="6pm_proxy", db_path=db)
    detect_line_movements(game_date=GAME_DATE, db_path=db)

    # True close moved to -7.5 (line kept moving)
    updated = record_closing_proxy(GAME_ID, closing_line=-7.5,
                                   source="odds_api_6pm_proxy", db_path=db)
    assert updated == 1

    from ml.nba_spread.signal_logger import get_db
    conn = get_db(db)
    row = conn.execute(
        "SELECT status, closing_line, closing_source FROM signal_log WHERE game_id=?",
        (GAME_ID,),
    ).fetchone()
    conn.close()

    assert row["status"]         == "proxy_captured"
    assert row["closing_line"]   == -7.5
    assert row["closing_source"] == "odds_api_6pm_proxy"


# ---------------------------------------------------------------------------
# Step 6 + 7: grade_signal computes CLV and covered
# ---------------------------------------------------------------------------

def test_grade_signal_clv_and_covered(db):
    save_snapshot(game_id=GAME_ID, game_date=GAME_DATE,
                  home_team=HOME, away_team=AWAY,
                  home_line=-3.5, snapshot_label="morning", db_path=db)
    save_snapshot(game_id=GAME_ID, game_date=GAME_DATE,
                  home_team=HOME, away_team=AWAY,
                  home_line=-6.0, snapshot_label="6pm_proxy", db_path=db)
    detect_line_movements(game_date=GAME_DATE, db_path=db)
    record_closing_proxy(GAME_ID, closing_line=-7.5, db_path=db)

    # BOS 112, MIA 104
    # cover_margin = (112-104) + (-7.5) = 0.5 → home covered
    # CLV = +1 * (-6.0 - -7.5) = +1.5 pts
    results = grade_signal(GAME_ID, score_home=112, score_away=104, db_path=db)

    assert len(results) == 1
    r = results[0]
    assert r["covered"]    == 1
    assert r["clv_points"] == pytest.approx(1.5)


def test_grade_sets_status_to_graded(db):
    save_snapshot(game_id=GAME_ID, game_date=GAME_DATE,
                  home_team=HOME, away_team=AWAY,
                  home_line=-3.5, snapshot_label="morning", db_path=db)
    save_snapshot(game_id=GAME_ID, game_date=GAME_DATE,
                  home_team=HOME, away_team=AWAY,
                  home_line=-6.0, snapshot_label="6pm_proxy", db_path=db)
    detect_line_movements(game_date=GAME_DATE, db_path=db)
    record_closing_proxy(GAME_ID, closing_line=-7.5, db_path=db)
    grade_signal(GAME_ID, score_home=112, score_away=104, db_path=db)

    from ml.nba_spread.signal_logger import get_db
    conn = get_db(db)
    row = conn.execute(
        "SELECT status, score_home, score_away FROM signal_log WHERE game_id=?",
        (GAME_ID,),
    ).fetchone()
    conn.close()

    assert row["status"]     == "graded"
    assert row["score_home"] == 112
    assert row["score_away"] == 104


# ---------------------------------------------------------------------------
# Step 8: full report output
# ---------------------------------------------------------------------------

def test_report_shows_correct_stats(db):
    save_snapshot(game_id=GAME_ID, game_date=GAME_DATE,
                  home_team=HOME, away_team=AWAY,
                  home_line=-3.5, snapshot_label="morning", db_path=db)
    save_snapshot(game_id=GAME_ID, game_date=GAME_DATE,
                  home_team=HOME, away_team=AWAY,
                  home_line=-6.0, snapshot_label="6pm_proxy", db_path=db)
    detect_line_movements(game_date=GAME_DATE, db_path=db)
    record_closing_proxy(GAME_ID, closing_line=-7.5, db_path=db)
    grade_signal(GAME_ID, score_home=112, score_away=104, db_path=db)

    report = get_report(db_path=db)

    assert len(report) == 1
    row = report[0]
    assert row["signal_type"]  == "line_movement"
    assert row["n"]            == 1
    assert row["avg_clv"]      == pytest.approx(1.5)
    assert row["pct_pos_clv"]  == pytest.approx(100.0)
    assert row["win_rate_pct"] == pytest.approx(100.0)


def test_execution_source_stored_and_visible(db):
    """Book name flows from snapshot → detected signal → open signals list."""
    save_snapshot(game_id=GAME_ID, game_date=GAME_DATE,
                  home_team=HOME, away_team=AWAY,
                  home_line=-3.5, snapshot_label="morning",
                  book="pinnacle", db_path=db)
    save_snapshot(game_id=GAME_ID, game_date=GAME_DATE,
                  home_team=HOME, away_team=AWAY,
                  home_line=-6.0, snapshot_label="6pm_proxy",
                  book="pinnacle", db_path=db)
    created = detect_line_movements(game_date=GAME_DATE, db_path=db)

    assert len(created) == 1
    open_sigs = get_open_signals(db_path=db)
    assert open_sigs[0]["execution_source"] == "pinnacle"


def test_closing_source_stored(db):
    """closing_source reflects the book used when stamping the proxy."""
    save_snapshot(game_id=GAME_ID, game_date=GAME_DATE,
                  home_team=HOME, away_team=AWAY,
                  home_line=-3.5, snapshot_label="morning",
                  book="pinnacle", db_path=db)
    save_snapshot(game_id=GAME_ID, game_date=GAME_DATE,
                  home_team=HOME, away_team=AWAY,
                  home_line=-6.0, snapshot_label="6pm_proxy",
                  book="pinnacle", db_path=db)
    detect_line_movements(game_date=GAME_DATE, db_path=db)
    record_closing_proxy(GAME_ID, closing_line=-7.5,
                         source="pinnacle", db_path=db)

    from ml.nba_spread.signal_logger import get_db
    conn = get_db(db)
    row = conn.execute(
        "SELECT execution_source, closing_source FROM signal_log WHERE game_id=?",
        (GAME_ID,),
    ).fetchone()
    conn.close()

    assert row["execution_source"] == "pinnacle"
    assert row["closing_source"]   == "pinnacle"


def test_closing_source_fallback_marked(db):
    """When closing uses a different book than signal, source is marked as fallback."""
    save_snapshot(game_id=GAME_ID, game_date=GAME_DATE,
                  home_team=HOME, away_team=AWAY,
                  home_line=-3.5, snapshot_label="morning",
                  book="pinnacle", db_path=db)
    save_snapshot(game_id=GAME_ID, game_date=GAME_DATE,
                  home_team=HOME, away_team=AWAY,
                  home_line=-6.0, snapshot_label="6pm_proxy",
                  book="pinnacle", db_path=db)
    detect_line_movements(game_date=GAME_DATE, db_path=db)
    # Pinnacle unavailable at close — fell back to fanduel
    record_closing_proxy(GAME_ID, closing_line=-6.5,
                         source="fanduel_fallback", db_path=db)

    from ml.nba_spread.signal_logger import get_db
    conn = get_db(db)
    row = conn.execute(
        "SELECT closing_source FROM signal_log WHERE game_id=?",
        (GAME_ID,),
    ).fetchone()
    conn.close()

    assert "fallback" in row["closing_source"]


def test_print_report_runs_without_error(db, capsys):
    save_snapshot(game_id=GAME_ID, game_date=GAME_DATE,
                  home_team=HOME, away_team=AWAY,
                  home_line=-3.5, snapshot_label="morning", db_path=db)
    save_snapshot(game_id=GAME_ID, game_date=GAME_DATE,
                  home_team=HOME, away_team=AWAY,
                  home_line=-6.0, snapshot_label="6pm_proxy", db_path=db)
    detect_line_movements(game_date=GAME_DATE, db_path=db)
    record_closing_proxy(GAME_ID, closing_line=-7.5, db_path=db)
    grade_signal(GAME_ID, score_home=112, score_away=104, db_path=db)

    print_report(db_path=db)

    out = capsys.readouterr().out
    assert "line_movement" in out
    assert "+1.50" in out   # avg CLV
    assert "100.0%" in out  # win rate
