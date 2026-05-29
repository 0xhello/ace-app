#!/usr/bin/env python3
"""sportmonks_fixture.py — pre-match fixture bundle cache (M38).

Why this module exists
======================
For every fixture in our active league window we need three pre-match
signals from Sportmonks that the existing Understat+Odds-API pipeline
either guesses at (assumed minutes), can't see (cross-league xG), or
doesn't have at all (a second-opinion prediction stream):

  1. ``lineups.player`` — actual projected XI + position + jersey.
     Kills the ``_assumed_minutes = 74`` heuristic in ``player_props.py``.
     When a player is in the projected lineup we know they're starting
     (type_id=11). When they're a bench entry we know to demote the
     prop card. When they aren't in the lineup at all we skip.

  2. ``predictions.type`` — Sportmonks' own pre-match probabilities for
     1X2, BTTS, Totals 2.5, Corners ladder, team totals, etc. (28 markets
     per fixture). We use this as an INDEPENDENT cross-check, not as a
     replacement: if our Dixon-Coles says home 52% and Sportmonks says
     home 35%, we demote the pick — at least one of us is wrong.

  3. ``xGFixture.type`` — actual realized fixture xG, broken out by
     open-play / set-piece / corners / penalties. POST-MATCH ONLY (we
     confirmed pre-match returns 0 rows). Captured for grading + a
     future backtest training set; not used in live picks.

One ``GET /fixtures/{id}`` call returns all three includes. Each call
costs ~1 Sportmonks credit. A typical Big-5 + UCL slate is ~30 fixtures
per day, so one sync = ~30 credits. Refresh cadence:
  - 24h+ to kickoff:  once per day
  - <24h to kickoff:  every 6h (catches projected→confirmed lineup flips)

The data lands in ``soccer_sportmonks_fixture_cache`` keyed by Sportmonks
fixture_id. Downstream consumers look up by (home_team, away_team,
commence_time) using fuzzy team-name matching, since the Odds API and
Sportmonks use different team-display strings.

Auth: reads ``SPORTMONKS_API_TOKEN`` from .env.local (same token
``sportmonks_squads.py`` uses for WC squad sync). Never hardcoded.
"""
from __future__ import annotations

import json
import os
import sqlite3
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

# Sportmonks league_ids for the leagues our pipeline scans. Mirrors the
# (sport_key, tournament_label) tuples in ml/soccer/leagues.py; WC=732
# already used by sportmonks_squads.py. If you add a league to LEAGUES
# in leagues.py, add the matching Sportmonks id here.
SPORTMONKS_LEAGUE_IDS: Dict[str, int] = {
    "Premier League": 8,
    "La Liga":        564,
    "Bundesliga":     82,
    "Serie A":        384,
    "Ligue 1":        301,
    "UCL":            2,
    "World Cup":      732,
}

# Includes we always request — one call brings back the full pre-match
# bundle plus post-match xG when the match has settled. `participants`
# populates home_team_id / away_team_id (otherwise we only get the
# concatenated fixture.name and lineup-side filtering breaks).
_FIXTURE_BUNDLE_INCLUDES = (
    "lineups.player;predictions.type;xGFixture.type;participants"
)

# Refresh policy (used by sync_slate). Tunable from a single source.
REFRESH_FAR_HOURS = 24      # >24h from kickoff: refresh once a day
REFRESH_NEAR_HOURS = 6      # <24h from kickoff: refresh every 6h

# Sportmonks lineup type_id == 11 means "starting XI". 12+ means bench/sub.
# Confirmed via the live probe — Joe Gomez (starter) returned type_id=11.
LINEUP_TYPE_STARTER = 11


# ── Auth + HTTP plumbing ───────────────────────────────────────────────────

def _get_token() -> str:
    """Read SPORTMONKS_API_TOKEN from env. Mirrors the auth used by
    ml/world_cup/sportmonks_squads.py so a single rotation updates both."""
    tok = os.getenv("SPORTMONKS_API_TOKEN") or os.getenv("SPORTMONKS_TOKEN") or ""
    if not tok:
        raise EnvironmentError(
            "SPORTMONKS_API_TOKEN not set — put it in .env.local. "
            "Never hardcode in source."
        )
    return tok


def _sportmonks_get(
    path: str,
    params: Optional[Dict[str, Any]] = None,
    *,
    timeout: float = 20.0,
    retries: int = 2,
) -> Dict[str, Any]:
    """GET against /v3/football with auth + light retry on 429/5xx."""
    token = _get_token()
    merged: Dict[str, Any] = {"api_token": token, **(params or {})}
    url = f"{SPORTMONKS_BASE}{path}"
    last_exc: Optional[Exception] = None
    for attempt in range(retries + 1):
        try:
            resp = httpx.get(url, params=merged, timeout=timeout)
            if resp.status_code in (429, 502, 503, 504):
                wait = 2 ** attempt
                time.sleep(wait)
                continue
            resp.raise_for_status()
            return resp.json()
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            if attempt < retries:
                time.sleep(2 ** attempt)
                continue
            raise
    if last_exc:
        raise last_exc
    return {}


# ── DB schema ──────────────────────────────────────────────────────────────

def _get_db(path: Optional[Path] = None) -> sqlite3.Connection:
    p = path or DEFAULT_DB_PATH
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(p))
    conn.row_factory = sqlite3.Row
    return conn


def init_table(path: Optional[Path] = None) -> None:
    """Idempotently create soccer_sportmonks_fixture_cache.

    Schema notes:
      - fixture_id is the Sportmonks ID (their PK; INTEGER).
      - lineups_json / predictions_json store the FULL include payload as
        a JSON blob so downstream consumers can pivot the data however
        they need without us pre-flattening (cheap on a 30-row/day cache).
      - xgfixture_json is NULL until the match settles. settled_at marks
        the first sync that returned populated xGFixture data.
      - home_team_name / away_team_name are denormalized for fast lookup
        by string match from the Odds-API side (which doesn't know
        Sportmonks IDs).
    """
    conn = _get_db(path)
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS soccer_sportmonks_fixture_cache (
                fixture_id           INTEGER PRIMARY KEY,
                sportmonks_league_id INTEGER,
                league_name          TEXT,
                starting_at          TEXT,                -- ISO UTC
                home_team_id         INTEGER,
                away_team_id         INTEGER,
                home_team_name       TEXT,
                away_team_name       TEXT,
                lineups_json         TEXT,                -- list[dict] from include
                lineups_player_count INTEGER,
                predictions_json     TEXT,                -- dict {market_name: probs_dict}
                predictions_market_count INTEGER,
                xgfixture_json       TEXT,                -- dict {metric_name: {home,away}}
                xgfixture_metric_count INTEGER,
                settled_at           TEXT,                -- first time xGFixture came back populated
                fetched_at           TEXT NOT NULL,
                updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_smfx_starting
              ON soccer_sportmonks_fixture_cache(starting_at);
            CREATE INDEX IF NOT EXISTS idx_smfx_teams
              ON soccer_sportmonks_fixture_cache(home_team_name, away_team_name);
            CREATE INDEX IF NOT EXISTS idx_smfx_league
              ON soccer_sportmonks_fixture_cache(sportmonks_league_id, starting_at);
            """
        )
        conn.commit()
    finally:
        conn.close()


# ── Discovery + fetch ──────────────────────────────────────────────────────

def discover_fixtures_in_window(
    *,
    date_from: date,
    date_to: date,
    league_ids: Optional[List[int]] = None,
) -> List[Dict[str, Any]]:
    """List Sportmonks fixtures in [date_from, date_to] for the given leagues.

    Sportmonks ``/fixtures/between/{from}/{to}`` returns ALL fixtures in
    that window. We filter by league_id client-side to avoid having to
    rely on the ``filters=fixtureLeagues:...`` query param (the live
    probe showed it's brittle — works sometimes, silently returns nothing
    other times, especially across date ranges).

    Returned shape: each row is the raw Sportmonks fixture object with at
    least {id, league_id, starting_at, name, participants...}.
    """
    leagues = set(league_ids or list(SPORTMONKS_LEAGUE_IDS.values()))
    out: List[Dict[str, Any]] = []
    # Sportmonks paginates with ?page=. We follow has_more.
    page = 1
    while True:
        payload = _sportmonks_get(
            f"/fixtures/between/{date_from.isoformat()}/{date_to.isoformat()}",
            {
                "include": "participants",
                "per_page": 100,
                "page": page,
            },
        )
        for fx in payload.get("data") or []:
            if fx.get("league_id") in leagues:
                out.append(fx)
        pagination = (payload.get("pagination") or {})
        if not pagination.get("has_more"):
            break
        page = int(pagination.get("current_page") or page) + 1
        if page > 25:  # safety — Big-5 + UCL never paginates this deep
            break
    return out


def fetch_fixture_bundle(fixture_id: int) -> Dict[str, Any]:
    """Pull one fixture with all three includes. ~1 Sportmonks credit.

    Raises on transport error so callers can decide whether to retry or
    fall back. Returns the unwrapped ``data`` object.
    """
    payload = _sportmonks_get(
        f"/fixtures/{fixture_id}",
        {"include": _FIXTURE_BUNDLE_INCLUDES},
    )
    return payload.get("data") or {}


# ── Bundle normalization (raw Sportmonks → cache columns) ─────────────────

def _normalize_lineups(raw: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """Flatten Sportmonks lineup rows to the fields downstream code needs.

    Each row keeps the player_id (for joins), name, jersey, position_id,
    detailed_position_id, formation_field (e.g. '2:4'), formation_position
    (slot index), team_id, and ``is_starter`` derived from type_id==11.
    """
    out = []
    for row in raw or []:
        player = row.get("player") or {}
        out.append({
            "player_id":            row.get("player_id") or player.get("id"),
            "player_name":          row.get("player_name") or player.get("display_name") or player.get("name"),
            "common_name":          player.get("common_name"),
            "jersey_number":        row.get("jersey_number"),
            "team_id":              row.get("team_id"),
            "position_id":          row.get("position_id") or player.get("position_id"),
            "detailed_position_id": player.get("detailed_position_id"),
            "formation_field":      row.get("formation_field"),
            "formation_position":   row.get("formation_position"),
            "type_id":              row.get("type_id"),
            "is_starter":           row.get("type_id") == LINEUP_TYPE_STARTER,
        })
    return out


def _normalize_predictions(raw: Optional[List[Dict[str, Any]]]) -> Dict[str, Any]:
    """Pivot Sportmonks predictions list into {market_name: probs_dict}.

    Each raw row has {type: {name}, predictions: {...}}. We key by the
    type name (e.g. "Fulltime Result Probability", "Over/Under 2.5
    Probability") which is stable across fixtures.
    """
    out: Dict[str, Any] = {}
    for row in raw or []:
        t = row.get("type") or {}
        name = t.get("name") if isinstance(t, dict) else None
        if not name:
            continue
        out[name] = row.get("predictions")
    return out


def _normalize_xgfixture(raw: Optional[List[Dict[str, Any]]]) -> Dict[str, Any]:
    """Pivot xGFixture list into {metric_name: {home: float, away: float}}.

    Sportmonks returns one row per (metric, team) — we collapse into a
    nested dict so consumers can ask ``out["Expected Goals (xG)"]["home"]``.
    """
    out: Dict[str, Dict[str, Any]] = {}
    for row in raw or []:
        t = row.get("type") or {}
        name = t.get("name") if isinstance(t, dict) else None
        if not name:
            continue
        loc = row.get("location") or "home"
        val = (row.get("data") or {}).get("value")
        slot = out.setdefault(name, {})
        slot[loc] = val
    return out


def _extract_teams(fixture: Dict[str, Any]) -> Tuple[Optional[int], Optional[int], Optional[str], Optional[str]]:
    """Pull home/away team_id + name from a Sportmonks fixture object.

    Sportmonks puts participants in a nested list with a ``meta.location``
    of "home"/"away". Falls back to name parsing ("Home vs Away") when
    participants aren't included.
    """
    home_id = away_id = None
    home_name = away_name = None
    for p in fixture.get("participants") or []:
        meta = p.get("meta") or {}
        loc = meta.get("location")
        if loc == "home":
            home_id = p.get("id")
            home_name = p.get("name")
        elif loc == "away":
            away_id = p.get("id")
            away_name = p.get("name")
    if not home_name or not away_name:
        # Fallback parse from fixture.name: "Home vs Away"
        name = fixture.get("name") or ""
        if " vs " in name:
            h, a = name.split(" vs ", 1)
            home_name = home_name or h.strip()
            away_name = away_name or a.strip()
    return home_id, away_id, home_name, away_name


# ── Cache write ────────────────────────────────────────────────────────────

def cache_fixture_bundle(
    fixture_id: int,
    *,
    path: Optional[Path] = None,
    bundle: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Fetch the bundle (if not provided) and upsert into the cache table.

    Returns a small summary {fixture_id, lineups, predictions, xg_metrics,
    settled, fetched_at} for the orchestrator to print.
    """
    init_table(path)
    if bundle is None:
        bundle = fetch_fixture_bundle(fixture_id)

    home_id, away_id, home_name, away_name = _extract_teams(bundle)
    lineups = _normalize_lineups(bundle.get("lineups"))
    predictions = _normalize_predictions(bundle.get("predictions"))
    # The include comes back lowercase in the live probe
    xgfx = _normalize_xgfixture(
        bundle.get("xgfixture") or bundle.get("xGFixture") or []
    )

    now = datetime.now(timezone.utc).isoformat()
    settled_at = now if xgfx else None

    conn = _get_db(path)
    try:
        existing = conn.execute(
            "SELECT settled_at FROM soccer_sportmonks_fixture_cache WHERE fixture_id = ?",
            (fixture_id,),
        ).fetchone()
        if existing and existing["settled_at"]:
            # Already settled — keep the original settled_at so we don't churn the
            # column on every re-sync after the match ended.
            settled_at = existing["settled_at"]

        conn.execute(
            """
            INSERT INTO soccer_sportmonks_fixture_cache (
                fixture_id, sportmonks_league_id, league_name,
                starting_at, home_team_id, away_team_id,
                home_team_name, away_team_name,
                lineups_json, lineups_player_count,
                predictions_json, predictions_market_count,
                xgfixture_json, xgfixture_metric_count,
                settled_at, fetched_at, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(fixture_id) DO UPDATE SET
                sportmonks_league_id   = excluded.sportmonks_league_id,
                league_name            = excluded.league_name,
                starting_at            = excluded.starting_at,
                home_team_id           = excluded.home_team_id,
                away_team_id           = excluded.away_team_id,
                home_team_name         = excluded.home_team_name,
                away_team_name         = excluded.away_team_name,
                lineups_json           = excluded.lineups_json,
                lineups_player_count   = excluded.lineups_player_count,
                predictions_json       = excluded.predictions_json,
                predictions_market_count = excluded.predictions_market_count,
                xgfixture_json         = excluded.xgfixture_json,
                xgfixture_metric_count = excluded.xgfixture_metric_count,
                settled_at             = COALESCE(soccer_sportmonks_fixture_cache.settled_at, excluded.settled_at),
                fetched_at             = excluded.fetched_at,
                updated_at             = excluded.updated_at
            """,
            (
                fixture_id,
                bundle.get("league_id"),
                None,  # league_name resolved by sync_slate when it has the league context
                bundle.get("starting_at"),
                home_id, away_id, home_name, away_name,
                json.dumps(lineups, ensure_ascii=False) if lineups else None,
                len(lineups) or None,
                json.dumps(predictions, ensure_ascii=False) if predictions else None,
                len(predictions) or None,
                json.dumps(xgfx, ensure_ascii=False) if xgfx else None,
                len(xgfx) or None,
                settled_at,
                now, now,
            ),
        )
        conn.commit()
    finally:
        conn.close()

    return {
        "fixture_id":  fixture_id,
        "lineups":     len(lineups),
        "predictions": len(predictions),
        "xg_metrics":  len(xgfx),
        "settled":     settled_at is not None,
        "fetched_at":  now,
    }


# ── Orchestration ──────────────────────────────────────────────────────────

def _hours_until(starting_at_iso: Optional[str]) -> Optional[float]:
    if not starting_at_iso:
        return None
    try:
        # Sportmonks returns "YYYY-MM-DD HH:MM:SS" (UTC, no offset). Parse safely.
        s = starting_at_iso.replace("T", " ").replace("Z", "")
        t = datetime.fromisoformat(s).replace(tzinfo=timezone.utc)
        return (t - datetime.now(timezone.utc)).total_seconds() / 3600.0
    except Exception:
        return None


def _needs_refresh(row: sqlite3.Row, now: Optional[datetime] = None) -> bool:
    """Decide whether to re-fetch this fixture based on our refresh policy.

      - never fetched → yes
      - settled (post-match) → no (xGFixture is stable once final)
      - <REFRESH_NEAR_HOURS to kickoff AND fetched_at older than that → yes
      - otherwise → yes if fetched_at older than REFRESH_FAR_HOURS
    """
    now = now or datetime.now(timezone.utc)
    if not row["fetched_at"]:
        return True
    if row["settled_at"]:
        return False
    try:
        fetched = datetime.fromisoformat(row["fetched_at"])
        if fetched.tzinfo is None:
            fetched = fetched.replace(tzinfo=timezone.utc)
    except Exception:
        return True
    hours_since = (now - fetched).total_seconds() / 3600.0
    hours_to_ko = _hours_until(row["starting_at"])
    if hours_to_ko is not None and hours_to_ko < REFRESH_FAR_HOURS:
        return hours_since >= REFRESH_NEAR_HOURS
    return hours_since >= REFRESH_FAR_HOURS


def sync_slate(
    *,
    date_from: Optional[date] = None,
    days: int = 3,
    league_ids: Optional[List[int]] = None,
    force: bool = False,
    path: Optional[Path] = None,
    sleep_between_calls: float = 0.15,
) -> Dict[str, Any]:
    """Discover fixtures in window + (re-)fetch any whose cache is stale.

    Returns counts + per-fixture summaries so the ops UI / log can show
    what happened. Safe to run on a schedule; respects the refresh policy
    above unless ``force=True``.
    """
    init_table(path)
    date_from = date_from or datetime.now(timezone.utc).date()
    date_to = date_from + timedelta(days=days)
    league_ids = league_ids or list(SPORTMONKS_LEAGUE_IDS.values())

    discovered = discover_fixtures_in_window(
        date_from=date_from, date_to=date_to, league_ids=league_ids,
    )
    discovered_ids = [int(fx["id"]) for fx in discovered if fx.get("id")]
    # Build name lookup from the discovery payload — saves us a participants
    # include on the per-fixture call.
    discovery_meta = {int(fx["id"]): fx for fx in discovered if fx.get("id")}

    conn = _get_db(path)
    try:
        existing_rows = {
            int(r["fixture_id"]): r
            for r in conn.execute(
                "SELECT fixture_id, fetched_at, settled_at, starting_at "
                "FROM soccer_sportmonks_fixture_cache "
                "WHERE fixture_id IN (%s)"
                % ",".join(["?"] * len(discovered_ids)) if discovered_ids else "WHERE 0=1",
                discovered_ids or [],
            ).fetchall()
        } if discovered_ids else {}
    finally:
        conn.close()

    summaries: List[Dict[str, Any]] = []
    fetched = 0
    skipped = 0
    errors: List[Dict[str, Any]] = []
    for fxid in discovered_ids:
        row = existing_rows.get(fxid)
        if not force and row is not None and not _needs_refresh(row):
            skipped += 1
            continue
        try:
            summary = cache_fixture_bundle(fxid, path=path)
            fetched += 1
            # Backfill league_name + starting_at from discovery payload
            meta = discovery_meta.get(fxid) or {}
            league_name = (meta.get("league") or {}).get("name") if isinstance(meta.get("league"), dict) else None
            if league_name:
                conn2 = _get_db(path)
                try:
                    conn2.execute(
                        "UPDATE soccer_sportmonks_fixture_cache "
                        "   SET league_name = ?, updated_at = ? "
                        " WHERE fixture_id = ?",
                        (league_name, datetime.now(timezone.utc).isoformat(), fxid),
                    )
                    conn2.commit()
                finally:
                    conn2.close()
            summaries.append({**summary, "league_name": league_name})
            if sleep_between_calls:
                time.sleep(sleep_between_calls)
        except Exception as exc:  # noqa: BLE001
            errors.append({"fixture_id": fxid, "error": str(exc)[:200]})

    return {
        "window":     {"from": date_from.isoformat(), "to": date_to.isoformat()},
        "leagues":    league_ids,
        "discovered": len(discovered_ids),
        "fetched":    fetched,
        "skipped":    skipped,
        "errors":     errors,
        "summaries":  summaries[:25],  # cap inline detail; full data is in the table
    }


# ── Read accessors (for player_props.py wire-in + ops UI) ─────────────────

def _norm(s: str) -> str:
    return "".join(ch.lower() for ch in (s or "") if ch.isalnum())


def _norm_player(s: str) -> str:
    # Strip diacritics-equivalent characters lightly. We can't import unicodedata
    # for full normalization without bloating this module; basic alnum suffices
    # for the cases we've seen (Mbappé/Mbappe both collapse to "mbappe").
    table = str.maketrans("àáâãäåèéêëìíîïòóôõöùúûüýÿñç",
                          "aaaaaaeeeeiiiiooooouuuuyync")
    return "".join(ch.lower() for ch in (s or "").translate(table) if ch.isalnum())


def get_cached_bundle_by_fixture_id(
    fixture_id: int, *, path: Optional[Path] = None
) -> Optional[Dict[str, Any]]:
    """Read one cached bundle straight by Sportmonks fixture_id."""
    init_table(path)
    conn = _get_db(path)
    try:
        row = conn.execute(
            "SELECT * FROM soccer_sportmonks_fixture_cache WHERE fixture_id = ?",
            (fixture_id,),
        ).fetchone()
    finally:
        conn.close()
    return _row_to_bundle(row) if row else None


def get_cached_bundle_by_teams(
    home_team: str,
    away_team: str,
    *,
    commence_time_iso: Optional[str] = None,
    window_hours: float = 24.0,
    path: Optional[Path] = None,
) -> Optional[Dict[str, Any]]:
    """Find the cached fixture for an Odds-API style game.

    The Odds API and Sportmonks both store team-display names but spell
    them differently ("Paris Saint-Germain" vs "Paris Saint Germain"
    vs "Paris SG"). We do a normalized substring match. Optional
    ``commence_time_iso`` narrows the match to a ±window_hours band so
    we don't accidentally pick a different league's same-named game.
    """
    init_table(path)
    nh, na = _norm(home_team), _norm(away_team)
    conn = _get_db(path)
    try:
        rows = conn.execute(
            "SELECT * FROM soccer_sportmonks_fixture_cache"
        ).fetchall()
    finally:
        conn.close()

    target_ts: Optional[float] = None
    if commence_time_iso:
        try:
            t = datetime.fromisoformat(commence_time_iso.replace("Z", "+00:00"))
            target_ts = t.timestamp()
        except Exception:
            target_ts = None

    best: Optional[sqlite3.Row] = None
    best_delta = float("inf")
    for r in rows:
        h_match = nh and (nh in _norm(r["home_team_name"]) or _norm(r["home_team_name"]) in nh)
        a_match = na and (na in _norm(r["away_team_name"]) or _norm(r["away_team_name"]) in na)
        if not (h_match and a_match):
            continue
        if target_ts is None:
            best = r
            break
        try:
            s = (r["starting_at"] or "").replace("T", " ").replace("Z", "")
            t2 = datetime.fromisoformat(s).replace(tzinfo=timezone.utc).timestamp()
        except Exception:
            continue
        delta = abs(t2 - target_ts) / 3600.0
        if delta <= window_hours and delta < best_delta:
            best, best_delta = r, delta
    return _row_to_bundle(best) if best else None


def lookup_player_in_lineup(
    bundle: Dict[str, Any],
    player_name: str,
    *,
    team_side: Optional[str] = None,  # "home" or "away" — narrows the match
) -> Optional[Dict[str, Any]]:
    """Find a player in the cached lineup. Returns the lineup dict if found,
    None otherwise. ``team_side`` narrows the search to one team_id to avoid
    a name-collision across opponents (e.g. two "Lopez"es)."""
    if not bundle or not bundle.get("lineups"):
        return None
    target = _norm_player(player_name)
    home_id = bundle.get("home_team_id")
    away_id = bundle.get("away_team_id")
    allowed_team_id: Optional[int] = None
    if team_side == "home":
        allowed_team_id = home_id
    elif team_side == "away":
        allowed_team_id = away_id
    candidates = []
    for entry in bundle["lineups"]:
        if allowed_team_id is not None and entry.get("team_id") != allowed_team_id:
            continue
        for field in (entry.get("player_name"), entry.get("common_name")):
            if not field:
                continue
            if _norm_player(field) == target or target in _norm_player(field):
                candidates.append(entry)
                break
    if not candidates:
        return None
    # Prefer the starter if multiple matches
    candidates.sort(key=lambda e: (not e.get("is_starter"), e.get("player_id") or 0))
    return candidates[0]


def _row_to_bundle(row: sqlite3.Row) -> Dict[str, Any]:
    """Convert a DB row → friendly dict with JSON columns parsed."""
    def _parse(col: str) -> Any:
        v = row[col]
        if not v:
            return None
        try:
            return json.loads(v)
        except Exception:
            return None
    return {
        "fixture_id":           row["fixture_id"],
        "sportmonks_league_id": row["sportmonks_league_id"],
        "league_name":          row["league_name"],
        "starting_at":          row["starting_at"],
        "home_team_id":         row["home_team_id"],
        "away_team_id":         row["away_team_id"],
        "home_team_name":       row["home_team_name"],
        "away_team_name":       row["away_team_name"],
        "lineups":              _parse("lineups_json") or [],
        "predictions":          _parse("predictions_json") or {},
        "xgfixture":            _parse("xgfixture_json") or {},
        "settled_at":           row["settled_at"],
        "fetched_at":           row["fetched_at"],
    }


# ── CLI ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse

    p = argparse.ArgumentParser(description="Sportmonks fixture-bundle cache (M38)")
    sub = p.add_subparsers(dest="cmd", required=True)

    p_sync = sub.add_parser("sync", help="discover + cache the active slate")
    p_sync.add_argument("--days", type=int, default=3)
    p_sync.add_argument("--leagues", default=None,
                        help="comma-separated Sportmonks league_ids (defaults to Big-5+UCL+WC)")
    p_sync.add_argument("--force", action="store_true")

    p_one = sub.add_parser("fetch", help="cache a single fixture by Sportmonks ID")
    p_one.add_argument("fixture_id", type=int)

    p_get = sub.add_parser("get", help="read cached bundle by Sportmonks fixture_id")
    p_get.add_argument("fixture_id", type=int)

    p_find = sub.add_parser("find", help="find cached bundle by team names")
    p_find.add_argument("--home", required=True)
    p_find.add_argument("--away", required=True)
    p_find.add_argument("--commence", default=None)

    args = p.parse_args()
    if args.cmd == "sync":
        leagues = (
            [int(x) for x in args.leagues.split(",")] if args.leagues else None
        )
        print(json.dumps(sync_slate(days=args.days, league_ids=leagues, force=args.force),
                         indent=2, ensure_ascii=False))
    elif args.cmd == "fetch":
        print(json.dumps(cache_fixture_bundle(args.fixture_id),
                         indent=2, ensure_ascii=False))
    elif args.cmd == "get":
        b = get_cached_bundle_by_fixture_id(args.fixture_id)
        print(json.dumps(b, indent=2, ensure_ascii=False)
              if b else json.dumps({"error": "not in cache"}))
    elif args.cmd == "find":
        b = get_cached_bundle_by_teams(args.home, args.away,
                                       commence_time_iso=args.commence)
        print(json.dumps(b, indent=2, ensure_ascii=False)
              if b else json.dumps({"error": "no match"}))
