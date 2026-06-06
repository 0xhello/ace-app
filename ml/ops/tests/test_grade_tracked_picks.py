import sqlite3
from pathlib import Path

from ml.ops.grade_tracked_picks import reconcile
from ml.ops.tracked_picks import add_operator_pick


def test_canonical_grader_settles_manual_mlb_pick(tmp_path: Path, monkeypatch) -> None:
    db = tmp_path / "tracked_picks.db"
    add_operator_pick(
        sport="mlb",
        matchup_label="Away Team @ Home Team",
        market="h2h",
        side="home",
        game_date="2026-06-06",
        home_team="Home Team",
        away_team="Away Team",
        odds_american=-110,
        target_db=db,
    )

    def fake_scores(date: str):
      assert date == "2026-06-06"
      return {("Home Team", "Away Team"): (5, 3, "test_score")}

    monkeypatch.setattr("ml.ops.grade_tracked_picks.fetch_mlb_scores", fake_scores)
    dry = reconcile(db, apply=False)
    assert dry["rows_graded"] == 1

    applied = reconcile(db, apply=True)
    assert applied["rows_graded"] == 1
    assert applied["remaining_open"] == 0

    conn = sqlite3.connect(db)
    row = conn.execute("SELECT lifecycle, result, result_detail, home_score, away_score FROM tracked_picks").fetchone()
    conn.close()
    assert row == ("graded", "win", "home", 5, 3)
