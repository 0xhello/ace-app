#!/usr/bin/env python3
"""
fixture_events.py — API-Football fixture-event integration for player-prop
grading.

The Odds API scores endpoint only gives team-level scores. To grade
player_goal_scorer_anytime signals we need to know WHICH PLAYERS scored.
API-Football's /fixtures/events endpoint returns per-event details (goals,
cards, subs, etc.) including the player credited.

Settlement conventions for "anytime goalscorer":
  - Regulation + extra time goals COUNT
  - Penalty shootout goals DON'T count (bookmakers settle on 90+ET only)
  - Own goals DON'T credit the player who put it in their own net
  - Multiple goals by same player → still "yes scored" (anytime, not "N or more")

Resolution flow:
  1. Resolve our (home_team, away_team, game_date) to an API-Football
     fixture_id — fuzzy team-name match because Odds API and API-Football
     can format names slightly differently ("Kylian Mbappe" vs "K. Mbappe",
     "Saint-Etienne" vs "St. Etienne")
  2. Fetch fixture events
  3. Filter to goal-typed events in periods 1-4 (drop period >= 5 = pen shootout)
  4. Exclude own goals (event.detail typically "Own Goal" — case-varies)
  5. Return canonical player names of remaining scorers
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Set, Tuple

from .context import _get
from .historical import _normalize_player_name


def _normalize_team_name(name: str) -> str:
    """Strip punctuation, normalize whitespace, lowercase. Mirrors what
    we do for player names — keeps fuzzy team-name matching honest across
    Odds API / API-Football transliterations."""
    if not name:
        return ""
    import re
    import unicodedata
    s = unicodedata.normalize("NFKD", name)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[^a-z0-9 ]+", " ", s.lower())
    return re.sub(r"\s+", " ", s).strip()


def find_api_football_fixture(
    home_team: str,
    away_team: str,
    game_date: str,
) -> Optional[int]:
    """Search API-Football for a fixture matching home + away on game_date.

    game_date is ET YYYY-MM-DD (matches our soccer_signals convention).
    API-Football's `/fixtures?date=` endpoint accepts UTC date which is
    close enough — we widen the search to ±1 day to absorb the timezone
    shift for late-night ET kickoffs.

    Returns the API-Football fixture_id, or None if no confident match.
    """
    if not home_team or not away_team or not game_date:
        return None

    # Try the exact date first; if no match, widen to ±1 day
    from datetime import datetime, timedelta
    try:
        d0 = datetime.strptime(game_date, "%Y-%m-%d")
    except ValueError:
        return None

    candidates: List[Dict[str, Any]] = []
    for delta in (0, -1, 1):
        ds = (d0 + timedelta(days=delta)).strftime("%Y-%m-%d")
        data = _get("fixtures", {"date": ds})
        if not data:
            continue
        for entry in data.get("response", []) or []:
            candidates.append(entry)
        if candidates:
            break

    if not candidates:
        return None

    target_home = _normalize_team_name(home_team)
    target_away = _normalize_team_name(away_team)

    # Best-effort fuzzy match: exact normalized name first, then suffix
    # match (handles "Manchester United" ↔ "Man Utd").
    for entry in candidates:
        teams = entry.get("teams", {}) or {}
        h = _normalize_team_name((teams.get("home") or {}).get("name", ""))
        a = _normalize_team_name((teams.get("away") or {}).get("name", ""))
        if h == target_home and a == target_away:
            fid = (entry.get("fixture") or {}).get("id")
            if isinstance(fid, int):
                return fid

    # Fallback: tail-token match (last word of each name must align). Risky
    # when teams share a city (e.g. "Manchester United" vs "Manchester City")
    # so we require BOTH ends to match.
    target_home_tail = target_home.split()[-1] if target_home else ""
    target_away_tail = target_away.split()[-1] if target_away else ""
    for entry in candidates:
        teams = entry.get("teams", {}) or {}
        h = _normalize_team_name((teams.get("home") or {}).get("name", ""))
        a = _normalize_team_name((teams.get("away") or {}).get("name", ""))
        h_tail = h.split()[-1] if h else ""
        a_tail = a.split()[-1] if a else ""
        if (target_home_tail and h_tail == target_home_tail and
            target_away_tail and a_tail == target_away_tail):
            fid = (entry.get("fixture") or {}).get("id")
            if isinstance(fid, int):
                return fid

    return None


def fetch_fixture_events(fixture_id: int) -> List[Dict[str, Any]]:
    """Pull the raw events list for a fixture. Returns [] on any failure
    (network, auth, plan restriction). Caller treats empty as 'not graded
    yet, try again next run'."""
    if not isinstance(fixture_id, int) or fixture_id <= 0:
        return []
    data = _get("fixtures/events", {"fixture": str(fixture_id)})
    if not data:
        return []
    events = data.get("response") or []
    return events if isinstance(events, list) else []


def extract_goalscorers(events: List[Dict[str, Any]]) -> Set[str]:
    """From raw events, return the set of canonical-name players who
    legitimately scored in regulation + ET (no shootout, no own goals).

    Names returned are canonicalized via _normalize_player_name so they
    match what we store in soccer_signals.player_name.

    Event shape (API-Football v3):
      { "type": "Goal", "detail": "Normal Goal" | "Penalty" | "Own Goal" | "Missed Penalty",
        "time": {"elapsed": int, "extra": int}, "team": {...},
        "player": {"id": ..., "name": "Kylian Mbappé"} }
    """
    scorers: Set[str] = set()
    for ev in events:
        if not isinstance(ev, dict):
            continue
        if (ev.get("type") or "").lower() != "goal":
            continue
        detail = (ev.get("detail") or "").lower()
        # Own goals never credit the kicker. Missed penalties never credit.
        if "own goal" in detail or "missed" in detail:
            continue

        # Filter penalty shootouts. API-Football encodes time.elapsed for
        # in-match events (1-90+) and uses time.elapsed=120 max for ET. The
        # shootout-period sentinel varies by year but is typically detail=="Penalty"
        # with elapsed > 120 OR a separate "penalty shootout" flag. Conservative:
        # accept if elapsed <= 120 (90+ET), reject otherwise.
        time_block = ev.get("time") or {}
        elapsed = time_block.get("elapsed")
        if isinstance(elapsed, (int, float)) and elapsed > 120:
            continue

        player = ev.get("player") or {}
        name = player.get("name") or ""
        if not name:
            continue
        scorers.add(_normalize_player_name(name))

    return scorers


def grade_player_anytime(player_name: str, scorers: Set[str]) -> int:
    """Given a canonical player_name and a set of scorers (also canonical),
    return 1 if the player scored, 0 if they didn't.

    Pure function — no I/O. The lookup is exact-canonical match; the alias
    map handles "K. Mbappé" → "Kylian Mbappe" on both sides before reaching
    this function."""
    canonical = _normalize_player_name(player_name)
    return 1 if canonical in scorers else 0


def get_scorers_for_match(
    home_team: str,
    away_team: str,
    game_date: str,
) -> Optional[Set[str]]:
    """End-to-end helper used by the grader: resolves the fixture, fetches
    events, returns the set of scorers (canonical names) OR None if the
    fixture/events can't be resolved (caller should leave signal open).

    Returns:
      - A set (possibly empty) when the fixture exists AND events were
        retrieved successfully. Empty set means "we know nobody scored"
        (0-0 game) — anytime-scorer bets on any player grade LOSS.
      - None when we couldn't even find the fixture or events failed.
        Caller leaves the signal open and retries next run.
    """
    fixture_id = find_api_football_fixture(home_team, away_team, game_date)
    if fixture_id is None:
        return None
    events = fetch_fixture_events(fixture_id)
    if not events:
        # Could be "no events yet" (in progress) OR "rate-limited / plan error".
        # We can't disambiguate cleanly without another call; safest is to
        # treat as unresolved and try again next run.
        return None
    return extract_goalscorers(events)
