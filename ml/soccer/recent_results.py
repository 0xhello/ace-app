#!/usr/bin/env python3
"""
ml/soccer/recent_results.py — last-N finished results per soccer team (Sportmonks).

Companion to ml/soccer/injuries.py. National sides have no rows in our club-only
`soccer_team_form` table, so for World Cup nations (and any Sportmonks-tracked
team) we pull recent results straight from Sportmonks:

  team name → resolve_team_id (reused from injuries.py, cached in soccer_team_ids)
            → GET /teams/{id}?include=latest.participants;latest.scores;latest.league
            → keep FINISHED fixtures, derive opponent / venue / GF-GA / W-D-L
            → upsert last-N into soccer_team_recent_results
            → loader serves them keyed by normalized team name

Data + display are decoupled (same as injuries): this populates a cache table; the
dashboard only reads. Results move slowly, so a periodic refresh is plenty.

CLI:
    python3 -m ml.soccer.recent_results refresh "Mexico" "South Africa" "Brazil"
    python3 -m ml.soccer.recent_results show
"""
from __future__ import annotations

import json
import sqlite3
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

# Reuse the resolver + HTTP + normalizer + DB from the injuries module so a
# single team-id cache (soccer_team_ids) and one Sportmonks auth serve both.
from ml.soccer.injuries import (
    DB_PATH, _db, _get, _norm, _clean, resolve_team_id, init_tables as _init_team_ids,
)

_KEEP = 8           # store up to 8 finished fixtures; UI shows 5
_FINISHED_STATES = {5, 7, 8}   # 5 FT, 7 AET, 8 FT_PEN (Sportmonks state ids)


def init_table(path: Optional[str] = None) -> None:
    _init_team_ids(path)   # ensures soccer_team_ids exists
    conn = _db(path)
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS soccer_team_recent_results (
                team_id      INTEGER PRIMARY KEY,
                team_name    TEXT,
                results_json TEXT,   -- list[{date, opponent, venue, gf, ga, result, competition}]
                summary_json TEXT,   -- {played, w, d, l, gf, ga, clean_sheets, form, streak}
                fetched_at   TEXT NOT NULL
            );
            """
        )
        conn.commit()
    finally:
        conn.close()


def _result_letter(gf: int, ga: int) -> str:
    return "W" if gf > ga else ("L" if gf < ga else "D")


def _parse_latest(team_id: int, latest: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Turn Sportmonks `latest` fixtures into this team's finished-match rows
    (newest first), keeping only resolvable, finished games."""
    out: List[Dict[str, Any]] = []
    for fx in latest or []:
        state = fx.get("state_id")
        parts = fx.get("participants") or []
        scores = fx.get("scores") or []
        if not parts or not scores:
            continue
        # locate this team + opponent
        me = next((p for p in parts if p.get("id") == team_id), None)
        opp = next((p for p in parts if p.get("id") != team_id), None)
        if not me or not opp:
            continue
        my_loc = (me.get("meta") or {}).get("location")          # "home" | "away"
        opp_loc = (opp.get("meta") or {}).get("location")
        if my_loc not in ("home", "away"):
            continue
        # CURRENT (full-time) score per side
        cur = {s.get("score", {}).get("participant"): s.get("score", {}).get("goals")
               for s in scores if s.get("description") == "CURRENT"}
        gf, ga = cur.get(my_loc), cur.get(opp_loc)
        if gf is None or ga is None:
            continue
        # only finished games (state id when present, else trust a CURRENT score)
        if state is not None and state not in _FINISHED_STATES:
            continue
        league = (fx.get("league") or {}).get("name")
        out.append({
            "date": (fx.get("starting_at") or "")[:10],
            "opponent": _clean(opp.get("name")),
            "venue": "H" if my_loc == "home" else "A",
            "gf": int(gf),
            "ga": int(ga),
            "result": _result_letter(int(gf), int(ga)),
            "competition": league,
        })
    # newest first, keep N
    out.sort(key=lambda r: r["date"], reverse=True)
    return out[:_KEEP]


def _summarize(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Compact last-5 summary: record, goals, clean sheets, current streak."""
    last5 = rows[:5]
    w = sum(1 for r in last5 if r["result"] == "W")
    d = sum(1 for r in last5 if r["result"] == "D")
    l = sum(1 for r in last5 if r["result"] == "L")
    gf = sum(r["gf"] for r in last5)
    ga = sum(r["ga"] for r in last5)
    cs = sum(1 for r in last5 if r["ga"] == 0)
    # current streak from most-recent backwards (e.g. "W3", "U4" unbeaten, "L2")
    streak = ""
    if last5:
        first = last5[0]["result"]
        if first in ("W", "L"):
            n = 0
            for r in last5:
                if r["result"] == first:
                    n += 1
                else:
                    break
            streak = f"{first}{n}"
    # unbeaten / winless run (independent of W/L streak above)
    run, kind = 0, None
    for r in last5:
        if r["result"] in ("W", "D"):
            if kind in (None, "U"):
                kind, run = "U", run + 1
            else:
                break
        else:
            if kind in (None, "Wl"):
                kind, run = "Wl", run + 1
            else:
                break
    run_label = (f"{run} unbeaten" if kind == "U" else f"{run} winless") if run >= 3 else None
    return {
        "played": len(last5), "w": w, "d": d, "l": l,
        "gf": gf, "ga": ga, "clean_sheets": cs,
        "form": "".join(r["result"] for r in last5),     # newest→oldest, e.g. "WWDLW"
        "streak": streak or None,
        "run": run_label,
    }


def fetch_team_recent(team_id: int) -> Dict[str, Any]:
    payload = _get(f"/teams/{team_id}",
                   {"include": "latest.participants;latest.scores;latest.league"})
    data = payload.get("data") or {}
    rows = _parse_latest(team_id, data.get("latest") or [])
    return {"team_name": data.get("name"), "results": rows, "summary": _summarize(rows)}


def refresh_for_teams(names: List[str], *, sleep_between: float = 0.05,
                      path: Optional[str] = None) -> Dict[str, Any]:
    init_table(path)
    now = datetime.now(timezone.utc).isoformat()
    resolved, unresolved, stored = 0, [], 0
    for name in names:
        tid = resolve_team_id(name, path=path)
        if not tid:
            unresolved.append(name)
            continue
        resolved += 1
        try:
            res = fetch_team_recent(tid)
        except Exception:  # noqa: BLE001
            continue
        if not res["results"]:
            continue
        conn = _db(path)
        try:
            conn.execute(
                "INSERT OR REPLACE INTO soccer_team_recent_results "
                "(team_id, team_name, results_json, summary_json, fetched_at) VALUES (?,?,?,?,?)",
                (tid, res["team_name"], json.dumps(res["results"]),
                 json.dumps(res["summary"]), now),
            )
            conn.commit()
            stored += 1
        finally:
            conn.close()
        if sleep_between:
            time.sleep(sleep_between)
    return {"teams_resolved": resolved, "unresolved": unresolved, "teams_stored": stored}


def recent_form_by_team_name(path: Optional[str] = None) -> Dict[str, Dict[str, Any]]:
    """Loader: {normalized team name → {results, summary}} for cached teams."""
    init_table(path)
    conn = _db(path)
    try:
        rows = [dict(r) for r in conn.execute(
            "SELECT team_id, team_name, results_json, summary_json FROM soccer_team_recent_results").fetchall()]
        idmap = {r["team_id"]: r["name_norm"] for r in conn.execute(
            "SELECT team_id, name_norm FROM soccer_team_ids WHERE team_id IS NOT NULL").fetchall()}
    finally:
        conn.close()
    out: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        key = idmap.get(r["team_id"]) or _norm(r["team_name"] or "")
        try:
            out[key] = {"results": json.loads(r["results_json"] or "[]"),
                        "summary": json.loads(r["summary_json"] or "{}")}
        except Exception:  # noqa: BLE001
            continue
    return out


if __name__ == "__main__":
    import sys
    cmd = sys.argv[1] if len(sys.argv) > 1 else "show"
    if cmd == "refresh":
        names = sys.argv[2:] or ["Mexico", "South Africa", "Brazil"]
        print(json.dumps(refresh_for_teams(names), indent=2))
    else:
        print(json.dumps(recent_form_by_team_name(), indent=2, default=str))
