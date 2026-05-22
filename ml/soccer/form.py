"""
Team-form ingestor — football-data.co.uk CSV downloads.

Free, no API key, no quota, no bot-blocking. football-data.co.uk publishes
season-long CSV files for the major European leagues, explicitly designed
for betting analytics. URL pattern:

    https://www.football-data.co.uk/mmz4281/{season}/{code}.csv

Where season is YY-next-YY (2025-26 = "2526") and code identifies the league:
    E0  Premier League
    SP1 La Liga
    D1  Bundesliga
    I1  Serie A
    F1  Ligue 1

We pull each league once daily (5 small HTTP requests, ~50KB each) and upsert
into soccer_team_form. Two rows per actual fixture — one for each team's
perspective — so `get_recent_form("Liverpool", 5, venue="home")` is a
trivial indexed query.

xG columns are nullable here (this source doesn't publish xG); we can layer
Understat later if we want xG-aware narratives. For v1, recent W-D-L + goals
is enough to compose narratives that beat the current statistical filler.

Why not FBref:
    - Excellent xG data BUT Cloudflare-protected. Returns 403 to anything
      that isn't a real browser. Defeating that is a maintenance burden.
    - football-data.co.uk is explicitly meant to be downloaded by scripts.

Run as a module:
    python3 -m ml.soccer.form sync_all
    python3 -m ml.soccer.form status
"""
from __future__ import annotations

import io
import os
import sqlite3
import sys
import time
from csv import DictReader
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx


# ── DB path resolution (matches the rest of the soccer/WC modules) ──────────

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent  # ace-app/
DB_PATH = _REPO_ROOT / "ml" / "nba_spread" / "data" / "wc_signal_log.db"


def get_db(path: Optional[Path] = None) -> sqlite3.Connection:
    p = path or DB_PATH
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(p))
    conn.row_factory = sqlite3.Row
    return conn


# ── Schema ───────────────────────────────────────────────────────────────────

def init_form_tables(path: Optional[Path] = None) -> None:
    """Add the team-form table. Additive only — never disturbs other modules."""
    conn = get_db(path)
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS soccer_team_form (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            team_name       TEXT NOT NULL,
            league          TEXT NOT NULL,
            match_date      DATE NOT NULL,
            opponent        TEXT NOT NULL,
            venue           TEXT NOT NULL CHECK (venue IN ('home','away')),
            goals_for       INTEGER,
            goals_against   INTEGER,
            xg_for          REAL,
            xg_against      REAL,
            result          TEXT CHECK (result IN ('W','D','L')),
            updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(team_name, match_date, opponent)
        );
        CREATE INDEX IF NOT EXISTS idx_form_team_date
            ON soccer_team_form(team_name, match_date DESC);
        CREATE INDEX IF NOT EXISTS idx_form_league_date
            ON soccer_team_form(league, match_date DESC);
    """)
    conn.commit()
    conn.close()


# ── Source catalog ───────────────────────────────────────────────────────────

FD_LEAGUES: List[Tuple[str, str]] = [
    ("Premier League", "E0"),
    ("La Liga",        "SP1"),
    ("Bundesliga",     "D1"),
    ("Serie A",        "I1"),
    ("Ligue 1",        "F1"),
]


def _current_season_code(today: Optional[datetime] = None) -> str:
    """football-data uses YY-next-YY format: '2526' = 2025-26 season.
    European seasons run Aug→May. If we're June/July, the 'current' season
    is technically last one until the new one starts mid-August."""
    d = today or datetime.now(timezone.utc)
    yr = d.year % 100
    # Aug-Dec: current season starts THIS year. Jan-Jul: started LAST year.
    if d.month >= 8:
        return f"{yr:02d}{(yr + 1) % 100:02d}"
    return f"{(yr - 1) % 100:02d}{yr:02d}"


def _season_codes_back(n: int, today: Optional[datetime] = None) -> List[str]:
    """Return [current_season, current_season-1, ..., n total] as football-data
    season codes. Used to pull multiple seasons of history for H2H lookups
    where 'last 5 meetings' might span 2-3 seasons.
    """
    d = today or datetime.now(timezone.utc)
    yr = d.year % 100
    if d.month >= 8:
        start_yr = yr
    else:
        start_yr = (yr - 1) % 100
    out: List[str] = []
    for i in range(n):
        y0 = (start_yr - i) % 100
        y1 = (start_yr - i + 1) % 100
        out.append(f"{y0:02d}{y1:02d}")
    return out


# How many past seasons of fixtures to pull. Three covers ~3 years of H2H
# history — enough for "last 5 meetings" queries even between teams that
# don't play often (e.g. promoted/relegated club vs an established side).
_SEASONS_BACK = int(os.getenv("FD_SEASONS_BACK", "3"))


# ── Fetcher ──────────────────────────────────────────────────────────────────

_HEADERS = {
    "User-Agent": "ace-app/0.1 (betting-research; sprizzystreams@gmail.com)",
    "Accept": "text/csv,*/*",
}

# Polite delay between league requests. Their server is small + free; don't
# hammer. 2s is plenty for 5 leagues = ~10s total per sync.
_PACE_S = float(os.getenv("FD_MIN_INTERVAL_S", "2"))


def _fetch_csv(code: str, season: str) -> Optional[str]:
    """Pull one league's season CSV. Returns text or None on error."""
    url = f"https://www.football-data.co.uk/mmz4281/{season}/{code}.csv"
    try:
        time.sleep(_PACE_S)
        resp = httpx.get(url, headers=_HEADERS, timeout=20, follow_redirects=True)
        if resp.status_code == 404:
            # Season not yet published / wrong format
            print(f"  [form] {code} season {season} not found (404)", file=sys.stderr)
            return None
        if resp.status_code != 200:
            print(f"  [form] {code} HTTP {resp.status_code}", file=sys.stderr)
            return None
        # football-data sometimes serves windows-1252 encoded text
        try:
            return resp.content.decode("utf-8")
        except UnicodeDecodeError:
            return resp.content.decode("latin-1", errors="replace")
    except Exception as e:
        print(f"  [form] {code} fetch error: {e}", file=sys.stderr)
        return None


# ── Parser ───────────────────────────────────────────────────────────────────

def _parse_date(s: str) -> Optional[str]:
    """football-data emits dates as DD/MM/YYYY or DD/MM/YY. Return ISO YYYY-MM-DD."""
    s = (s or "").strip()
    for fmt in ("%d/%m/%Y", "%d/%m/%y"):
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def _parse_completed_matches(csv_text: str) -> List[Dict[str, Any]]:
    """Returns one dict per fixture with home/away/score. Skips rows with
    empty scores (rows for unplayed matches — football-data sometimes
    includes those at the bottom of a partial-season file).
    """
    out: List[Dict[str, Any]] = []
    reader = DictReader(io.StringIO(csv_text))
    for row in reader:
        date_iso = _parse_date(row.get("Date") or "")
        home = (row.get("HomeTeam") or "").strip()
        away = (row.get("AwayTeam") or "").strip()
        fthg = (row.get("FTHG") or "").strip()
        ftag = (row.get("FTAG") or "").strip()
        if not (date_iso and home and away and fthg and ftag):
            continue
        try:
            gh, ga = int(fthg), int(ftag)
        except ValueError:
            continue
        out.append({
            "date": date_iso,
            "home": home,
            "away": away,
            "gh":   gh,
            "ga":   ga,
        })
    return out


# ── Writer ───────────────────────────────────────────────────────────────────

def _result_for(team_goals: int, opp_goals: int) -> str:
    if team_goals > opp_goals: return "W"
    if team_goals < opp_goals: return "L"
    return "D"


def _upsert_match(conn: sqlite3.Connection, league: str, m: Dict[str, Any]) -> int:
    rows = [
        (m["home"], league, m["date"], m["away"], "home",
         m["gh"], m["ga"], None, None, _result_for(m["gh"], m["ga"])),
        (m["away"], league, m["date"], m["home"], "away",
         m["ga"], m["gh"], None, None, _result_for(m["ga"], m["gh"])),
    ]
    written = 0
    for r in rows:
        cur = conn.execute(
            """
            INSERT INTO soccer_team_form
                (team_name, league, match_date, opponent, venue,
                 goals_for, goals_against, xg_for, xg_against, result)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(team_name, match_date, opponent) DO UPDATE SET
                goals_for     = excluded.goals_for,
                goals_against = excluded.goals_against,
                result        = excluded.result,
                updated_at    = datetime('now')
            """,
            r,
        )
        if cur.rowcount > 0:
            written += 1
    return written


def sync_league(league: str, code: str, season: Optional[str] = None,
                path: Optional[Path] = None) -> int:
    """Pull one league's CSV for one specific season and upsert. Returns
    row count. By default targets the current season; pass `season='2425'`
    etc. for historical pulls. Past-season CSVs don't change after the
    season closes, so re-pulling is cheap (idempotent upsert) but mostly
    unnecessary after the first ingest."""
    init_form_tables(path)
    csv_text = _fetch_csv(code, season or _current_season_code())
    if csv_text is None:
        return 0
    matches = _parse_completed_matches(csv_text)
    season_label = season or _current_season_code()
    print(f"  [form] {league} {season_label}: {len(matches)} completed matches parsed",
          flush=True)
    if not matches:
        return 0
    conn = get_db(path)
    written = 0
    try:
        for m in matches:
            written += _upsert_match(conn, league, m)
        conn.commit()
    finally:
        conn.close()
    print(f"  [form] {league} {season_label}: {written} rows written", flush=True)
    return written


def sync_league_multi_season(league: str, code: str, n_seasons: int = _SEASONS_BACK,
                              path: Optional[Path] = None) -> int:
    """Pull the last `n_seasons` of one league. ~15-20s wall time for 3
    seasons given the polite-pace delay. Past seasons are static so this
    only really matters on the first run; subsequent syncs hit the cache
    locally (no API to cache; we just re-upsert and SQLite no-ops dupes)."""
    total = 0
    for season in _season_codes_back(n_seasons):
        total += sync_league(league, code, season, path)
    return total


def sync_all(path: Optional[Path] = None, n_seasons: int = _SEASONS_BACK) -> Dict[str, int]:
    """Refresh every Big 5 league across the last `n_seasons` seasons.
    First run: ~75s wall time for 5 leagues × 3 seasons = 15 CSVs.
    Daily re-runs: same wall time but mostly no-op upserts on past seasons,
    only the current-season CSV brings new data.
    """
    init_form_tables(path)
    out: Dict[str, int] = {}
    for league, code in FD_LEAGUES:
        try:
            out[league] = sync_league_multi_season(league, code, n_seasons, path)
        except Exception as e:
            print(f"  [form] {league} failed: {e}", file=sys.stderr)
            out[league] = 0
    return out


# ── Read helpers (used by the explainer) ─────────────────────────────────────

def get_recent_form(
    team_name: str,
    n: int = 5,
    venue: Optional[str] = None,
    before_date: Optional[str] = None,
    path: Optional[Path] = None,
) -> List[Dict[str, Any]]:
    """Last N completed matches for `team_name` before `before_date`
    (default: today), optionally filtered to home/away. Sorted newest-first.

    Usage from the explainer:
        get_recent_form("Liverpool", n=5, venue="home")
    """
    init_form_tables(path)
    before = before_date or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    sql = (
        "SELECT match_date, opponent, venue, goals_for, goals_against, "
        "       xg_for, xg_against, result "
        "FROM soccer_team_form WHERE team_name = ? AND match_date < ?"
    )
    params: List[Any] = [team_name, before]
    if venue in ("home", "away"):
        sql += " AND venue = ?"
        params.append(venue)
    sql += " ORDER BY match_date DESC LIMIT ?"
    params.append(n)
    conn = get_db(path)
    rows = [dict(r) for r in conn.execute(sql, params).fetchall()]
    conn.close()
    return rows


def get_h2h(
    team_a: str, team_b: str,
    n: int = 5,
    before_date: Optional[str] = None,
    path: Optional[Path] = None,
) -> List[Dict[str, Any]]:
    """Return the last N completed matches between team_a and team_b before
    `before_date` (default: today). Sorted newest-first. Rows are from team_a's
    perspective — i.e. `result` is 'W' if team_a won, 'L' if team_b won.

    Used by the explainer to compose lines like:
        "Last 5 meetings: Liverpool 3W-1D-1L vs Brighton, +6 goal differential."
    """
    init_form_tables(path)
    before = before_date or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    conn = get_db(path)
    try:
        rows = conn.execute(
            "SELECT match_date, opponent, venue, goals_for, goals_against, "
            "       xg_for, xg_against, result "
            "FROM soccer_team_form "
            "WHERE team_name = ? AND opponent = ? AND match_date < ? "
            "ORDER BY match_date DESC LIMIT ?",
            (team_a, team_b, before, n),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def summarize_h2h(rows: List[Dict[str, Any]], team_a: str, team_b: str) -> Dict[str, Any]:
    """Compress H2H rows into a narrative-ready summary.

    Output:
      {"record": "3W-1D-1L", "n": 5, "goal_diff": +6,
       "team_a_goals": 11, "team_b_goals": 5}

    `record` is from team_a's perspective. `goal_diff` is team_a_goals minus
    team_b_goals across all matches sampled. Empty rows → all-zero summary.
    """
    if not rows:
        return {"record": "—", "n": 0, "goal_diff": 0,
                "team_a_goals": 0, "team_b_goals": 0,
                "team_a": team_a, "team_b": team_b}
    w = sum(1 for r in rows if r["result"] == "W")
    d = sum(1 for r in rows if r["result"] == "D")
    l = sum(1 for r in rows if r["result"] == "L")
    gf = sum((r["goals_for"] or 0) for r in rows)
    ga = sum((r["goals_against"] or 0) for r in rows)
    return {
        "record":       f"{w}W-{d}D-{l}L",
        "n":            len(rows),
        "goal_diff":    gf - ga,
        "team_a_goals": gf,
        "team_b_goals": ga,
        "team_a":       team_a,
        "team_b":       team_b,
    }


def summarize_form(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Compress recent-form rows into a single dict the explainer can read.

    Output shape:
        {"record": "3W-1D-1L", "n": 5, "gf": 8, "ga": 3,
         "xg_for": None, "xg_against": None}
    """
    if not rows:
        return {"record": "—", "n": 0, "gf": 0, "ga": 0, "xg_for": None, "xg_against": None}
    w = sum(1 for r in rows if r["result"] == "W")
    d = sum(1 for r in rows if r["result"] == "D")
    l = sum(1 for r in rows if r["result"] == "L")
    gf = sum((r["goals_for"] or 0) for r in rows)
    ga = sum((r["goals_against"] or 0) for r in rows)
    xg_for_vals     = [r["xg_for"]     for r in rows if r["xg_for"]     is not None]
    xg_against_vals = [r["xg_against"] for r in rows if r["xg_against"] is not None]
    return {
        "record":     f"{w}W-{d}D-{l}L",
        "n":          len(rows),
        "gf":         gf,
        "ga":         ga,
        "xg_for":     round(sum(xg_for_vals), 2)     if xg_for_vals     else None,
        "xg_against": round(sum(xg_against_vals), 2) if xg_against_vals else None,
    }


def get_goal_pace(
    team_name: str,
    n: int = 10,
    venue: Optional[str] = None,
    before_date: Optional[str] = None,
    path: Optional[Path] = None,
) -> Dict[str, Any]:
    """Per-game goals-for / goals-against rates across the last N matches.
    Used by the explainer on totals picks: "Liverpool home avg 3.2 goals/
    game" etc. Bigger sample (default 10) than form (default 5) because
    pace stabilizes faster than W-L noise.

    Output:
        {"per_game_for": 2.4, "per_game_against": 1.1,
         "combined": 3.5, "n": 10}
    """
    init_form_tables(path)
    before = before_date or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    sql = (
        "SELECT goals_for, goals_against FROM soccer_team_form "
        "WHERE team_name = ? AND match_date < ?"
    )
    params: List[Any] = [team_name, before]
    if venue in ("home", "away"):
        sql += " AND venue = ?"
        params.append(venue)
    sql += " ORDER BY match_date DESC LIMIT ?"
    params.append(n)
    conn = get_db(path)
    rows = [dict(r) for r in conn.execute(sql, params).fetchall()]
    conn.close()
    if not rows:
        return {"per_game_for": None, "per_game_against": None,
                "combined": None, "n": 0}
    gf = sum((r["goals_for"] or 0) for r in rows)
    ga = sum((r["goals_against"] or 0) for r in rows)
    n_actual = len(rows)
    return {
        "per_game_for":     round(gf / n_actual, 2),
        "per_game_against": round(ga / n_actual, 2),
        "combined":         round((gf + ga) / n_actual, 2),
        "n":                n_actual,
    }


def status(path: Optional[Path] = None) -> Dict[str, Any]:
    """Row counts per league + last-match-date. Used by the ops dashboard."""
    init_form_tables(path)
    conn = get_db(path)
    rows = conn.execute(
        "SELECT league, COUNT(*) AS n, MAX(match_date) AS last_match "
        "FROM soccer_team_form GROUP BY league ORDER BY league"
    ).fetchall()
    out: Dict[str, Any] = {"by_league": [dict(r) for r in rows]}
    total = conn.execute("SELECT COUNT(*) FROM soccer_team_form").fetchone()[0]
    out["total_rows"] = int(total)
    conn.close()
    return out


# ── CLI ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "sync_all"
    if cmd == "sync_all":
        result = sync_all()
        print(f"\n[form] sync_all complete: {result}")
    elif cmd == "status":
        import json
        print(json.dumps(status(), indent=2, default=str))
    elif cmd.startswith("sync_league:"):
        # e.g. sync_league:E0
        code = cmd.split(":", 1)[1]
        for label, c in FD_LEAGUES:
            if c == code:
                sync_league(label, c)
                break
        else:
            print(f"unknown league code: {code}", file=sys.stderr)
            sys.exit(1)
    else:
        print("usage: python3 -m ml.soccer.form [sync_all|status|sync_league:<code>]",
              file=sys.stderr)
        sys.exit(1)
