#!/usr/bin/env python3
"""
ml/soccer/injuries.py — general soccer injury/suspension feed (Sportmonks).

NOT World-Cup-specific. Sportmonks `sidelined` covers any team it tracks —
national sides and clubs alike — so this populates one `soccer_injuries`
table for whatever soccer teams appear on the board's upcoming fixtures
(WC, EPL, UCL, friendlies…). The dashboard reads that table and renders
injury chips for any soccer game; data and display are decoupled.

Pipeline:
  team names (from board fixtures)
    → resolve to Sportmonks team_id  (search + cached in soccer_team_ids)
    → GET /teams/{id}?include=sidelined.player;sidelined.type
    → keep CURRENTLY-out players (start passed, end null/future)
    → upsert into soccer_injuries
    → loader serves them keyed by normalized team name

Injuries move over days, so a periodic refresh (worker / on-demand) is fine.

CLI:
    python3 -m ml.soccer.injuries refresh "Brazil" "France" "Liverpool"
    python3 -m ml.soccer.injuries show
"""
from __future__ import annotations

import json
import os
import sqlite3
import time
import unicodedata
from datetime import datetime, date, timezone
from typing import Any, Dict, List, Optional

import httpx
from dotenv import load_dotenv
from pathlib import Path

from ml.world_cup.signal_logger import DB_PATH

load_dotenv(Path(__file__).resolve().parents[2] / ".env.local")
_TOKEN = os.getenv("SPORTMONKS_API_TOKEN")
_BASE = "https://api.sportmonks.com/v3/football"


# ── db ────────────────────────────────────────────────────────────────────
def _db(path: Optional[str] = None) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path or DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def init_tables(path: Optional[str] = None) -> None:
    conn = _db(path)
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS soccer_team_ids (
                name_norm   TEXT PRIMARY KEY,   -- normalized lookup name
                team_id     INTEGER,            -- Sportmonks team id (NULL = searched, not found)
                team_name   TEXT,               -- Sportmonks canonical name
                resolved_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS soccer_injuries (
                team_id     INTEGER NOT NULL,
                team_name   TEXT,
                player_id   INTEGER NOT NULL,
                player_name TEXT,
                status      TEXT,               -- out | suspended
                category    TEXT,               -- injury | suspension
                reason      TEXT,               -- e.g. "Achilles tendon rupture"
                start_date  TEXT,
                end_date    TEXT,
                fetched_at  TEXT NOT NULL,
                PRIMARY KEY (team_id, player_id)
            );
            CREATE INDEX IF NOT EXISTS idx_injuries_team ON soccer_injuries(team_id);
            """
        )
        conn.commit()
    finally:
        conn.close()


# ── helpers ─────────────────────────────────────────────────────────────────
def _clean(name: Optional[str]) -> Optional[str]:
    """Strip nbsp + collapse whitespace from a display name (Sportmonks leaves
    trailing \\u00a0 on some names)."""
    if not name:
        return name
    return " ".join(name.replace(" ", " ").split())


def _norm(name: str) -> str:
    """Accent-fold + lowercase + collapse for tolerant name matching."""
    s = unicodedata.normalize("NFKD", name or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    return " ".join(s.lower().replace("&", "and").split())


def _get(path: str, params: Dict[str, Any]) -> Dict[str, Any]:
    params = {**params, "api_token": _TOKEN}
    r = httpx.get(f"{_BASE}{path}", params=params, timeout=20)
    r.raise_for_status()
    return r.json()


def _is_current(start_date: Optional[str], end_date: Optional[str]) -> bool:
    """A player is currently sidelined if start has passed and end is null/future."""
    today = date.today().isoformat()
    if start_date and start_date > today:
        return False
    if end_date and end_date < today:
        return False
    return True


# Board (Odds-API) name → Sportmonks canonical name, for nations whose names
# differ. WITHOUT this + exact-match-only, the search fallback picked garbage
# (e.g. "USA" → "Beitar Jerusalem", the first unrelated result).
_TEAM_ALIASES: Dict[str, str] = {
    "usa": "United States",
    "united states": "United States",
    "ivory coast": "Côte d'Ivoire",
    "turkey": "Türkiye",
    "south korea": "Korea Republic",
    "north korea": "Korea DPR",
    "cape verde": "Cape Verde Islands",
    "czechia": "Czech Republic",
    "china": "China PR",
    "drc": "Congo DR",
    "dr congo": "Congo DR",
}


# ── team-id resolution (cached) ──────────────────────────────────────────────
def resolve_team_id(name: str, *, path: Optional[str] = None) -> Optional[int]:
    """Resolve a team name → Sportmonks team_id (EXACT match only), caching it.

    Uses an alias map for nations Sportmonks spells differently, then requires
    an exact normalized name match. NEVER falls back to the first search hit —
    that produced false matches (USA → Beitar Jerusalem) which would surface
    another club's injuries on the wrong game.
    """
    init_tables(path)
    key = _norm(name)
    conn = _db(path)
    try:
        row = conn.execute("SELECT team_id FROM soccer_team_ids WHERE name_norm=?", (key,)).fetchone()
        if row is not None:
            return row["team_id"]
    finally:
        conn.close()

    search_term = _TEAM_ALIASES.get(key, name)
    target = _norm(search_term)
    # Sportmonks search is finicky: the full phrase matches some ("United
    # States") but not others ("Bosnia Herzegovina" → []), while the first
    # token matches those ("Bosnia") but is too generic for some ("United").
    # So try both and accept only an EXACT normalized-name match.
    folded = unicodedata.normalize("NFKD", search_term)
    folded = "".join(c for c in folded if not unicodedata.combining(c)).replace("&", " ")
    folded = " ".join(folded.split())
    candidates: List[str] = []
    for c in (folded, *(folded.split())):
        if c and c not in candidates:
            candidates.append(c)
    team_id, canonical = None, None
    try:
        for q in candidates:
            payload = _get(f"/teams/search/{q}", {})
            results = payload.get("data") or []
            exact = next((t for t in results if _norm(t.get("name", "")) in (target, key)), None)
            if exact:
                team_id, canonical = exact.get("id"), exact.get("name")
                break
    except Exception:  # noqa: BLE001
        pass

    conn = _db(path)
    try:
        conn.execute(
            "INSERT OR REPLACE INTO soccer_team_ids (name_norm, team_id, team_name, resolved_at) "
            "VALUES (?,?,?,?)",
            (key, team_id, canonical, datetime.now(timezone.utc).isoformat()),
        )
        conn.commit()
    finally:
        conn.close()
    return team_id


# ── fetch + store ─────────────────────────────────────────────────────────────
def fetch_team_injuries(team_id: int) -> List[Dict[str, Any]]:
    """Current injuries/suspensions for one Sportmonks team_id."""
    payload = _get(f"/teams/{team_id}", {"include": "sidelined.player;sidelined.type"})
    data = payload.get("data") or {}
    team_name = data.get("name")
    out: List[Dict[str, Any]] = []
    for s in data.get("sidelined") or []:
        if not _is_current(s.get("start_date"), s.get("end_date")):
            continue
        player = s.get("player") or {}
        category = (s.get("category") or "").lower()
        out.append({
            "team_id": team_id,
            "team_name": team_name,
            "player_id": s.get("player_id"),
            "player_name": _clean(player.get("display_name") or player.get("name")),
            "status": "suspended" if category == "suspension" else "out",
            "category": category or "injury",
            "reason": (s.get("type") or {}).get("name"),
            "start_date": s.get("start_date"),
            "end_date": s.get("end_date"),
        })
    return out


def refresh_for_teams(names: List[str], *, sleep_between: float = 0.05,
                      path: Optional[str] = None) -> Dict[str, Any]:
    """Resolve names → ids, fetch current injuries, replace the rows per team."""
    init_tables(path)
    now = datetime.now(timezone.utc).isoformat()
    resolved, unresolved, total_injuries = 0, [], 0
    for name in names:
        tid = resolve_team_id(name, path=path)
        if not tid:
            unresolved.append(name)
            continue
        resolved += 1
        try:
            rows = fetch_team_injuries(tid)
        except Exception:  # noqa: BLE001
            continue
        conn = _db(path)
        try:
            conn.execute("DELETE FROM soccer_injuries WHERE team_id=?", (tid,))
            for r in rows:
                if r["player_id"] is None:
                    continue
                conn.execute(
                    "INSERT OR REPLACE INTO soccer_injuries "
                    "(team_id, team_name, player_id, player_name, status, category, reason, start_date, end_date, fetched_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (r["team_id"], r["team_name"], r["player_id"], r["player_name"],
                     r["status"], r["category"], r["reason"], r["start_date"], r["end_date"], now),
                )
            conn.commit()
            total_injuries += len(rows)
        finally:
            conn.close()
        if sleep_between:
            time.sleep(sleep_between)
    return {"teams_resolved": resolved, "unresolved": unresolved,
            "injuries_stored": total_injuries}


def injuries_by_team_name(path: Optional[str] = None) -> Dict[str, List[Dict[str, Any]]]:
    """Loader: all current injuries keyed by normalized team name."""
    init_tables(path)
    conn = _db(path)
    try:
        rows = [dict(r) for r in conn.execute(
            "SELECT team_id, team_name, player_name, status, reason FROM soccer_injuries").fetchall()]
        # map team_id → normalized names that point to it
        idmap = {r["team_id"]: r["name_norm"] for r in conn.execute(
            "SELECT team_id, name_norm FROM soccer_team_ids WHERE team_id IS NOT NULL").fetchall()}
    finally:
        conn.close()
    out: Dict[str, List[Dict[str, Any]]] = {}
    for r in rows:
        key = idmap.get(r["team_id"]) or _norm(r["team_name"] or "")
        out.setdefault(key, []).append(
            {"player_name": r["player_name"], "status": r["status"], "reason": r["reason"]})
    return out


if __name__ == "__main__":
    import sys
    cmd = sys.argv[1] if len(sys.argv) > 1 else "show"
    if cmd == "refresh":
        names = sys.argv[2:] or ["Brazil", "France", "Liverpool"]
        print(json.dumps(refresh_for_teams(names), indent=2))
    else:
        print(json.dumps(injuries_by_team_name(), indent=2, default=str))
