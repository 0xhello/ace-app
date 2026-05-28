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
    """Add the team-form table + additive feature columns. Safe to re-run —
    new columns are added via _migrate_form_table() so existing rows
    aren't dropped, just extended."""
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
    # Additive migration — bring older deployments up to current schema
    _migrate_form_table(conn)
    conn.commit()
    conn.close()


# Columns added in v2 of the schema (model features). Additive only.
_V2_COLUMNS: List[Tuple[str, str]] = [
    ("shots",         "INTEGER"),  # total shots for the team in this match
    ("shots_against", "INTEGER"),  # shots conceded
    ("sot",           "INTEGER"),  # shots on target for
    ("sot_against",   "INTEGER"),  # shots on target against
    ("corners",       "INTEGER"),
    ("corners_against","INTEGER"),
    ("fouls",         "INTEGER"),
    ("fouls_against", "INTEGER"),
    ("yellows",       "INTEGER"),
    ("yellows_against","INTEGER"),
    ("reds",          "INTEGER"),
    ("reds_against",  "INTEGER"),
    ("ht_goals_for",  "INTEGER"),  # half-time goals for
    ("ht_goals_against","INTEGER"),
    ("referee",       "TEXT"),     # match referee name
    # Closing odds (from football-data — used for backtest CLV calculation)
    ("close_home_odds","REAL"),    # Pinnacle closing decimal odds — home
    ("close_draw_odds","REAL"),    # Pinnacle closing — draw
    ("close_away_odds","REAL"),    # Pinnacle closing — away
    ("close_ou_line", "REAL"),     # Closing over/under line (usually 2.5)
    ("close_over_odds","REAL"),    # Pinnacle closing over
    ("close_under_odds","REAL"),   # Pinnacle closing under
    ("close_ah_line", "REAL"),     # Asian handicap line at close (home perspective)
    # BTTS closing odds (M31) — added so calibration.py can backtest BTTS
    # against Pinnacle close. football-data.co.uk recent CSVs expose these
    # under column names "BFEY"/"BFEN" (Betfair Exchange BTTS yes/no) or
    # "BbAvBTSY"/"BbAvBTSN" (Betbrain average). We prefer Betfair Exchange
    # when present (sharpest) and fall back to Betbrain average.
    ("close_btts_yes_odds", "REAL"),  # closing decimal odds — BTTS yes
    ("close_btts_no_odds",  "REAL"),  # closing decimal odds — BTTS no
]


def _migrate_form_table(conn: sqlite3.Connection) -> None:
    """Add any missing v2 columns to soccer_team_form. Idempotent."""
    existing = {r["name"] for r in conn.execute("PRAGMA table_info(soccer_team_form)").fetchall()}
    for col, typ in _V2_COLUMNS:
        if col not in existing:
            conn.execute(f"ALTER TABLE soccer_team_form ADD COLUMN {col} {typ}")


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


def _int_or_none(s: Any) -> Optional[int]:
    try:
        return int((s or "").strip()) if str(s).strip() else None
    except (ValueError, TypeError):
        return None


def _float_or_none(s: Any) -> Optional[float]:
    try:
        v = (s or "").strip() if isinstance(s, str) else s
        return float(v) if v not in (None, "", "NA", "N/A") else None
    except (ValueError, TypeError):
        return None


def _parse_completed_matches(csv_text: str) -> List[Dict[str, Any]]:
    """Returns one dict per fixture with full match data — score, shots,
    corners, cards, referee, and closing odds for backtest. Skips rows
    with empty scores (unplayed matches).

    Column reference (football-data.co.uk):
      HS/AS         = home/away total shots
      HST/AST       = home/away shots on target
      HC/AC         = home/away corners
      HF/AF         = home/away fouls
      HY/AY         = home/away yellow cards
      HR/AR         = home/away red cards
      HTHG/HTAG/HTR = half-time goals + result
      Referee       = match referee name
      PSCH/D/A      = Pinnacle CLOSING decimal odds (home/draw/away)
      PC>2.5 / PC<2.5 = Pinnacle CLOSING over/under 2.5 goals
      AHCh          = Asian handicap line at closing (home line)
      PCAHH / PCAHA = Pinnacle closing AH home / away odds
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
            "date":              date_iso,
            "home":              home,
            "away":              away,
            "gh":                gh,
            "ga":                ga,
            # Match flow features
            "ht_gh":             _int_or_none(row.get("HTHG")),
            "ht_ga":             _int_or_none(row.get("HTAG")),
            "shots_h":           _int_or_none(row.get("HS")),
            "shots_a":           _int_or_none(row.get("AS")),
            "sot_h":             _int_or_none(row.get("HST")),
            "sot_a":             _int_or_none(row.get("AST")),
            "corners_h":         _int_or_none(row.get("HC")),
            "corners_a":         _int_or_none(row.get("AC")),
            "fouls_h":           _int_or_none(row.get("HF")),
            "fouls_a":           _int_or_none(row.get("AF")),
            "yellows_h":         _int_or_none(row.get("HY")),
            "yellows_a":         _int_or_none(row.get("AY")),
            "reds_h":            _int_or_none(row.get("HR")),
            "reds_a":            _int_or_none(row.get("AR")),
            "referee":           (row.get("Referee") or "").strip() or None,
            # Closing odds (Pinnacle preferred; fall back to Bet365 if absent)
            "close_h":           _float_or_none(row.get("PSCH") or row.get("B365CH")),
            "close_d":           _float_or_none(row.get("PSCD") or row.get("B365CD")),
            "close_a":           _float_or_none(row.get("PSCA") or row.get("B365CA")),
            "close_over":        _float_or_none(row.get("PC>2.5") or row.get("B365C>2.5")),
            "close_under":       _float_or_none(row.get("PC<2.5") or row.get("B365C<2.5")),
            "close_ah_line":     _float_or_none(row.get("AHCh") or row.get("AHC")),
            # BTTS closing odds (M31). Column names vary across football-data
            # vintages: "PC_BTSY" (Pinnacle closing), "B365CBTSY" (Bet365 closing),
            # "BFEY" (Betfair Exchange BTTS yes), "AvgCBTSY" (closing average).
            # We try each in priority order; whichever fires first wins.
            "close_btts_yes":    _float_or_none(
                row.get("PC_BTSY") or row.get("B365CBTSY") or
                row.get("BFEY")    or row.get("AvgCBTSY")  or
                row.get("BbAvBTSY")
            ),
            "close_btts_no":     _float_or_none(
                row.get("PC_BTSN") or row.get("B365CBTSN") or
                row.get("BFEN")    or row.get("AvgCBTSN")  or
                row.get("BbAvBTSN")
            ),
        })
        # football-data.co.uk publishes dedicated Over/Under 2.5 odds columns
        # (PC>2.5 / PC<2.5, or B365 fallbacks), not a varying totals line.
        # The previous implementation accidentally stored AvgC>2.5 (an odds
        # value) as the line, which caused the backtest to silently skip almost
        # every totals market.
        if out[-1].get("close_over") is not None and out[-1].get("close_under") is not None:
            out[-1]["close_ou_line"] = 2.5
        else:
            out[-1]["close_ou_line"] = None
    return out


# ── Writer ───────────────────────────────────────────────────────────────────

def _result_for(team_goals: int, opp_goals: int) -> str:
    if team_goals > opp_goals: return "W"
    if team_goals < opp_goals: return "L"
    return "D"


def _upsert_match(conn: sqlite3.Connection, league: str, m: Dict[str, Any]) -> int:
    """Write home + away perspective rows with full v2 feature payload.

    Closing odds + AH line + over/under line are STORED ON BOTH rows for
    convenience even though they're a per-match fact — saves a join when
    backtesting per team.
    """
    # Common per-match fields
    ref       = m.get("referee")
    ou_line   = m.get("close_ou_line")
    ou_over   = m.get("close_over")
    ou_under  = m.get("close_under")
    ah_line   = m.get("close_ah_line")
    btts_y    = m.get("close_btts_yes")
    btts_n    = m.get("close_btts_no")
    c_h, c_d, c_a = m.get("close_h"), m.get("close_d"), m.get("close_a")

    # Home team perspective
    home_row = (
        m["home"], league, m["date"], m["away"], "home",
        m["gh"], m["ga"], None, None, _result_for(m["gh"], m["ga"]),
        m.get("shots_h"),    m.get("shots_a"),
        m.get("sot_h"),      m.get("sot_a"),
        m.get("corners_h"),  m.get("corners_a"),
        m.get("fouls_h"),    m.get("fouls_a"),
        m.get("yellows_h"),  m.get("yellows_a"),
        m.get("reds_h"),     m.get("reds_a"),
        m.get("ht_gh"),      m.get("ht_ga"),
        ref,
        c_h, c_d, c_a,
        ou_line, ou_over, ou_under,
        ah_line,
        btts_y, btts_n,
    )
    # Away team perspective — mirror the per-side fields
    away_row = (
        m["away"], league, m["date"], m["home"], "away",
        m["ga"], m["gh"], None, None, _result_for(m["ga"], m["gh"]),
        m.get("shots_a"),    m.get("shots_h"),
        m.get("sot_a"),      m.get("sot_h"),
        m.get("corners_a"),  m.get("corners_h"),
        m.get("fouls_a"),    m.get("fouls_h"),
        m.get("yellows_a"),  m.get("yellows_h"),
        m.get("reds_a"),     m.get("reds_h"),
        m.get("ht_ga"),      m.get("ht_gh"),
        ref,
        c_h, c_d, c_a,
        ou_line, ou_over, ou_under,
        ah_line,
        btts_y, btts_n,
    )

    written = 0
    for r in (home_row, away_row):
        cur = conn.execute(
            """
            INSERT INTO soccer_team_form
                (team_name, league, match_date, opponent, venue,
                 goals_for, goals_against, xg_for, xg_against, result,
                 shots, shots_against, sot, sot_against,
                 corners, corners_against,
                 fouls, fouls_against,
                 yellows, yellows_against,
                 reds, reds_against,
                 ht_goals_for, ht_goals_against,
                 referee,
                 close_home_odds, close_draw_odds, close_away_odds,
                 close_ou_line, close_over_odds, close_under_odds,
                 close_ah_line,
                 close_btts_yes_odds, close_btts_no_odds)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?,
                    ?, ?,
                    ?, ?,
                    ?, ?,
                    ?, ?,
                    ?, ?,
                    ?,
                    ?, ?, ?,
                    ?, ?, ?,
                    ?,
                    ?, ?)
            ON CONFLICT(team_name, match_date, opponent) DO UPDATE SET
                goals_for       = excluded.goals_for,
                goals_against   = excluded.goals_against,
                result          = excluded.result,
                shots           = excluded.shots,
                shots_against   = excluded.shots_against,
                sot             = excluded.sot,
                sot_against     = excluded.sot_against,
                corners         = excluded.corners,
                corners_against = excluded.corners_against,
                fouls           = excluded.fouls,
                fouls_against   = excluded.fouls_against,
                yellows         = excluded.yellows,
                yellows_against = excluded.yellows_against,
                reds            = excluded.reds,
                reds_against    = excluded.reds_against,
                ht_goals_for    = excluded.ht_goals_for,
                ht_goals_against= excluded.ht_goals_against,
                referee         = excluded.referee,
                close_home_odds = excluded.close_home_odds,
                close_draw_odds = excluded.close_draw_odds,
                close_away_odds = excluded.close_away_odds,
                close_ou_line   = excluded.close_ou_line,
                close_over_odds = excluded.close_over_odds,
                close_under_odds= excluded.close_under_odds,
                close_ah_line   = excluded.close_ah_line,
                close_btts_yes_odds = excluded.close_btts_yes_odds,
                close_btts_no_odds  = excluded.close_btts_no_odds,
                updated_at      = datetime('now')
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
