import sqlite3
from pathlib import Path

from ml.ops.tracked_picks import add_operator_parlay, add_operator_pick, sync_parlay_results, update_parlay_publish_state


def test_operator_parlay_tracks_and_settles_from_legs(tmp_path: Path) -> None:
    db = tmp_path / "tracked_picks.db"
    leg1 = add_operator_pick(sport="mlb", matchup_label="A @ B", market="h2h", side="home", odds_american=-110, target_db=db)
    leg2 = add_operator_pick(sport="mlb", matchup_label="C @ D", market="totals", side="over", line=8.5, odds_american=120, target_db=db)

    parlay = add_operator_parlay(pick_ids=[leg1["id"], leg2["id"]], label="Test two-leg", target_db=db)
    assert parlay["leg_count"] == 2
    assert parlay["lifecycle"] == "open"
    assert parlay["odds_american"] is not None
    assert len(parlay["legs"]) == 2

    conn = sqlite3.connect(db)
    conn.execute("UPDATE tracked_picks SET lifecycle='graded', result='win' WHERE id=?", (leg1["id"],))
    conn.execute("UPDATE tracked_picks SET lifecycle='graded', result='loss' WHERE id=?", (leg2["id"],))
    conn.commit()
    conn.close()

    settled = sync_parlay_results(db)
    assert settled["rows_settled"] == 1

    conn = sqlite3.connect(db)
    row = conn.execute("SELECT lifecycle, result, pnl_units FROM tracked_parlays WHERE id=?", (parlay["id"],)).fetchone()
    conn.close()
    assert row[0] == "graded"
    assert row[1] == "loss"
    assert row[2] == -1.0



def test_operator_parlay_publish_state_can_be_marked_for_feed(tmp_path: Path) -> None:
    db = tmp_path / "tracked_picks.db"
    leg1 = add_operator_pick(sport="mlb", matchup_label="A @ B", market="h2h", side="home", target_db=db)
    leg2 = add_operator_pick(sport="mlb", matchup_label="C @ D", market="spreads", side="away", line=-1.5, target_db=db)

    parlay = add_operator_parlay(pick_ids=[leg1["id"], leg2["id"]], label="Feed-ready two-leg", target_db=db)
    assert parlay["publish_state"] == "internal"

    updated = update_parlay_publish_state(parlay_id=parlay["id"], publish_state="signal_feed", target_db=db)
    assert updated["publish_state"] == "signal_feed"
    assert [leg["id"] for leg in updated["legs"]] == [leg1["id"], leg2["id"]]

    hidden = update_parlay_publish_state(parlay_id=parlay["id"], publish_state="hidden", target_db=db)
    assert hidden["publish_state"] == "hidden"
