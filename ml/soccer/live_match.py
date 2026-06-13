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


def _position_label(value: Any) -> Optional[str]:
    try:
        return _POS.get(int(value))
    except Exception:
        return None


def _player_name(row: Dict[str, Any]) -> Optional[str]:
    return row.get("common_name") or row.get("display_name") or row.get("name")


def _normalize_lineups(raw, home_id):
    out = []
    for row in raw or []:
        pl = row.get("player") or {}
        out.append({
            "id": row.get("player_id") or pl.get("id"),
            "name": _player_name(pl) or row.get("player_name"),
            "number": row.get("jersey_number"),
            "pos": _position_label(row.get("position_id") or pl.get("position_id")),
            "team": "home" if row.get("team_id") == home_id else "away",
            "starter": row.get("type_id") == _STARTER_TYPE,
            "order": row.get("formation_position") or 99,
        })
    return out


def _player_position_index(lineups: List[Dict[str, Any]]) -> Dict[Any, str]:
    index: Dict[Any, str] = {}
    for row in lineups or []:
        pos = row.get("pos")
        if not pos:
            continue
        if row.get("id") is not None:
            index[row.get("id")] = pos
        if row.get("name"):
            index[str(row.get("name")).casefold()] = pos
    return index


def _current_scores(scores: List[Dict[str, Any]]) -> Dict[str, Optional[int]]:
    cur = {s.get("score", {}).get("participant"): s.get("score", {}).get("goals")
           for s in scores if s.get("description") == "CURRENT"}
    return {"home": cur.get("home"), "away": cur.get("away")}


def _period_extra_minute(period: Dict[str, Any]) -> Optional[int]:
    # Sportmonks has changed this field name across payloads/plans; keep this
    # deliberately defensive and only expose a real provider value.
    for key in ("extra_minute", "extra_minutes", "stoppage_time", "stoppage_minutes", "injury_time", "additional_time", "added_time"):
        value = period.get(key)
        if value is None:
            continue
        try:
            value = int(value)
        except Exception:
            continue
        return value if value > 0 else None
    return None


def _ticking_clock(periods: List[Dict[str, Any]]) -> Dict[str, Optional[int]]:
    for p in periods or []:
        if p.get("ticking"):
            return {"minute": p.get("minutes"), "extra": _period_extra_minute(p)}
    # fall back to the latest period's minutes
    done = [p for p in (periods or []) if p.get("minutes") is not None]
    if not done:
        return {"minute": None, "extra": None}
    latest = max(done, key=lambda p: p.get("minutes") or 0)
    return {"minute": latest.get("minutes"), "extra": _period_extra_minute(latest)}


def _stat_value(stats: List[Dict[str, Any]], developer_name: str, side: str) -> Optional[Any]:
    for row in stats or []:
        typ = row.get("type") or {}
        if typ.get("developer_name") != developer_name:
            continue
        if row.get("location") != side:
            continue
        return (row.get("data") or {}).get("value")
    return None


def _normalize_statistics(raw: List[Dict[str, Any]]) -> Dict[str, Dict[str, Optional[Any]]]:
    return {
        "shots_on_target": {
            "home": _stat_value(raw, "SHOTS_ON_TARGET", "home"),
            "away": _stat_value(raw, "SHOTS_ON_TARGET", "away"),
        },
        "shots_total": {
            "home": _stat_value(raw, "SHOTS_TOTAL", "home"),
            "away": _stat_value(raw, "SHOTS_TOTAL", "away"),
        },
        "possession": {
            "home": _stat_value(raw, "BALL_POSSESSION", "home"),
            "away": _stat_value(raw, "BALL_POSSESSION", "away"),
        },
        "corners": {
            "home": _stat_value(raw, "CORNERS", "home"),
            "away": _stat_value(raw, "CORNERS", "away"),
        },
        # best single "pressure" proxy the provider gives us in-play
        "dangerous_attacks": {
            "home": _stat_value(raw, "DANGEROUS_ATTACKS", "home"),
            "away": _stat_value(raw, "DANGEROUS_ATTACKS", "away"),
        },
    }


def _event_position(e: Dict[str, Any], pos_index: Dict[Any, str], related: bool = False) -> Optional[str]:
    player_key = "related_player" if related else "player"
    id_keys = ("related_player_id", "related_id") if related else ("player_id",)
    for key in id_keys:
        if e.get(key) in pos_index:
            return pos_index[e.get(key)]
    player = e.get(player_key) or {}
    if player.get("id") in pos_index:
        return pos_index[player.get("id")]
    pos = _position_label(player.get("position_id") or player.get("type_id"))
    if pos:
        return pos
    name = e.get("related_player_name") if related else e.get("player_name")
    name = name or _player_name(player)
    if name and str(name).casefold() in pos_index:
        return pos_index[str(name).casefold()]
    return None


def _normalize_events(raw: List[Dict[str, Any]], home_id: Optional[int], pos_index: Optional[Dict[Any, str]] = None) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    pos_index = pos_index or {}
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
            "player": e.get("player_name") or _player_name(e.get("player", {}) or {}),
            "player_position": _event_position(e, pos_index),
            "related": e.get("related_player_name") or _player_name(e.get("related_player", {}) or {}),
            "related_position": _event_position(e, pos_index, related=True),
            "info": e.get("info"),
        })
    out.sort(key=lambda x: ((x["minute"] or 0), (x["extra"] or 0)), reverse=True)
    return out


def live_state(fixture_id: int) -> Dict[str, Any]:
    """Current state for one fixture. {live, finished, status, minute, home/away score, events}."""
    payload = _sportmonks_get(
        f"/fixtures/{fixture_id}",
        {"include": "participants;scores;periods;state;events.type;lineups.player;statistics.type"},
    )
    data = payload.get("data") or {}
    parts = data.get("participants") or []
    home = next((p for p in parts if (p.get("meta") or {}).get("location") == "home"), None)
    away = next((p for p in parts if (p.get("meta") or {}).get("location") == "away"), None)
    state_id = data.get("state_id")
    state = (data.get("state") or {})
    scores = _current_scores(data.get("scores") or [])
    lineups = _normalize_lineups(data.get("lineups") or [], (home or {}).get("id"))
    clock = _ticking_clock(data.get("periods") or [])
    return {
        "fixture_id": fixture_id,
        "live": state_id in _LIVE_STATES,
        "finished": state_id in _FINISHED_STATES,
        "state_id": state_id,
        "status": state.get("developer_name") or state.get("name"),
        "minute": clock["minute"],
        "extra": clock["extra"],
        "clock": f"{clock['minute']}+{clock['extra']}'" if clock["minute"] is not None and clock["extra"] else (f"{clock['minute']}'" if clock["minute"] is not None else None),
        "home_team": (home or {}).get("name"),
        "away_team": (away or {}).get("name"),
        "home_score": scores["home"],
        "away_score": scores["away"],
        "events": _normalize_events(data.get("events") or [], (home or {}).get("id"), _player_position_index(lineups)),
        "lineups": lineups,
        "statistics": _normalize_statistics(data.get("statistics") or []),
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
