"""One-time: generate model_performance.csv from predictions table in signal_log.db."""
import csv, sqlite3
from pathlib import Path

ROOT    = Path("/app")
DB      = ROOT / "ml/nba_spread/data/signal_log.db"
OUT_CSV = ROOT / "ml/nba_spread/data/model_performance.csv"

COLS = [
    "logged_at","game_id","commence_time","season","home_team","away_team",
    "home_line","home_cover_prob","away_cover_prob","pick_side","pick_confidence",
    "is_bet","model_version","actual_home_covered","result_status","correct","notes",
    "home_injury_impact","away_injury_impact","pinnacle_prob","edge_vs_pinnacle",
    "threshold_used","injury_data_available","features_json","is_pinnacle_bet","matchup_context",
]

conn = sqlite3.connect(DB)
conn.row_factory = sqlite3.Row
rows = conn.execute("SELECT * FROM predictions ORDER BY logged_at ASC").fetchall()
conn.close()

if not rows:
    print("No predictions found — nothing to write.")
    raise SystemExit(0)

def map_row(r):
    d = dict(r)
    # Map predictions columns → csv columns
    return {
        "logged_at":           d.get("logged_at", ""),
        "game_id":             d.get("game_id", ""),
        "commence_time":       d.get("commence_time", ""),
        "season":              d.get("season", ""),
        "home_team":           d.get("home_team", ""),
        "away_team":           d.get("away_team", ""),
        "home_line":           d.get("spread_line", ""),
        "home_cover_prob":     d.get("home_cover_prob", ""),
        "away_cover_prob":     round(1.0 - float(d["home_cover_prob"]), 5) if d.get("home_cover_prob") is not None else "",
        "pick_side":           d.get("predicted_winner", ""),
        "pick_confidence":     d.get("confidence", ""),
        "is_bet":              d.get("is_bet", 0),
        "model_version":       d.get("model_version", ""),
        "actual_home_covered": d.get("actual_home_covered", ""),
        "result_status":       d.get("result", "pending"),
        "correct":             d.get("correct", ""),
        "notes":               d.get("notes", ""),
        "home_injury_impact":  d.get("home_injury_impact", ""),
        "away_injury_impact":  d.get("away_injury_impact", ""),
        "pinnacle_prob":       d.get("pinnacle_prob", ""),
        "edge_vs_pinnacle":    d.get("edge_vs_pinnacle", ""),
        "threshold_used":      d.get("threshold_used", ""),
        "injury_data_available": d.get("injury_data_available", ""),
        "features_json":       "",   # stripped — model IP
        "is_pinnacle_bet":     d.get("is_pinnacle_bet", ""),
        "matchup_context":     d.get("matchup_context", ""),
    }

with open(OUT_CSV, "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=COLS)
    w.writeheader()
    for r in rows:
        w.writerow(map_row(r))

print(f"Written {len(rows)} rows to {OUT_CSV}")
