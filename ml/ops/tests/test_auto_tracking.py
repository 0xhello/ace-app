import sqlite3
from pathlib import Path

from ml.mlb.signal_logger import grade_signal as grade_mlb_signal
from ml.mlb.signal_logger import log_signal as log_mlb_signal
from ml.nba_spread.signal_logger import grade_signal as grade_nba_signal
from ml.nba_spread.signal_logger import log_signal as log_nba_signal
from ml.world_cup.signal_logger import grade_signal as grade_soccer_signal
from ml.world_cup.signal_logger import log_signal as log_soccer_signal


def _tracked_row(db_dir: Path, source_table: str):
    conn = sqlite3.connect(db_dir / "tracked_picks.db")
    try:
        return conn.execute(
            "SELECT sport, origin, lifecycle, result FROM tracked_picks WHERE source_table=?",
            (source_table,),
        ).fetchone()
    finally:
        conn.close()


def test_mlb_signal_auto_tracks_and_grades(tmp_path: Path) -> None:
    source = tmp_path / "mlb_signal_log.db"
    row_id = log_mlb_signal(
        "mlb-auto", "2026-06-06", "Home", "Away", "2026-06-06T20:00:00Z",
        "h2h", "home", 0.58, "fanduel", 0.50, -110, 0.08, path=source,
    )
    assert row_id == 1
    assert _tracked_row(tmp_path, "mlb_signals") == ("mlb", "model_auto", "open", None)

    grade_mlb_signal("mlb-auto", 5, 3, path=source)
    assert _tracked_row(tmp_path, "mlb_signals") == ("mlb", "model_auto", "graded", "win")


def test_soccer_signal_auto_tracks_and_grades(tmp_path: Path) -> None:
    source = tmp_path / "wc_signal_log.db"
    row_id = log_soccer_signal(
        "soccer-auto", "2026-06-06", "Home", "Away", "2026-06-06T20:00:00Z",
        "h2h", "home", 0.58, "fanduel", 0.50, -110, 0.08, path=source,
    )
    assert row_id == 1
    assert _tracked_row(tmp_path, "soccer_signals") == ("soccer", "model_auto", "open", None)

    grade_soccer_signal("soccer-auto", 2, 1, path=source)
    assert _tracked_row(tmp_path, "soccer_signals") == ("soccer", "model_auto", "graded", "win")


def test_nba_signal_auto_tracks_and_grades(tmp_path: Path) -> None:
    source = tmp_path / "signal_log.db"
    row_id = log_nba_signal(
        game_id="nba-auto",
        game_date="2026-06-06",
        home_team="Home",
        away_team="Away",
        signal_type="line_movement",
        line_at_signal=-3.5,
        bet_side="home",
        db_path=source,
    )
    assert row_id == 1
    assert _tracked_row(tmp_path, "signal_log") == ("nba", "model_auto", "open", None)

    grade_nba_signal("nba-auto", 112, 104, db_path=source)
    assert _tracked_row(tmp_path, "signal_log") == ("nba", "model_auto", "graded", "win")

from ml.ops.tracked_picks import add_operator_pick


def test_operator_manual_pick_starts_open_and_internal(tmp_path: Path) -> None:
    row = add_operator_pick(
        sport="mlb",
        matchup_label="Away @ Home",
        market="h2h",
        side="home",
        book="DraftKings",
        odds_american=-110,
        notes="operator research",
        target_db=tmp_path / "tracked_picks.db",
    )
    assert row["sport"] == "mlb"
    assert row["origin"] == "operator_manual"
    assert row["tracking_mode"] == "paper"
    assert row["publish_state"] == "internal"
    assert row["lifecycle"] == "open"
    assert row["source_table"] == "operator_manual"
