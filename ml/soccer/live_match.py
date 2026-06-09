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
        {"include": "participants;scores;periods;state;events.type"},
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
        "fetched_at": data.get("starting_at"),
    }


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
