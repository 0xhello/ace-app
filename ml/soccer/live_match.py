#!/usr/bin/env python3
"""
ml/soccer/live_match.py — real-time match state for the live game view.

Pulls the CURRENT score, match minute, status and key events for one Sportmonks
fixture via REST (no WebSocket needed — a ~20s client poll looks real-time for a
sport that scores every few minutes). NEVER fabricates: if the fixture isn't
live, it reports that honestly.

CLI:
    python3 -m ml.soccer.live_match inplay          # list fixtures live right now
    python3 -m ml.soccer.live_match state 19135059  # live state for a fixture id
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from ml.soccer.sportmonks_fixture import _sportmonks_get

# Sportmonks fixture state ids that mean the ball is in play / decided.
_LIVE_STATES = {2, 3, 22, 6, 7}        # 1st half, HT, 2nd half, ET, pens-ish
_FINISHED_STATES = {5, 7, 8}           # FT, AET, FT_PEN
_EVENT_KEEP = {"goal", "own-goal", "penalty", "yellowcard", "redcard",
               "yellowred", "substitution", "var"}
_STARTER_TYPE = 11                      # Sportmonks lineup type_id for starters
_POS = {24: "GK", 25: "DEF", 26: "MID", 27: "FWD"}


def _normalize_lineups(raw, home_id):
    out = []
    for row in raw or []:
        pl = row.get("player") or {}
        out.append({
            "name": pl.get("common_name") or row.get("player_name") or pl.get("display_name") or pl.get("name"),
            "number": row.get("jersey_number"),
            "pos": _POS.get(row.get("position_id")),
            "team": "home" if row.get("team_id") == home_id else "away",
            "starter": row.get("type_id") == _STARTER_TYPE,
            "order": row.get("formation_position") or 99,
        })
    return out


def _current_scores(scores: List[Dict[str, Any]]) -> Dict[str, Optional[int]]:
    cur = {s.get("score", {}).get("participant"): s.get("score", {}).get("goals")
           for s in scores if s.get("description") == "CURRENT"}
    return {"home": cur.get("home"), "away": cur.get("away")}


def _ticking_minute(periods: List[Dict[str, Any]]) -> Optional[int]:
    for p in periods or []:
        if p.get("ticking"):
            return p.get("minutes")
    # fall back to the latest period's minutes
    done = [p.get("minutes") for p in (periods or []) if p.get("minutes") is not None]
    return max(done) if done else None


def _normalize_events(raw: List[Dict[str, Any]], home_id: Optional[int]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for e in raw or []:
        kind = (e.get("type", {}) or {}).get("developer_name") or e.get("type_id")
        code = str(kind).lower().replace("_", "").replace("-", "")
        # map a few common Sportmonks developer names to our buckets
        bucket = None
        if "owngoal" in code: bucket = "own-goal"
        elif "penaltygoal" in code or (code == "goal"): bucket = "goal"
        elif "goal" in code: bucket = "goal"
        elif "redcard" in code or "yellowred" in code: bucket = "redcard"
        elif "yellowcard" in code: bucket = "yellowcard"
        elif "substitution" in code or "subst" in code: bucket = "substitution"
        elif "var" in code: bucket = "var"
        if bucket is None:
            continue
        out.append({
            "minute": e.get("minute"),
            "extra": e.get("extra_minute"),
            "type": bucket,
            "team": "home" if e.get("participant_id") == home_id else "away",
            "player": e.get("player_name") or (e.get("player", {}) or {}).get("name"),
            "related": e.get("related_player_name"),
            "info": e.get("info"),
        })
    out.sort(key=lambda x: ((x["minute"] or 0), (x["extra"] or 0)), reverse=True)
    return out


def live_state(fixture_id: int) -> Dict[str, Any]:
    """Current state for one fixture. {live, finished, status, minute, home/away score, events}."""
    payload = _sportmonks_get(
        f"/fixtures/{fixture_id}",
        {"include": "participants;scores;periods;state;events.type;lineups.player"},
    )
    data = payload.get("data") or {}
    parts = data.get("participants") or []
    home = next((p for p in parts if (p.get("meta") or {}).get("location") == "home"), None)
    away = next((p for p in parts if (p.get("meta") or {}).get("location") == "away"), None)
    state_id = data.get("state_id")
    state = (data.get("state") or {})
    scores = _current_scores(data.get("scores") or [])
    return {
        "fixture_id": fixture_id,
        "live": state_id in _LIVE_STATES,
        "finished": state_id in _FINISHED_STATES,
        "state_id": state_id,
        "status": state.get("developer_name") or state.get("name"),
        "minute": _ticking_minute(data.get("periods") or []),
        "home_team": (home or {}).get("name"),
        "away_team": (away or {}).get("name"),
        "home_score": scores["home"],
        "away_score": scores["away"],
        "events": _normalize_events(data.get("events") or [], (home or {}).get("id")),
        "lineups": _normalize_lineups(data.get("lineups") or [], (home or {}).get("id")),
        "fetched_at": data.get("starting_at"),
    }


def resolve_fixture_ids(pairs: List[Dict[str, Any]], days: int = 6) -> Dict[str, int]:
    """Map board games → Sportmonks fixture ids by team names + date.

    `pairs` = [{game_id, home, away, commence}]. One cheap discovery call gets
    every fixture in the window across our configured leagues (incl. World Cup
    732); each board game is then matched locally by alias-aware team names and
    a ±36h date band. Decouples the LIVE view from the heavy bundle/slate-sync —
    we only need the fixture id; live_state() fetches score/events/lineups itself.
    """
    import datetime as _dt
    from ml.soccer.sportmonks_fixture import discover_fixtures_in_window
    from ml.soccer.injuries import _norm, _TEAM_ALIASES

    def norm(name):
        n = _norm(name or "")
        return _norm(_TEAM_ALIASES.get(n, name or "")) if n in _TEAM_ALIASES else n

    today = _dt.date.today()
    try:
        fixtures = discover_fixtures_in_window(date_from=today - _dt.timedelta(days=1),
                                               date_to=today + _dt.timedelta(days=days))
    except Exception:
        return {}

    index = []
    for fx in fixtures:
        parts = fx.get("participants") or []
        names = [norm(p.get("name")) for p in parts if p.get("name")]
        ts = None
        try:
            ts = _dt.datetime.fromisoformat((fx.get("starting_at") or "").replace(" ", "T")).timestamp()
        except Exception:
            pass
        if len(names) >= 2 and fx.get("id"):
            index.append({"id": fx["id"], "teams": set(names[:2]), "ts": ts})

    out: Dict[str, int] = {}
    for pr in pairs:
        want = {norm(pr.get("home")), norm(pr.get("away"))}
        ct = None
        try:
            ct = _dt.datetime.fromisoformat((pr.get("commence") or "").replace("Z", "+00:00")).timestamp()
        except Exception:
            pass
        best = None
        for ix in index:
            if ix["teams"] != want:
                continue
            if ct and ix["ts"] and abs(ix["ts"] - ct) > 36 * 3600:
                continue
            best = ix["id"]
            break
        if best:
            out[pr["game_id"]] = best
    return out


def inplay_fixture_ids() -> List[Dict[str, Any]]:
    """Fixtures live right now (for testing / discovery)."""
    payload = _sportmonks_get("/livescores/inplay", {"include": "participants"})
    out = []
    for fx in payload.get("data") or []:
        names = [p.get("name") for p in (fx.get("participants") or [])]
        out.append({"id": fx.get("id"), "name": fx.get("name") or " vs ".join(names),
                    "state_id": fx.get("state_id")})
    return out


if __name__ == "__main__":
    import sys
    cmd = sys.argv[1] if len(sys.argv) > 1 else "inplay"
    if cmd == "state" and len(sys.argv) > 2:
        print(json.dumps(live_state(int(sys.argv[2])), indent=2, default=str))
    else:
        print(json.dumps(inplay_fixture_ids(), indent=2, default=str))
