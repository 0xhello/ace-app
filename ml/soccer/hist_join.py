#!/usr/bin/env python3
"""hist_join.py — match model fixtures to Sportmonks historical odds.

The Dixon-Coles model predicts on soccer_team_form fixtures (football-data
naming). The Sportmonks historical odds (M48) live in soccer_hist_fixtures
/ soccer_hist_closing_odds with Sportmonks naming. To backtest the markets
football-data never carried (BTTS, corners, anytime scorer) we need to
attach the Sportmonks closing odds to the model's fixtures.

This module builds that join once and exposes per-market odds accessors.
Matching: normalized team names (accent-fold + drop FC/AC/… suffixes) +
token overlap, with a ±1 day tolerance (Sportmonks UTC vs football-data
local date can differ by a day). ~89% of Big-5 fixtures match.

Reused by backtest_v2 for BTTS / corners / anytime-scorer validation.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Set, Tuple

from ml.world_cup.signal_logger import DB_PATH as DEFAULT_DB_PATH

_ACCENTS = str.maketrans(
    "àáâãäåèéêëìíîïòóôõöùúûüýÿñç", "aaaaaaeeeeiiiiooooouuuuyync"
)
_STOP = {"fc", "afc", "cf", "sc", "ac", "as", "rc", "sv", "calcio",
         "club", "de", "cd", "ud", "cp", "1899", "1846"}


def _norm(s: Optional[str]) -> str:
    if not s:
        return ""
    cleaned = "".join(c if c.isalnum() else " " for c in s.translate(_ACCENTS).lower())
    return "".join(w for w in cleaned.split() if w not in _STOP)


def _tokens(s: Optional[str]) -> Set[str]:
    if not s:
        return set()
    cleaned = "".join(c if c.isalnum() else " " for c in s.translate(_ACCENTS).lower())
    return {w for w in cleaned.split() if w not in _STOP and len(w) >= 3}


def _american_to_decimal(american: float) -> float:
    a = float(american)
    return a / 100.0 + 1.0 if a >= 0 else 100.0 / (-a) + 1.0


class HistJoiner:
    """Builds the model-fixture → Sportmonks-odds join once, then serves
    per-market closing odds keyed by (date, home, away) in the model's
    naming space."""

    def __init__(self, conn: sqlite3.Connection):
        self._fixture_by_date: Dict[str, List[Dict[str, Any]]] = {}
        self._odds_by_fixture: Dict[int, Dict[str, Any]] = {}
        self._build(conn)

    def _build(self, conn: sqlite3.Connection) -> None:
        # 1. Sportmonks fixtures, indexed by date for ±1-day matching
        rows = conn.execute(
            """SELECT fixture_id, league_id, starting_at,
                      home_team_name, away_team_name, btts, corners_total
                 FROM soccer_hist_fixtures
                WHERE home_team_name IS NOT NULL"""
        ).fetchall()
        for r in rows:
            d = (r["starting_at"] or "")[:10]
            self._fixture_by_date.setdefault(d, []).append({
                "fixture_id": r["fixture_id"],
                "nh": _norm(r["home_team_name"]),
                "na": _norm(r["away_team_name"]),
                "th": _tokens(r["home_team_name"]),
                "ta": _tokens(r["away_team_name"]),
            })

        # 2. Closing odds, indexed by fixture_id → market → selection/line → decimal
        odds_rows = conn.execute(
            """SELECT fixture_id, market_name, selection, line, player_name,
                      closing_decimal, best_decimal
                 FROM soccer_hist_closing_odds"""
        ).fetchall()
        for o in odds_rows:
            fid = o["fixture_id"]
            mkt = self._odds_by_fixture.setdefault(fid, {})
            name = o["market_name"]
            if name == "btts":
                mkt.setdefault("btts", {})[o["selection"]] = o["closing_decimal"]
            elif name == "corners_over_under":
                mkt.setdefault("corners", {}).setdefault(o["line"], {})[o["selection"]] = o["closing_decimal"]
            elif name == "goalscorers" and o["selection"] == "Anytime":
                mkt.setdefault("anytime", {})[_norm(o["player_name"])] = {
                    "decimal": o["closing_decimal"], "player": o["player_name"],
                }

    def _find_fixture_id(self, date_str: str, home: str, away: str) -> Optional[int]:
        nh, na = _norm(home), _norm(away)
        th, ta = _tokens(home), _tokens(away)
        try:
            base = datetime.fromisoformat(date_str[:10])
        except Exception:
            return None
        for delta in (0, -1, 1):
            d = (base + timedelta(days=delta)).isoformat()[:10]
            for f in self._fixture_by_date.get(d, []):
                if ((nh == f["nh"] or nh in f["nh"] or f["nh"] in nh)
                        and (na == f["na"] or na in f["na"] or f["na"] in na)):
                    return f["fixture_id"]
                if (th & f["th"]) and (ta & f["ta"]):
                    return f["fixture_id"]
        return None

    # ── Per-market accessors (return DECIMAL odds) ──────────────────────

    def btts_odds(self, date: str, home: str, away: str) -> Optional[Tuple[float, float]]:
        """(yes_decimal, no_decimal) or None if no match / no BTTS odds."""
        fid = self._find_fixture_id(date, home, away)
        if fid is None:
            return None
        b = self._odds_by_fixture.get(fid, {}).get("btts")
        if not b or "Yes" not in b or "No" not in b:
            return None
        return (float(b["Yes"]), float(b["No"]))

    def corners_odds(self, date: str, home: str, away: str) -> Optional[Dict[float, Dict[str, float]]]:
        """{line: {'Over': dec, 'Under': dec}} or None."""
        fid = self._find_fixture_id(date, home, away)
        if fid is None:
            return None
        return self._odds_by_fixture.get(fid, {}).get("corners")

    def anytime_odds(self, date: str, home: str, away: str) -> Optional[Dict[str, Dict[str, Any]]]:
        """{norm_player: {'decimal': float, 'player': str}} or None."""
        fid = self._find_fixture_id(date, home, away)
        if fid is None:
            return None
        return self._odds_by_fixture.get(fid, {}).get("anytime")

    def coverage(self) -> Dict[str, int]:
        markets = {"btts": 0, "corners": 0, "anytime": 0}
        for mkt in self._odds_by_fixture.values():
            for k in markets:
                if k in mkt:
                    markets[k] += 1
        return {"fixtures_with_odds": len(self._odds_by_fixture), **markets}


if __name__ == "__main__":
    conn = sqlite3.connect(str(DEFAULT_DB_PATH))
    conn.row_factory = sqlite3.Row
    j = HistJoiner(conn)
    print(json.dumps(j.coverage(), indent=2))
    # smoke test a known fixture
    print("BTTS odds for a sample:", j.btts_odds("2025-05-15", "Aston Villa", "Liverpool"))
    conn.close()
