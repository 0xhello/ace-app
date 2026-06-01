#!/usr/bin/env python3
"""sportmonks_historical.py — historical odds + outcomes ingestion (M48).

The foundation for Phase 3 model validation. football-data.co.uk gave us
closing odds for only 1X2 + Totals. Sportmonks carries historical pre-match
odds across 21 bookmakers and 173 markets — including the ones we couldn't
backtest before: corners, BTTS, and anytime-scorer.

This module pulls finished fixtures with their odds + events + final score,
extracts the CLOSING line per target market (the last bookmaker update
before kickoff), and stores everything in two backtest-friendly tables:

  soccer_hist_fixtures      — one row per fixture: teams, final score,
                              total goals, BTTS outcome, corners total,
                              goal-scorer list.
  soccer_hist_closing_odds  — one row per (fixture, market, selection):
                              closing American + decimal odds, median +
                              best across books, book count.

The backtest (M40.2) joins these two: for each (fixture, market, selection)
it has both the model's prediction input (outcomes) and the real closing
price to measure ROI against.

Target markets (Sportmonks market_id):
    1   Fulltime Result      → moneyline (Home/Draw/Away)
    80  Goals Over/Under     → totals (Over/Under at each line)
    14  Both Teams To Score  → BTTS (Yes/No)
    67  Corners Over Under   → corners (Over/Under at each line)
    90  Goalscorers          → anytime / first / last scorer (per player)
    331 Player to Score      → anytime scorer (per player)

Credit budget: each fixture = 1 API call (~4,500 odds rows). The account
has 50k+ calls/hour headroom, so a full multi-season Big-5 pull (~9,000
fixtures) is affordable. Resumable: skips fixtures already ingested.
"""
from __future__ import annotations

import json
import os
import sqlite3
import statistics as _stats
import time
from datetime import datetime, timedelta, timezone, date
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import httpx
from dotenv import load_dotenv

from ml.world_cup.signal_logger import DB_PATH as DEFAULT_DB_PATH

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
load_dotenv(_REPO_ROOT / ".env.local")

SPORTMONKS_BASE = "https://api.sportmonks.com/v3/football"

# Sportmonks league_ids — mirror sportmonks_fixture.py
HISTORICAL_LEAGUE_IDS: Dict[str, int] = {
    "Premier League": 8,
    "La Liga":        564,
    "Bundesliga":     82,
    "Serie A":        384,
    "Ligue 1":        301,
    "UCL":            2,
}

# Target market_ids → friendly name. Only these are stored (out of 173).
TARGET_MARKETS: Dict[int, str] = {
    1:   "fulltime_result",   # moneyline
    80:  "goals_over_under",  # totals
    14:  "btts",
    67:  "corners_over_under",
    90:  "goalscorers",       # anytime/first/last
    331: "player_to_score",   # anytime
}

# Goal event type_ids (from M43): regular + penalty. Exclude own goals (15)
# and cancelled (18).
_GOAL_EVENT_TYPE_IDS = {14, 16}

# Includes for one historical fixture pull. odds is the big one (~4.5k rows);
# the rest give us outcomes.
_HISTORICAL_INCLUDES = (
    "odds;events.player;participants;scores;statistics.type;state"
)


# ── Auth + HTTP ────────────────────────────────────────────────────────────

def _get_token() -> str:
    tok = os.getenv("SPORTMONKS_API_TOKEN") or os.getenv("SPORTMONKS_TOKEN") or ""
    if not tok:
        raise EnvironmentError("SPORTMONKS_API_TOKEN not set — put it in .env.local")
    return tok


def _get(path: str, params: Optional[Dict[str, Any]] = None,
         *, timeout: float = 30.0, retries: int = 3) -> Dict[str, Any]:
    token = _get_token()
    merged = {"api_token": token, **(params or {})}
    url = f"{SPORTMONKS_BASE}{path}"
    last: Optional[Exception] = None
    for attempt in range(retries + 1):
        try:
            r = httpx.get(url, params=merged, timeout=timeout)
            if r.status_code in (429, 502, 503, 504):
                time.sleep(2 ** attempt)
                continue
            r.raise_for_status()
            return r.json()
        except Exception as exc:  # noqa: BLE001
            last = exc
            if attempt < retries:
                time.sleep(2 ** attempt)
                continue
            raise
    if last:
        raise last
    return {}


# ── Schema ─────────────────────────────────────────────────────────────────

def _db(path: Optional[Path] = None) -> sqlite3.Connection:
    p = path or DEFAULT_DB_PATH
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(p))
    conn.row_factory = sqlite3.Row
    return conn


def init_tables(path: Optional[Path] = None) -> None:
    conn = _db(path)
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS soccer_hist_fixtures (
                fixture_id        INTEGER PRIMARY KEY,
                league_id         INTEGER,
                league_name       TEXT,
                starting_at       TEXT,           -- ISO UTC kickoff
                home_team_id      INTEGER,
                away_team_id      INTEGER,
                home_team_name    TEXT,
                away_team_name    TEXT,
                home_score        INTEGER,
                away_score        INTEGER,
                total_goals       INTEGER,
                btts              INTEGER,         -- 1 if both teams scored
                corners_total     INTEGER,         -- from statistics, may be NULL
                goal_scorers_json TEXT,            -- ordered list of scorer names
                state             TEXT,            -- FT / etc.
                ingested_at       TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_histfx_league_date
              ON soccer_hist_fixtures(league_id, starting_at);

            CREATE TABLE IF NOT EXISTS soccer_hist_closing_odds (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                fixture_id        INTEGER NOT NULL,
                market_id         INTEGER NOT NULL,
                market_name       TEXT NOT NULL,
                selection         TEXT,            -- Home/Draw/Away, Over/Under, Yes/No, Anytime...
                line              REAL,            -- 2.5 for totals/corners, NULL otherwise
                player_name       TEXT,            -- for scorer markets, else NULL
                closing_american  REAL,            -- median American across books
                closing_decimal   REAL,            -- median decimal across books
                best_american     REAL,            -- best (highest payout) across books
                best_decimal      REAL,
                n_books           INTEGER,
                ingested_at       TEXT NOT NULL,
                UNIQUE(fixture_id, market_id, selection, line, player_name)
            );
            CREATE INDEX IF NOT EXISTS idx_histodds_fixture
              ON soccer_hist_closing_odds(fixture_id, market_id);
            """
        )
        conn.commit()
    finally:
        conn.close()


# ── Odds → decimal helpers ─────────────────────────────────────────────────

def _american_to_decimal(american: float) -> float:
    a = float(american)
    return a / 100.0 + 1.0 if a >= 0 else 100.0 / (-a) + 1.0


def _decimal_to_american(decimal: float) -> float:
    d = float(decimal)
    if d <= 1.0:
        return 0.0
    return round((d - 1.0) * 100.0) if d >= 2.0 else round(-100.0 / (d - 1.0))


def _parse_kickoff(starting_at: Optional[str]) -> Optional[datetime]:
    if not starting_at:
        return None
    try:
        s = starting_at.replace("T", " ").replace("Z", "")
        return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _parse_update(ts: Optional[str]) -> Optional[datetime]:
    if not ts:
        return None
    try:
        s = ts.replace("T", " ").replace("Z", "").split(".")[0]
        return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)
    except Exception:
        return None


# ── Closing-line extraction ────────────────────────────────────────────────

def _selection_key(market_id: int, o: Dict[str, Any]) -> Optional[Tuple[str, Optional[float], Optional[str]]]:
    """Build the (selection, line, player_name) key for one odds row, or None
    if it's not a row we want to keep for this market."""
    label = (o.get("label") or o.get("name") or "").strip()
    name = (o.get("name") or "").strip()
    total = o.get("total")
    handicap = o.get("handicap")

    if market_id == 1:  # Fulltime Result — label is Home/Draw/Away
        if label in ("Home", "Draw", "Away"):
            return (label, None, None)
        return None
    if market_id == 80:  # Goals Over/Under — label Over/Under, total=line
        if label in ("Over", "Under") and total is not None:
            try:
                return (label, float(total), None)
            except (TypeError, ValueError):
                return None
        return None
    if market_id == 14:  # BTTS — label Yes/No
        if label in ("Yes", "No"):
            return (label, None, None)
        return None
    if market_id == 67:  # Corners Over Under — label Over/Under, total=line
        if label in ("Over", "Under") and total is not None:
            try:
                return (label, float(total), None)
            except (TypeError, ValueError):
                return None
        return None
    if market_id in (90, 331):  # scorer markets — label Anytime/First/Last, name=player
        # market 90 Goalscorers uses label for the variant + name for player
        # market 331 Player to Score uses label "Score" + name for player
        variant = label if label in ("Anytime", "First", "Last") else "Anytime"
        if name and name not in ("Over", "Under", "Yes", "No"):
            return (variant, None, name)
        return None
    return None


def _extract_closing_odds(
    fixture_id: int,
    odds_rows: List[Dict[str, Any]],
    kickoff: Optional[datetime],
) -> List[Dict[str, Any]]:
    """For each target market + selection, find the closing line (latest
    bookmaker update at/ before kickoff) per bookmaker, then aggregate
    median + best across bookmakers."""
    # group[(market_id, selection, line, player)] = { bookmaker_id: (update_dt, decimal) }
    grouped: Dict[Tuple[int, str, Optional[float], Optional[str]], Dict[int, Tuple[Optional[datetime], float]]] = {}

    for o in odds_rows:
        mid = o.get("market_id")
        if mid not in TARGET_MARKETS:
            continue
        key_parts = _selection_key(mid, o)
        if not key_parts:
            continue
        selection, line, player = key_parts
        # decimal price — prefer dp3, fall back to value, fall back to american
        dec = None
        for fld in ("dp3", "value"):
            v = o.get(fld)
            if v is not None:
                try:
                    dec = float(v)
                    break
                except (TypeError, ValueError):
                    pass
        if dec is None and o.get("american") is not None:
            try:
                dec = _american_to_decimal(float(o["american"]))
            except (TypeError, ValueError):
                dec = None
        if dec is None or dec <= 1.0:
            continue

        upd = _parse_update(o.get("latest_bookmaker_update"))
        # If we know kickoff, drop prices updated AFTER kickoff (in-play)
        if kickoff is not None and upd is not None and upd > kickoff + timedelta(minutes=5):
            continue

        bid = o.get("bookmaker_id") or 0
        gkey = (mid, selection, line, player)
        book_map = grouped.setdefault(gkey, {})
        prev = book_map.get(bid)
        # keep the LATEST update per bookmaker (= closing)
        if prev is None or (upd is not None and (prev[0] is None or upd > prev[0])):
            book_map[bid] = (upd, dec)

    out: List[Dict[str, Any]] = []
    now = datetime.now(timezone.utc).isoformat()
    for (mid, selection, line, player), book_map in grouped.items():
        decimals = [d for (_u, d) in book_map.values() if d and d > 1.0]
        if not decimals:
            continue
        median_dec = float(_stats.median(decimals))
        best_dec = float(max(decimals))  # highest decimal = best payout
        out.append({
            "fixture_id":       fixture_id,
            "market_id":        mid,
            "market_name":      TARGET_MARKETS[mid],
            "selection":        selection,
            "line":             line,
            "player_name":      player,
            "closing_american": _decimal_to_american(median_dec),
            "closing_decimal":  round(median_dec, 4),
            "best_american":    _decimal_to_american(best_dec),
            "best_decimal":     round(best_dec, 4),
            "n_books":          len(decimals),
            "ingested_at":      now,
        })
    return out


# ── Outcome extraction ─────────────────────────────────────────────────────

def _extract_outcomes(data: Dict[str, Any]) -> Dict[str, Any]:
    """Pull final score, BTTS, corners total, goal scorers from a fixture."""
    participants = data.get("participants") or []
    home_id = away_id = None
    home_name = away_name = None
    for p in participants:
        loc = (p.get("meta") or {}).get("location")
        if loc == "home":
            home_id, home_name = p.get("id"), p.get("name")
        elif loc == "away":
            away_id, away_name = p.get("id"), p.get("name")

    # Final score from scores (CURRENT description)
    hs = as_ = None
    for s in data.get("scores") or []:
        if s.get("description") == "CURRENT":
            sc = s.get("score") or {}
            if s.get("participant_id") == home_id:
                hs = int(sc.get("goals") or 0)
            elif s.get("participant_id") == away_id:
                as_ = int(sc.get("goals") or 0)

    # Goal scorers (ordered)
    scorers: List[str] = []
    for e in data.get("events") or []:
        if e.get("type_id") in _GOAL_EVENT_TYPE_IDS:
            nm = e.get("player_name") or (e.get("player") or {}).get("display_name")
            if nm:
                scorers.append(nm)

    # Corners total from statistics
    corners_total = None
    for st in data.get("statistics") or []:
        t = st.get("type") or {}
        if isinstance(t, dict) and (t.get("name") or "").lower() == "corners":
            val = (st.get("data") or {}).get("value")
            if val is not None:
                corners_total = (corners_total or 0) + int(val)

    total_goals = (hs + as_) if (hs is not None and as_ is not None) else None
    btts = (1 if (hs and as_ and hs >= 1 and as_ >= 1) else 0) if (hs is not None and as_ is not None) else None

    state = data.get("state") or {}
    state_name = state.get("name") if isinstance(state, dict) else None

    return {
        "home_team_id": home_id, "away_team_id": away_id,
        "home_team_name": home_name, "away_team_name": away_name,
        "home_score": hs, "away_score": as_,
        "total_goals": total_goals, "btts": btts,
        "corners_total": corners_total,
        "goal_scorers": scorers,
        "state": state_name,
    }


# ── Ingest one fixture ─────────────────────────────────────────────────────

def ingest_fixture(fixture_id: int, *, league_name: Optional[str] = None,
                   path: Optional[Path] = None) -> Dict[str, Any]:
    """Pull one fixture's odds + outcomes and persist. Returns a summary."""
    init_tables(path)
    payload = _get(f"/fixtures/{fixture_id}", {"include": _HISTORICAL_INCLUDES})
    data = payload.get("data") or {}
    if not data:
        return {"fixture_id": fixture_id, "ok": False, "reason": "no-data"}

    kickoff = _parse_kickoff(data.get("starting_at"))
    outcomes = _extract_outcomes(data)
    odds_rows = data.get("odds") or []
    closing = _extract_closing_odds(fixture_id, odds_rows, kickoff)

    conn = _db(path)
    now = datetime.now(timezone.utc).isoformat()
    try:
        conn.execute(
            """INSERT INTO soccer_hist_fixtures (
                  fixture_id, league_id, league_name, starting_at,
                  home_team_id, away_team_id, home_team_name, away_team_name,
                  home_score, away_score, total_goals, btts, corners_total,
                  goal_scorers_json, state, ingested_at
               ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(fixture_id) DO UPDATE SET
                  home_score=excluded.home_score,
                  away_score=excluded.away_score,
                  total_goals=excluded.total_goals,
                  btts=excluded.btts,
                  corners_total=excluded.corners_total,
                  goal_scorers_json=excluded.goal_scorers_json,
                  state=excluded.state,
                  ingested_at=excluded.ingested_at""",
            (fixture_id, data.get("league_id"), league_name,
             data.get("starting_at"),
             outcomes["home_team_id"], outcomes["away_team_id"],
             outcomes["home_team_name"], outcomes["away_team_name"],
             outcomes["home_score"], outcomes["away_score"],
             outcomes["total_goals"], outcomes["btts"], outcomes["corners_total"],
             json.dumps(outcomes["goal_scorers"], ensure_ascii=False),
             outcomes["state"], now),
        )
        for row in closing:
            conn.execute(
                """INSERT INTO soccer_hist_closing_odds (
                      fixture_id, market_id, market_name, selection, line,
                      player_name, closing_american, closing_decimal,
                      best_american, best_decimal, n_books, ingested_at
                   ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(fixture_id, market_id, selection, line, player_name)
                   DO UPDATE SET
                      closing_american=excluded.closing_american,
                      closing_decimal=excluded.closing_decimal,
                      best_american=excluded.best_american,
                      best_decimal=excluded.best_decimal,
                      n_books=excluded.n_books,
                      ingested_at=excluded.ingested_at""",
                (row["fixture_id"], row["market_id"], row["market_name"],
                 row["selection"], row["line"], row["player_name"],
                 row["closing_american"], row["closing_decimal"],
                 row["best_american"], row["best_decimal"],
                 row["n_books"], row["ingested_at"]),
            )
        conn.commit()
    finally:
        conn.close()

    # Summarize markets captured
    mkt_counts: Dict[str, int] = {}
    for row in closing:
        mkt_counts[row["market_name"]] = mkt_counts.get(row["market_name"], 0) + 1

    return {
        "fixture_id": fixture_id, "ok": True,
        "score": f"{outcomes['home_score']}-{outcomes['away_score']}",
        "scorers": len(outcomes["goal_scorers"]),
        "corners_total": outcomes["corners_total"],
        "closing_odds_rows": len(closing),
        "markets": mkt_counts,
    }


# ── Discover + bulk ingest ─────────────────────────────────────────────────

def _already_ingested(path: Optional[Path] = None) -> set:
    init_tables(path)
    conn = _db(path)
    try:
        return {r[0] for r in conn.execute(
            "SELECT fixture_id FROM soccer_hist_fixtures WHERE home_score IS NOT NULL"
        ).fetchall()}
    finally:
        conn.close()


def discover_finished_fixtures(date_from: date, date_to: date,
                               league_ids: List[int]) -> List[Dict[str, Any]]:
    leagues = set(league_ids)
    out: List[Dict[str, Any]] = []
    page = 1
    while True:
        payload = _get(
            f"/fixtures/between/{date_from.isoformat()}/{date_to.isoformat()}",
            {"include": "participants;league", "per_page": 100, "page": page},
        )
        for fx in payload.get("data") or []:
            if fx.get("league_id") in leagues and fx.get("result_info"):
                out.append(fx)
        pg = payload.get("pagination") or {}
        if not pg.get("has_more"):
            break
        page = int(pg.get("current_page") or page) + 1
        if page > 60:
            break
    return out


def ingest_range(*, date_from: date, date_to: date,
                 league_ids: Optional[List[int]] = None,
                 limit: Optional[int] = None,
                 sleep_between: float = 0.1,
                 path: Optional[Path] = None) -> Dict[str, Any]:
    """Discover finished fixtures in [date_from, date_to] and ingest each.
    Resumable — skips fixtures already ingested with a final score."""
    league_ids = league_ids or list(HISTORICAL_LEAGUE_IDS.values())
    discovered = discover_finished_fixtures(date_from, date_to, league_ids)
    done = _already_ingested(path)
    todo = [fx for fx in discovered if int(fx["id"]) not in done]
    if limit:
        todo = todo[:limit]

    ingested = 0
    errors: List[Dict[str, Any]] = []
    market_totals: Dict[str, int] = {}
    for fx in todo:
        try:
            res = ingest_fixture(int(fx["id"]),
                                 league_name=(fx.get("league") or {}).get("name"),
                                 path=path)
            if res.get("ok"):
                ingested += 1
                for m, n in (res.get("markets") or {}).items():
                    market_totals[m] = market_totals.get(m, 0) + n
            if sleep_between:
                time.sleep(sleep_between)
        except Exception as exc:  # noqa: BLE001
            errors.append({"fixture_id": fx.get("id"), "error": str(exc)[:150]})

    return {
        "window": {"from": date_from.isoformat(), "to": date_to.isoformat()},
        "discovered_finished": len(discovered),
        "already_had": len(discovered) - len(todo) if not limit else None,
        "ingested": ingested,
        "errors": errors[:20],
        "market_coverage": market_totals,
    }


def coverage_report(path: Optional[Path] = None) -> Dict[str, Any]:
    """How much historical data do we have, per market?"""
    init_tables(path)
    conn = _db(path)
    try:
        n_fix = conn.execute("SELECT COUNT(*) FROM soccer_hist_fixtures WHERE home_score IS NOT NULL").fetchone()[0]
        date_range = conn.execute(
            "SELECT MIN(starting_at), MAX(starting_at) FROM soccer_hist_fixtures WHERE home_score IS NOT NULL"
        ).fetchone()
        per_market = conn.execute(
            """SELECT market_name, COUNT(DISTINCT fixture_id) AS fixtures,
                      COUNT(*) AS selections, AVG(n_books) AS avg_books
                 FROM soccer_hist_closing_odds GROUP BY market_name
                 ORDER BY fixtures DESC"""
        ).fetchall()
        corners_n = conn.execute(
            "SELECT COUNT(*) FROM soccer_hist_fixtures WHERE corners_total IS NOT NULL"
        ).fetchone()[0]
        return {
            "fixtures_with_score": n_fix,
            "date_range": [date_range[0], date_range[1]],
            "fixtures_with_corners": corners_n,
            "per_market": [dict(r) for r in per_market],
        }
    finally:
        conn.close()


# ── CLI ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser(description="Sportmonks historical ingestion (M48)")
    sub = p.add_subparsers(dest="cmd", required=True)

    one = sub.add_parser("fixture")
    one.add_argument("fixture_id", type=int)

    rng = sub.add_parser("range")
    rng.add_argument("--from", dest="date_from", required=True)
    rng.add_argument("--to", dest="date_to", required=True)
    rng.add_argument("--leagues", default=None, help="CSV of league_ids")
    rng.add_argument("--limit", type=int, default=None)

    sub.add_parser("coverage")

    args = p.parse_args()
    if args.cmd == "fixture":
        print(json.dumps(ingest_fixture(args.fixture_id), indent=2, ensure_ascii=False))
    elif args.cmd == "range":
        lids = [int(x) for x in args.leagues.split(",")] if args.leagues else None
        print(json.dumps(ingest_range(
            date_from=date.fromisoformat(args.date_from),
            date_to=date.fromisoformat(args.date_to),
            league_ids=lids, limit=args.limit,
        ), indent=2, ensure_ascii=False))
    elif args.cmd == "coverage":
        print(json.dumps(coverage_report(), indent=2, ensure_ascii=False))
