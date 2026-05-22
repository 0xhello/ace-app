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
    """Pull one league's current season CSV and upsert. Returns row count."""
    init_form_tables(path)
    csv_text = _fetch_csv(code, season or _current_season_code())
    if csv_text is None:
        return 0
    matches = _parse_completed_matches(csv_text)
    print(f"  [form] {league}: {len(matches)} completed matches parsed", flush=True)
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
    print(f"  [form] {league}: {written} rows written", flush=True)
    return written


def sync_all(path: Optional[Path] = None) -> Dict[str, int]:
    """Refresh every Big 5 league. ~5 HTTP requests, ~12s total wall time.
    Idempotent — runs daily on the worker."""
    init_form_tables(path)
    out: Dict[str, int] = {}
    season = _current_season_code()
    for league, code in FD_LEAGUES:
        try:
            out[league] = sync_league(league, code, season, path)
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
