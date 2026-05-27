#!/usr/bin/env python3
"""
live_state.py — provider-pluggable soccer lineup/availability/result state.

ACE uses this as the live nervous system around prop cards:
  - pre-match: lineup/bench/injury/penalty-role context upgrades WATCH -> LEAN/PICK eligibility
  - post-match: player prop result values allow outcome grading

The schema is provider-neutral. External providers should normalize into these
three tables instead of leaking vendor-specific fields into the bettor logic.
"""
from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import httpx
from dotenv import load_dotenv

from ml.soccer.player_props import _norm
from ml.world_cup.signal_logger import DB_PATH as DEFAULT_DB_PATH, update_meta

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
load_dotenv(_REPO_ROOT / ".env.local")

SPORTMONKS_BASE = "https://api.sportmonks.com/v3/football"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_db(path: Optional[Path] = None) -> sqlite3.Connection:
    p = path or DEFAULT_DB_PATH
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(p)
    conn.row_factory = sqlite3.Row
    return conn


def init_db(path: Optional[Path] = None) -> None:
    conn = get_db(path)
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS soccer_live_player_state (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            game_id            TEXT NOT NULL,
            provider           TEXT NOT NULL,
            provider_fixture_id TEXT,
            team               TEXT NOT NULL,
            opponent           TEXT,
            player_name        TEXT NOT NULL,
            provider_player_id TEXT,
            lineup_status      TEXT NOT NULL DEFAULT 'projected_unknown',
            projected_minutes  REAL,
            penalty_role       TEXT NOT NULL DEFAULT 'unknown',
            set_piece_role     TEXT NOT NULL DEFAULT 'unknown',
            availability       TEXT NOT NULL DEFAULT 'unknown',
            injury_status      TEXT,
            position           TEXT,
            jersey_number      INTEGER,
            confidence         TEXT NOT NULL DEFAULT 'provider',
            source_updated_at  TEXT,
            notes              TEXT,
            raw_json           TEXT NOT NULL DEFAULT '{}',
            detected_at        TEXT NOT NULL,
            updated_at         TEXT NOT NULL,
            created_at         TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(game_id, provider, team, player_name)
        );
        CREATE INDEX IF NOT EXISTS idx_soccer_live_state_game_player
          ON soccer_live_player_state(game_id, player_name);
        CREATE INDEX IF NOT EXISTS idx_soccer_live_state_status
          ON soccer_live_player_state(lineup_status, availability);

        CREATE TABLE IF NOT EXISTS soccer_fixture_provider_map (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            game_id              TEXT NOT NULL,
            sport_key            TEXT,
            provider             TEXT NOT NULL,
            provider_fixture_id  TEXT NOT NULL,
            home_team            TEXT,
            away_team            TEXT,
            commence_time        TEXT,
            confidence           TEXT NOT NULL DEFAULT 'manual',
            raw_json             TEXT NOT NULL DEFAULT '{}',
            detected_at          TEXT NOT NULL,
            updated_at           TEXT NOT NULL,
            created_at           TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(game_id, provider)
        );
        CREATE INDEX IF NOT EXISTS idx_soccer_fixture_provider_map_provider
          ON soccer_fixture_provider_map(provider, provider_fixture_id);

        CREATE TABLE IF NOT EXISTS soccer_fixture_feature_snapshot (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            game_id              TEXT NOT NULL,
            provider             TEXT NOT NULL,
            provider_fixture_id  TEXT,
            state_id             INTEGER,
            state_name           TEXT,
            home_team            TEXT,
            away_team            TEXT,
            home_team_id         TEXT,
            away_team_id         TEXT,
            league_id            TEXT,
            season_id            TEXT,
            stage_id             TEXT,
            venue_id             TEXT,
            has_odds             INTEGER,
            has_premium_odds     INTEGER,
            lineup_count         INTEGER NOT NULL DEFAULT 0,
            starters_count       INTEGER NOT NULL DEFAULT 0,
            bench_count          INTEGER NOT NULL DEFAULT 0,
            sidelined_count      INTEGER NOT NULL DEFAULT 0,
            event_count          INTEGER NOT NULL DEFAULT 0,
            statistic_count      INTEGER NOT NULL DEFAULT 0,
            score_json           TEXT NOT NULL DEFAULT '[]',
            raw_json             TEXT NOT NULL DEFAULT '{}',
            detected_at          TEXT NOT NULL,
            updated_at           TEXT NOT NULL,
            created_at           TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(game_id, provider)
        );

        CREATE TABLE IF NOT EXISTS soccer_player_feature_snapshot (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            game_id              TEXT NOT NULL,
            provider             TEXT NOT NULL,
            provider_fixture_id  TEXT,
            team                 TEXT NOT NULL,
            opponent             TEXT,
            player_name          TEXT NOT NULL,
            provider_player_id   TEXT,
            lineup_status        TEXT NOT NULL DEFAULT 'projected_unknown',
            availability         TEXT NOT NULL DEFAULT 'unknown',
            position             TEXT,
            position_bucket      TEXT,
            formation_field      TEXT,
            formation_line       INTEGER,
            formation_slot       INTEGER,
            attack_role_score    REAL,
            projected_minutes    REAL,
            is_attacking_role    INTEGER NOT NULL DEFAULT 0,
            unavailable_reason   TEXT,
            minutes              REAL,
            goals                REAL,
            assists              REAL,
            shots                REAL,
            shots_on_target      REAL,
            yellow_cards         REAL,
            red_cards            REAL,
            raw_json             TEXT NOT NULL DEFAULT '{}',
            detected_at          TEXT NOT NULL,
            updated_at           TEXT NOT NULL,
            created_at           TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(game_id, provider, team, player_name)
        );
        CREATE INDEX IF NOT EXISTS idx_soccer_player_feature_game_player
          ON soccer_player_feature_snapshot(game_id, player_name);
        CREATE INDEX IF NOT EXISTS idx_soccer_player_feature_role
          ON soccer_player_feature_snapshot(lineup_status, position_bucket, attack_role_score);

        CREATE TABLE IF NOT EXISTS soccer_player_prop_results (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            game_id            TEXT NOT NULL,
            provider           TEXT NOT NULL,
            provider_fixture_id TEXT,
            team               TEXT NOT NULL,
            player_name        TEXT NOT NULL,
            provider_player_id TEXT,
            minutes            REAL,
            goals              REAL,
            assists            REAL,
            shots              REAL,
            shots_on_target    REAL,
            yellow_cards       REAL,
            red_cards          REAL,
            raw_json           TEXT NOT NULL DEFAULT '{}',
            detected_at        TEXT NOT NULL,
            updated_at         TEXT NOT NULL,
            created_at         TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(game_id, provider, team, player_name)
        );
        CREATE INDEX IF NOT EXISTS idx_soccer_prop_results_game_player
          ON soccer_player_prop_results(game_id, player_name);
        """
    )
    conn.commit()
    conn.close()


def _json(v: Any) -> str:
    return json.dumps(v if v is not None else {}, ensure_ascii=False)


def upsert_fixture_mapping(row: Dict[str, Any], path: Optional[Path] = None) -> None:
    init_db(path)
    now = utc_now()
    payload = {
        "game_id": row["game_id"],
        "sport_key": row.get("sport_key"),
        "provider": row.get("provider") or "sportmonks",
        "provider_fixture_id": row["provider_fixture_id"],
        "home_team": row.get("home_team"),
        "away_team": row.get("away_team"),
        "commence_time": row.get("commence_time"),
        "confidence": row.get("confidence") or "manual",
        "raw_json": _json(row.get("raw_json")),
        "detected_at": row.get("detected_at") or now,
        "updated_at": now,
    }
    cols = list(payload.keys())
    conn = get_db(path)
    try:
        conn.execute(
            f"""
            INSERT INTO soccer_fixture_provider_map ({','.join(cols)})
            VALUES ({','.join('?' for _ in cols)})
            ON CONFLICT(game_id, provider) DO UPDATE SET
              sport_key=excluded.sport_key,
              provider_fixture_id=excluded.provider_fixture_id,
              home_team=excluded.home_team,
              away_team=excluded.away_team,
              commence_time=excluded.commence_time,
              confidence=excluded.confidence,
              raw_json=excluded.raw_json,
              updated_at=excluded.updated_at
            """,
            [payload[c] for c in cols],
        )
        conn.commit()
    finally:
        conn.close()


def fixture_mappings(path: Optional[Path] = None, provider: str = "sportmonks") -> List[Dict[str, Any]]:
    init_db(path)
    conn = get_db(path)
    try:
        rows = conn.execute(
            "SELECT * FROM soccer_fixture_provider_map WHERE provider = ? ORDER BY commence_time DESC, updated_at DESC",
            (provider,),
        ).fetchall()
    finally:
        conn.close()
    return [dict(r) for r in rows]


def upsert_player_state(row: Dict[str, Any], path: Optional[Path] = None) -> None:
    init_db(path)
    now = utc_now()
    payload = {
        "game_id": row["game_id"],
        "provider": row.get("provider") or "manual",
        "provider_fixture_id": row.get("provider_fixture_id"),
        "team": row["team"],
        "opponent": row.get("opponent"),
        "player_name": row["player_name"],
        "provider_player_id": row.get("provider_player_id"),
        "lineup_status": row.get("lineup_status") or "projected_unknown",
        "projected_minutes": row.get("projected_minutes"),
        "penalty_role": row.get("penalty_role") or "unknown",
        "set_piece_role": row.get("set_piece_role") or "unknown",
        "availability": row.get("availability") or "unknown",
        "injury_status": row.get("injury_status"),
        "position": row.get("position"),
        "jersey_number": row.get("jersey_number"),
        "confidence": row.get("confidence") or "provider",
        "source_updated_at": row.get("source_updated_at"),
        "notes": row.get("notes"),
        "raw_json": _json(row.get("raw_json")),
        "detected_at": row.get("detected_at") or now,
        "updated_at": now,
    }
    cols = list(payload.keys())
    conn = get_db(path)
    try:
        conn.execute(
            f"""
            INSERT INTO soccer_live_player_state ({','.join(cols)})
            VALUES ({','.join('?' for _ in cols)})
            ON CONFLICT(game_id, provider, team, player_name) DO UPDATE SET
              provider_fixture_id=excluded.provider_fixture_id,
              opponent=excluded.opponent,
              provider_player_id=excluded.provider_player_id,
              lineup_status=excluded.lineup_status,
              projected_minutes=excluded.projected_minutes,
              penalty_role=excluded.penalty_role,
              set_piece_role=excluded.set_piece_role,
              availability=excluded.availability,
              injury_status=excluded.injury_status,
              position=excluded.position,
              jersey_number=excluded.jersey_number,
              confidence=excluded.confidence,
              source_updated_at=excluded.source_updated_at,
              notes=excluded.notes,
              raw_json=excluded.raw_json,
              updated_at=excluded.updated_at
            """,
            [payload[c] for c in cols],
        )
        conn.commit()
    finally:
        conn.close()


def upsert_fixture_features(row: Dict[str, Any], path: Optional[Path] = None) -> None:
    init_db(path)
    now = utc_now()
    payload = {
        "game_id": row["game_id"],
        "provider": row.get("provider") or "sportmonks",
        "provider_fixture_id": row.get("provider_fixture_id"),
        "state_id": row.get("state_id"),
        "state_name": row.get("state_name"),
        "home_team": row.get("home_team"),
        "away_team": row.get("away_team"),
        "home_team_id": row.get("home_team_id"),
        "away_team_id": row.get("away_team_id"),
        "league_id": row.get("league_id"),
        "season_id": row.get("season_id"),
        "stage_id": row.get("stage_id"),
        "venue_id": row.get("venue_id"),
        "has_odds": 1 if row.get("has_odds") else 0,
        "has_premium_odds": 1 if row.get("has_premium_odds") else 0,
        "lineup_count": row.get("lineup_count") or 0,
        "starters_count": row.get("starters_count") or 0,
        "bench_count": row.get("bench_count") or 0,
        "sidelined_count": row.get("sidelined_count") or 0,
        "event_count": row.get("event_count") or 0,
        "statistic_count": row.get("statistic_count") or 0,
        "score_json": _json(row.get("score_json") or []),
        "raw_json": _json(row.get("raw_json")),
        "detected_at": row.get("detected_at") or now,
        "updated_at": now,
    }
    cols = list(payload.keys())
    conn = get_db(path)
    try:
        conn.execute(
            f"""
            INSERT INTO soccer_fixture_feature_snapshot ({','.join(cols)})
            VALUES ({','.join('?' for _ in cols)})
            ON CONFLICT(game_id, provider) DO UPDATE SET
              provider_fixture_id=excluded.provider_fixture_id,
              state_id=excluded.state_id,
              state_name=excluded.state_name,
              home_team=excluded.home_team,
              away_team=excluded.away_team,
              home_team_id=excluded.home_team_id,
              away_team_id=excluded.away_team_id,
              league_id=excluded.league_id,
              season_id=excluded.season_id,
              stage_id=excluded.stage_id,
              venue_id=excluded.venue_id,
              has_odds=excluded.has_odds,
              has_premium_odds=excluded.has_premium_odds,
              lineup_count=excluded.lineup_count,
              starters_count=excluded.starters_count,
              bench_count=excluded.bench_count,
              sidelined_count=excluded.sidelined_count,
              event_count=excluded.event_count,
              statistic_count=excluded.statistic_count,
              score_json=excluded.score_json,
              raw_json=excluded.raw_json,
              updated_at=excluded.updated_at
            """,
            [payload[c] for c in cols],
        )
        conn.commit()
    finally:
        conn.close()


def upsert_player_features(row: Dict[str, Any], path: Optional[Path] = None) -> None:
    init_db(path)
    now = utc_now()
    payload = {
        "game_id": row["game_id"],
        "provider": row.get("provider") or "sportmonks",
        "provider_fixture_id": row.get("provider_fixture_id"),
        "team": row["team"],
        "opponent": row.get("opponent"),
        "player_name": row["player_name"],
        "provider_player_id": row.get("provider_player_id"),
        "lineup_status": row.get("lineup_status") or "projected_unknown",
        "availability": row.get("availability") or "unknown",
        "position": row.get("position"),
        "position_bucket": row.get("position_bucket"),
        "formation_field": row.get("formation_field"),
        "formation_line": row.get("formation_line"),
        "formation_slot": row.get("formation_slot"),
        "attack_role_score": row.get("attack_role_score"),
        "projected_minutes": row.get("projected_minutes"),
        "is_attacking_role": 1 if row.get("is_attacking_role") else 0,
        "unavailable_reason": row.get("unavailable_reason"),
        "minutes": row.get("minutes"),
        "goals": row.get("goals"),
        "assists": row.get("assists"),
        "shots": row.get("shots"),
        "shots_on_target": row.get("shots_on_target"),
        "yellow_cards": row.get("yellow_cards"),
        "red_cards": row.get("red_cards"),
        "raw_json": _json(row.get("raw_json")),
        "detected_at": row.get("detected_at") or now,
        "updated_at": now,
    }
    cols = list(payload.keys())
    conn = get_db(path)
    try:
        conn.execute(
            f"""
            INSERT INTO soccer_player_feature_snapshot ({','.join(cols)})
            VALUES ({','.join('?' for _ in cols)})
            ON CONFLICT(game_id, provider, team, player_name) DO UPDATE SET
              provider_fixture_id=excluded.provider_fixture_id,
              opponent=excluded.opponent,
              provider_player_id=excluded.provider_player_id,
              lineup_status=excluded.lineup_status,
              availability=excluded.availability,
              position=excluded.position,
              position_bucket=excluded.position_bucket,
              formation_field=excluded.formation_field,
              formation_line=excluded.formation_line,
              formation_slot=excluded.formation_slot,
              attack_role_score=excluded.attack_role_score,
              projected_minutes=excluded.projected_minutes,
              is_attacking_role=excluded.is_attacking_role,
              unavailable_reason=excluded.unavailable_reason,
              minutes=excluded.minutes,
              goals=excluded.goals,
              assists=excluded.assists,
              shots=excluded.shots,
              shots_on_target=excluded.shots_on_target,
              yellow_cards=excluded.yellow_cards,
              red_cards=excluded.red_cards,
              raw_json=excluded.raw_json,
              updated_at=excluded.updated_at
            """,
            [payload[c] for c in cols],
        )
        conn.commit()
    finally:
        conn.close()


def upsert_player_result(row: Dict[str, Any], path: Optional[Path] = None) -> None:
    init_db(path)
    now = utc_now()
    payload = {
        "game_id": row["game_id"],
        "provider": row.get("provider") or "manual",
        "provider_fixture_id": row.get("provider_fixture_id"),
        "team": row["team"],
        "player_name": row["player_name"],
        "provider_player_id": row.get("provider_player_id"),
        "minutes": row.get("minutes"),
        "goals": row.get("goals"),
        "assists": row.get("assists"),
        "shots": row.get("shots"),
        "shots_on_target": row.get("shots_on_target"),
        "yellow_cards": row.get("yellow_cards"),
        "red_cards": row.get("red_cards"),
        "raw_json": _json(row.get("raw_json")),
        "detected_at": row.get("detected_at") or now,
        "updated_at": now,
    }
    cols = list(payload.keys())
    conn = get_db(path)
    try:
        conn.execute(
            f"""
            INSERT INTO soccer_player_prop_results ({','.join(cols)})
            VALUES ({','.join('?' for _ in cols)})
            ON CONFLICT(game_id, provider, team, player_name) DO UPDATE SET
              provider_fixture_id=excluded.provider_fixture_id,
              provider_player_id=excluded.provider_player_id,
              minutes=excluded.minutes,
              goals=excluded.goals,
              assists=excluded.assists,
              shots=excluded.shots,
              shots_on_target=excluded.shots_on_target,
              yellow_cards=excluded.yellow_cards,
              red_cards=excluded.red_cards,
              raw_json=excluded.raw_json,
              updated_at=excluded.updated_at
            """,
            [payload[c] for c in cols],
        )
        conn.commit()
    finally:
        conn.close()


def find_player_features(game_id: str, player_name: str, team: Optional[str] = None, path: Optional[Path] = None) -> Optional[Dict[str, Any]]:
    init_db(path)
    n = _norm(player_name)
    conn = get_db(path)
    try:
        rows = conn.execute(
            """
            SELECT * FROM soccer_player_feature_snapshot
            WHERE game_id = ?
            ORDER BY CASE lineup_status WHEN 'confirmed_starting' THEN 0 WHEN 'projected_starting' THEN 1 WHEN 'bench' THEN 2 WHEN 'out' THEN 3 ELSE 4 END,
                     updated_at DESC
            """,
            (game_id,),
        ).fetchall()
    finally:
        conn.close()
    for r in rows:
        d = dict(r)
        if team and _norm(d.get("team") or "") != _norm(team):
            continue
        pn = _norm(d.get("player_name") or "")
        if n == pn or n in pn or pn in n:
            try:
                d["raw"] = json.loads(d.pop("raw_json") or "{}")
            except Exception:
                d["raw"] = {}
            return d
    return None


def find_player_state(game_id: str, player_name: str, team: Optional[str] = None, path: Optional[Path] = None) -> Optional[Dict[str, Any]]:
    init_db(path)
    n = _norm(player_name)
    conn = get_db(path)
    try:
        rows = conn.execute(
            """
            SELECT * FROM soccer_live_player_state
            WHERE game_id = ?
            ORDER BY CASE lineup_status WHEN 'confirmed_starting' THEN 0 WHEN 'projected_starting' THEN 1 WHEN 'bench' THEN 2 ELSE 3 END,
                     updated_at DESC
            """,
            (game_id,),
        ).fetchall()
    finally:
        conn.close()
    for r in rows:
        d = dict(r)
        if team and _norm(d.get("team") or "") != _norm(team):
            continue
        pn = _norm(d.get("player_name") or "")
        if n == pn or n in pn or pn in n:
            try:
                d["raw"] = json.loads(d.pop("raw_json") or "{}")
            except Exception:
                d["raw"] = {}
            return d
    return None


def apply_live_state_to_card(card: Dict[str, Any], game_id: str, path: Optional[Path] = None) -> Dict[str, Any]:
    team = card.get("team") or card.get("country")
    state = find_player_state(game_id, card.get("player_name") or "", team, path)
    features = find_player_features(game_id, card.get("player_name") or "", team, path)
    if not state and not features:
        return card
    out = dict(card)
    ctx = dict(out.get("context") or {})
    role = dict(ctx.get("role_today") or {})
    source = features or state or {}
    role.update({
        "lineup_status": source.get("lineup_status") or role.get("lineup_status") or "projected_unknown",
        "assumed_minutes": source.get("projected_minutes") or role.get("assumed_minutes"),
        "penalty_role": (state or {}).get("penalty_role") or role.get("penalty_role") or "unknown",
        "set_piece_role": (state or {}).get("set_piece_role") or role.get("set_piece_role") or "unknown",
        "availability": source.get("availability") or "unknown",
        "injury_status": (state or {}).get("injury_status") or source.get("unavailable_reason"),
        "position": source.get("position"),
        "position_bucket": source.get("position_bucket"),
        "formation_field": source.get("formation_field"),
        "formation_line": source.get("formation_line"),
        "attack_role_score": source.get("attack_role_score"),
        "is_attacking_role": bool(source.get("is_attacking_role")),
        "source": source.get("provider"),
        "source_updated_at": source.get("source_updated_at") or source.get("updated_at"),
        "notes": (state or {}).get("notes") or "Live-state feature parser override applied.",
    })
    ctx["role_today"] = role
    out["context"] = ctx
    if source.get("projected_minutes"):
        out["assumed_minutes"] = source.get("projected_minutes")
    return out


def _sportmonks_token() -> str:
    return os.getenv("SPORTMONKS_API_TOKEN") or os.getenv("SPORTMONKS_TOKEN") or ""


def _sportmonks_get(path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    token = _sportmonks_token()
    if not token:
        raise EnvironmentError("SPORTMONKS_API_TOKEN not set")
    merged = {"api_token": token, **(params or {})}
    resp = httpx.get(f"{SPORTMONKS_BASE}{path}", params=merged, timeout=20)
    resp.raise_for_status()
    return resp.json()


def sportmonks_fixture_state(provider_fixture_id: str) -> Dict[str, Any]:
    """Fetch one Sportmonks fixture with lineup/sidelined/result includes."""
    return _sportmonks_get(
        f"/fixtures/{provider_fixture_id}",
        {"include": "participants;metadata;state;venue;league;lineups.player;lineups.position;lineups.details.type;sidelined.sideline;sidelined.player;events;statistics;periods;scores"},
    )


def _position_bucket_from_name(position: Optional[str]) -> str:
    s = (position or "").lower()
    if "goalkeeper" in s:
        return "goalkeeper"
    if "defender" in s or "back" in s:
        return "defender"
    if "midfielder" in s or "midfield" in s:
        return "midfielder"
    if "attacker" in s or "forward" in s or "striker" in s or "winger" in s:
        return "attacker"
    return "unknown"


def _formation_parts(field: Optional[str]) -> Tuple[Optional[int], Optional[int]]:
    if not field or ":" not in field:
        return None, None
    try:
        a, b = field.split(":", 1)
        return int(a), int(b)
    except Exception:
        return None, None


def _attack_role_score(position: Optional[str], formation_field: Optional[str], lineup_status: str) -> float:
    bucket = _position_bucket_from_name(position)
    line, _slot = _formation_parts(formation_field)
    score = {"goalkeeper": 0.02, "defender": 0.15, "midfielder": 0.45, "attacker": 0.75}.get(bucket, 0.30)
    if line is not None:
        # Sportmonks formation lines are goal -> defense -> midfield -> attack.
        score += max(0.0, min(0.25, (line - 2) * 0.08))
    if lineup_status == "bench":
        score *= 0.45
    if lineup_status == "out":
        score = 0.0
    return round(max(0.0, min(score, 1.0)), 3)


def _stat_from_details(details: Any, names: Iterable[str]) -> Optional[float]:
    if not isinstance(details, list):
        return None
    wanted = {_norm(n) for n in names}
    for d in details:
        if not isinstance(d, dict):
            continue
        typ = d.get("type") or {}
        label = typ.get("name") or typ.get("code") or typ.get("developer_name") or d.get("type_name") or d.get("name")
        if _norm(str(label or "")) not in wanted:
            continue
        val = d.get("value") or d.get("data", {}).get("value") if isinstance(d.get("data"), dict) else d.get("value")
        try:
            return float(val)
        except Exception:
            return None
    return None


def _nested_name(obj: Dict[str, Any], *keys: str) -> Optional[str]:
    cur: Any = obj
    for key in keys:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(key)
    if isinstance(cur, str):
        return cur
    if isinstance(cur, dict):
        return cur.get("display_name") or cur.get("name") or cur.get("common_name")
    return None


TEAM_ALIASES = {
    "saint etienne": "saintetienne",
    "saint étienne": "saintetienne",
    "st etienne": "saintetienne",
    "paris sg": "parissaintgermain",
    "psg": "parissaintgermain",
    "sc paderborn": "paderborn",
    "sc paderborn 07": "paderborn",
}


def _team_key(name: str) -> str:
    raw = (name or "").lower().replace("é", "e").replace("è", "e")
    if raw in TEAM_ALIASES:
        return TEAM_ALIASES[raw]
    stripped = _norm(raw)
    return TEAM_ALIASES.get(raw, stripped)


def _team_match(a: str, b: str) -> bool:
    ak, bk = _team_key(a), _team_key(b)
    return bool(ak and bk and (ak == bk or ak in bk or bk in ak))


def _parse_time(ts: str) -> Optional[datetime]:
    if not ts:
        return None
    try:
        if "T" in ts:
            return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(timezone.utc).replace(tzinfo=None)
        return datetime.fromisoformat(ts).replace(tzinfo=None)
    except Exception:
        return None


def search_sportmonks_teams(name: str, limit: int = 8) -> List[Dict[str, Any]]:
    payload = _sportmonks_get(f"/teams/search/{name}", {"per_page": limit})
    return payload.get("data") or []


def sportmonks_fixtures_for_team(team_id: int, start: str, end: str, limit: int = 30) -> List[Dict[str, Any]]:
    payload = _sportmonks_get(
        f"/fixtures/between/{start}/{end}/{team_id}",
        {"include": "participants;league", "per_page": limit},
    )
    return payload.get("data") or []


def find_sportmonks_fixture_for_game(game: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Best-effort Odds API game -> Sportmonks fixture matcher.

    Searches both teams, pulls fixtures in a ±1 day window, and scores by exact
    team pair + kickoff proximity. Access gaps simply return None.
    """
    home = game.get("home_team") or ""
    away = game.get("away_team") or ""
    commence = _parse_time(game.get("commence_time") or "")
    if not home or not away or not commence:
        return None
    start = (commence.date() - timedelta(days=1)).isoformat()
    end = (commence.date() + timedelta(days=1)).isoformat()
    candidates: List[Dict[str, Any]] = []
    seen: set[int] = set()
    for query in [home, away]:
        for team in search_sportmonks_teams(query):
            tid = team.get("id")
            if not tid:
                continue
            # Avoid noisy teams whose name clearly doesn't match the query.
            if not _team_match(query, team.get("name") or "") and len(candidates) > 0:
                continue
            try:
                fixtures = sportmonks_fixtures_for_team(int(tid), start, end)
            except Exception:
                continue
            for f in fixtures:
                fid = f.get("id")
                if fid in seen:
                    continue
                seen.add(fid)
                candidates.append(f)
    scored: List[Tuple[float, Dict[str, Any]]] = []
    for f in candidates:
        parts = f.get("participants") or []
        names = [p.get("name") or "" for p in parts]
        if not any(_team_match(home, n) for n in names) or not any(_team_match(away, n) for n in names):
            continue
        ft = _parse_time(f.get("starting_at") or "")
        if not ft:
            continue
        minutes = abs((ft - commence).total_seconds()) / 60.0
        if minutes > 180:
            continue
        score = minutes
        scored.append((score, f))
    if not scored:
        return None
    scored.sort(key=lambda x: x[0])
    return scored[0][1]


def auto_map_sportmonks_games(games: Iterable[Dict[str, Any]], *, sport_key: Optional[str] = None, path: Optional[Path] = None) -> Dict[str, Any]:
    init_db(path)
    summary = {"ok": True, "checked": 0, "mapped": 0, "unmatched": []}
    for game in games:
        summary["checked"] += 1
        match = find_sportmonks_fixture_for_game(game)
        if not match:
            summary["unmatched"].append({"game_id": game.get("id"), "home_team": game.get("home_team"), "away_team": game.get("away_team")})
            continue
        upsert_fixture_mapping({
            "game_id": game["id"],
            "sport_key": sport_key,
            "provider": "sportmonks",
            "provider_fixture_id": str(match["id"]),
            "home_team": game.get("home_team"),
            "away_team": game.get("away_team"),
            "commence_time": game.get("commence_time"),
            "confidence": "auto_team_time",
            "raw_json": match,
        }, path)
        summary["mapped"] += 1
    update_meta("job:live_state_map:last_run_at", utc_now(), path=path)
    update_meta("job:live_state_map:last_mapped", str(summary["mapped"]), path=path)
    return summary


def _fixture_feature_row(data: Dict[str, Any], *, game_id: str, provider_fixture_id: str) -> Dict[str, Any]:
    participants = data.get("participants") or []
    home = next((p for p in participants if (p.get("meta") or {}).get("location") == "home"), None)
    away = next((p for p in participants if (p.get("meta") or {}).get("location") == "away"), None)
    lineups = data.get("lineups") or []
    starters = [x for x in lineups if x.get("type_id") in {11, "11"}]
    bench = [x for x in lineups if x.get("type_id") in {12, "12"}]
    return {
        "game_id": game_id,
        "provider": "sportmonks",
        "provider_fixture_id": provider_fixture_id,
        "state_id": data.get("state_id"),
        "state_name": _nested_name(data, "state"),
        "home_team": (home or {}).get("name"),
        "away_team": (away or {}).get("name"),
        "home_team_id": str((home or {}).get("id")) if (home or {}).get("id") is not None else None,
        "away_team_id": str((away or {}).get("id")) if (away or {}).get("id") is not None else None,
        "league_id": str(data.get("league_id")) if data.get("league_id") is not None else None,
        "season_id": str(data.get("season_id")) if data.get("season_id") is not None else None,
        "stage_id": str(data.get("stage_id")) if data.get("stage_id") is not None else None,
        "venue_id": str(data.get("venue_id")) if data.get("venue_id") is not None else None,
        "has_odds": data.get("has_odds"),
        "has_premium_odds": data.get("has_premium_odds"),
        "lineup_count": len(lineups),
        "starters_count": len(starters),
        "bench_count": len(bench),
        "sidelined_count": len(data.get("sidelined") or []),
        "event_count": len(data.get("events") or []),
        "statistic_count": len(data.get("statistics") or []),
        "score_json": data.get("scores") or [],
        "raw_json": {
            "id": data.get("id"),
            "name": data.get("name"),
            "starting_at": data.get("starting_at"),
            "result_info": data.get("result_info"),
        },
    }


def _player_feature_rows(data: Dict[str, Any], *, game_id: str, provider_fixture_id: str) -> List[Dict[str, Any]]:
    participants = data.get("participants") or []
    teams_by_id: Dict[str, str] = {}
    teams: List[str] = []
    for p in participants if isinstance(participants, list) else []:
        tid = p.get("id") or p.get("team_id")
        name = p.get("name") or p.get("display_name") or p.get("short_code")
        if tid is not None and name:
            teams_by_id[str(tid)] = name
            teams.append(name)
    rows: List[Dict[str, Any]] = []
    for item in data.get("lineups") or []:
        player = item.get("player") or {}
        player_name = player.get("display_name") or player.get("name") or item.get("player_name") or item.get("name")
        if not player_name:
            continue
        team_id = item.get("team_id") or item.get("participant_id")
        team = teams_by_id.get(str(team_id)) or item.get("team_name") or item.get("team") or "unknown"
        lineup_status = "confirmed_starting" if item.get("type_id") in {11, "11"} else "bench" if item.get("type_id") in {12, "12"} else "projected_unknown"
        pos = _nested_name(item, "position") or item.get("position_name")
        field = item.get("formation_field")
        line, slot = _formation_parts(field)
        score = _attack_role_score(pos, field, lineup_status)
        details = item.get("details")
        minutes = _stat_from_details(details, ["minutes", "minutes played"])
        goals = _stat_from_details(details, ["goals", "goal"])
        shots = _stat_from_details(details, ["shots", "total shots"])
        sot = _stat_from_details(details, ["shots on target", "shots_on_target"])
        rows.append({
            "game_id": game_id,
            "provider": "sportmonks",
            "provider_fixture_id": provider_fixture_id,
            "team": team,
            "opponent": next((t for t in teams if t != team), None),
            "player_name": player_name,
            "provider_player_id": str(player.get("id") or item.get("player_id") or "") or None,
            "lineup_status": lineup_status,
            "availability": "available",
            "position": pos,
            "position_bucket": _position_bucket_from_name(pos),
            "formation_field": field,
            "formation_line": line,
            "formation_slot": slot,
            "attack_role_score": score,
            "projected_minutes": 78 if lineup_status == "confirmed_starting" else 20 if lineup_status == "bench" else None,
            "is_attacking_role": score >= 0.55,
            "minutes": minutes,
            "goals": goals,
            "assists": _stat_from_details(details, ["assists", "assist"]),
            "shots": shots,
            "shots_on_target": sot,
            "yellow_cards": _stat_from_details(details, ["yellow cards", "yellowcard"]),
            "red_cards": _stat_from_details(details, ["red cards", "redcard"]),
            "raw_json": item,
        })
    for item in data.get("sidelined") or []:
        player = item.get("player") or {}
        player_name = player.get("display_name") or player.get("name") or item.get("player_name")
        if not player_name:
            continue
        team_id = item.get("team_id") or item.get("participant_id")
        team = teams_by_id.get(str(team_id)) or item.get("team_name") or "unknown"
        rows.append({
            "game_id": game_id,
            "provider": "sportmonks",
            "provider_fixture_id": provider_fixture_id,
            "team": team,
            "opponent": next((t for t in teams if t != team), None),
            "player_name": player_name,
            "provider_player_id": str(player.get("id") or item.get("player_id") or "") or None,
            "lineup_status": "out",
            "availability": "out",
            "position": _nested_name(item, "position"),
            "position_bucket": "unknown",
            "attack_role_score": 0.0,
            "projected_minutes": 0,
            "is_attacking_role": False,
            "unavailable_reason": item.get("type") or item.get("category") or item.get("reason"),
            "raw_json": item,
        })
    return rows


def normalize_sportmonks_fixture(payload: Dict[str, Any], *, game_id: str, provider_fixture_id: str) -> List[Dict[str, Any]]:
    data = payload.get("data") or payload
    participants = data.get("participants") or []
    teams_by_id: Dict[str, str] = {}
    teams = []
    for p in participants if isinstance(participants, list) else []:
        tid = p.get("id") or p.get("team_id")
        name = p.get("name") or p.get("display_name") or p.get("short_code")
        if tid is not None and name:
            teams_by_id[str(tid)] = name
            teams.append(name)
    rows: List[Dict[str, Any]] = []
    for item in data.get("lineups") or []:
        player = item.get("player") or {}
        player_name = player.get("display_name") or player.get("name") or item.get("player_name") or item.get("name")
        if not player_name:
            continue
        team_id = item.get("team_id") or item.get("participant_id")
        team = teams_by_id.get(str(team_id)) or item.get("team_name") or item.get("team") or "unknown"
        status_raw = str(item.get("type") or item.get("lineup_type") or item.get("formation_position") or "").lower()
        if item.get("type_id") in {11, "11"} or status_raw in {"starting", "lineup", "start"}:
            lineup_status = "confirmed_starting"
            minutes = 78
        elif item.get("type_id") in {12, "12"} or "bench" in status_raw or "sub" in status_raw:
            lineup_status = "bench"
            minutes = 20
        else:
            lineup_status = "confirmed_starting" if item.get("formation_position") else "projected_unknown"
            minutes = 72 if lineup_status == "confirmed_starting" else None
        rows.append({
            "game_id": game_id,
            "provider": "sportmonks",
            "provider_fixture_id": provider_fixture_id,
            "team": team,
            "opponent": next((t for t in teams if t != team), None),
            "player_name": player_name,
            "provider_player_id": str(player.get("id") or item.get("player_id") or "") or None,
            "lineup_status": lineup_status,
            "projected_minutes": minutes,
            "penalty_role": "unknown",
            "set_piece_role": "unknown",
            "availability": "available",
            "position": _nested_name(item, "position") or item.get("position_name"),
            "jersey_number": item.get("jersey_number") or item.get("number"),
            "confidence": "confirmed" if lineup_status in {"confirmed_starting", "bench"} else "provider",
            "raw_json": item,
        })
    for item in data.get("sidelined") or []:
        player = item.get("player") or {}
        player_name = player.get("display_name") or player.get("name") or item.get("player_name")
        if not player_name:
            continue
        team_id = item.get("team_id") or item.get("participant_id")
        team = teams_by_id.get(str(team_id)) or item.get("team_name") or "unknown"
        rows.append({
            "game_id": game_id,
            "provider": "sportmonks",
            "provider_fixture_id": provider_fixture_id,
            "team": team,
            "opponent": next((t for t in teams if t != team), None),
            "player_name": player_name,
            "provider_player_id": str(player.get("id") or item.get("player_id") or "") or None,
            "lineup_status": "out",
            "projected_minutes": 0,
            "availability": "out",
            "injury_status": item.get("type") or item.get("category") or item.get("reason"),
            "confidence": "confirmed",
            "notes": item.get("reason"),
            "raw_json": item,
        })
    return rows


def sync_sportmonks_fixture(game_id: str, provider_fixture_id: str, path: Optional[Path] = None) -> Dict[str, Any]:
    init_db(path)
    update_meta("job:live_state:last_error", "", path=path)
    payload = sportmonks_fixture_state(provider_fixture_id)
    data = payload.get("data") or payload
    rows = normalize_sportmonks_fixture(payload, game_id=game_id, provider_fixture_id=provider_fixture_id)
    feature_rows = _player_feature_rows(data, game_id=game_id, provider_fixture_id=provider_fixture_id)
    upsert_fixture_features(_fixture_feature_row(data, game_id=game_id, provider_fixture_id=provider_fixture_id), path)
    for row in rows:
        upsert_player_state(row, path)
    for row in feature_rows:
        upsert_player_features(row, path)
        # If Sportmonks exposes post-match detail stats, persist them to the
        # generic prop-result table so Grade Props can settle cards.
        if any(row.get(k) is not None for k in ("goals", "shots", "shots_on_target", "minutes")):
            upsert_player_result(row, path)
    update_meta("job:live_state:last_run_at", utc_now(), path=path)
    update_meta("job:live_state:last_provider", "sportmonks", path=path)
    update_meta("job:live_state:last_rows", str(len(rows)), path=path)
    update_meta("job:live_state:last_feature_rows", str(len(feature_rows)), path=path)
    return {"ok": True, "provider": "sportmonks", "game_id": game_id, "provider_fixture_id": provider_fixture_id, "rows": len(rows), "feature_rows": len(feature_rows)}


def sync_mapped_sportmonks(path: Optional[Path] = None, limit: int = 10) -> Dict[str, Any]:
    maps = fixture_mappings(path, provider="sportmonks")[:limit]
    out = {"ok": True, "attempted": 0, "synced": 0, "errors": []}
    for m in maps:
        out["attempted"] += 1
        try:
            result = sync_sportmonks_fixture(m["game_id"], m["provider_fixture_id"], path)
            out["synced"] += 1 if result.get("ok") else 0
        except Exception as e:
            out["errors"].append({"game_id": m["game_id"], "fixture_id": m["provider_fixture_id"], "error": str(e)})
    update_meta("job:live_state:last_run_at", utc_now(), path=path)
    update_meta("job:live_state:last_rows", str(out["synced"]), path=path)
    if out["errors"]:
        update_meta("job:live_state:last_error", out["errors"][0]["error"], path=path)
    return out


def auto_map_upcoming_odds(path: Optional[Path] = None, horizon_hours: int = 168) -> Dict[str, Any]:
    from ml.soccer.leagues import LEAGUES, fetch_league_odds, filter_upcoming
    summary = {"ok": True, "leagues": {}, "checked": 0, "mapped": 0, "unmatched": []}
    for sport_key, tournament, _active_until in LEAGUES:
        try:
            games = filter_upcoming(fetch_league_odds(sport_key), horizon_hours=horizon_hours)
        except Exception as e:
            summary["leagues"][tournament] = {"status": "fetch-error", "error": str(e), "checked": 0, "mapped": 0}
            continue
        mapped = auto_map_sportmonks_games(games, sport_key=sport_key, path=path)
        summary["leagues"][tournament] = {"status": "ok", "checked": mapped["checked"], "mapped": mapped["mapped"]}
        summary["checked"] += mapped["checked"]
        summary["mapped"] += mapped["mapped"]
        summary["unmatched"].extend(mapped["unmatched"])
    return summary


def grade_prop_cards(path: Optional[Path] = None) -> Dict[str, Any]:

    """Grade stored prop cards from normalized player result rows."""
    init_db(path)
    conn = get_db(path)
    graded = 0
    try:
        cards = conn.execute(
            """
            SELECT id, game_id, team, player_name, market, book_point
            FROM soccer_prop_cards
            WHERE result_hit IS NULL AND decision IN ('pick', 'lean', 'watch', 'pass')
            """
        ).fetchall()
        for c in cards:
            results = conn.execute(
                "SELECT * FROM soccer_player_prop_results WHERE game_id = ?",
                (c["game_id"],),
            ).fetchall()
            match = None
            target = _norm(c["player_name"])
            for r in results:
                if _norm(r["team"] or "") != _norm(c["team"] or ""):
                    continue
                rn = _norm(r["player_name"] or "")
                if target == rn or target in rn or rn in target:
                    match = r
                    break
            if not match:
                continue
            market = c["market"]
            if market == "anytime_scorer":
                value = float(match["goals"] or 0)
                hit = 1 if value >= 1 else 0
            elif market == "shots":
                value = float(match["shots"] or 0)
                line = float(c["book_point"] or 0.5)
                hit = 1 if value > line else 0
            elif market == "shots_on_target":
                value = float(match["shots_on_target"] or 0)
                line = float(c["book_point"] or 0.5)
                hit = 1 if value > line else 0
            else:
                continue
            conn.execute(
                "UPDATE soccer_prop_cards SET result_value=?, result_hit=?, graded_at=?, status='graded', updated_at=? WHERE id=?",
                (value, hit, utc_now(), utc_now(), c["id"]),
            )
            graded += 1
        conn.commit()
    finally:
        conn.close()
    update_meta("job:prop_card_grade:last_run_at", utc_now(), path=path)
    update_meta("job:prop_card_grade:last_graded", str(graded), path=path)
    return {"ok": True, "graded": graded}


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="ACE soccer live state / prop result tools")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sync = sub.add_parser("sync-sportmonks-fixture")
    sync.add_argument("--game-id", required=True)
    sync.add_argument("--fixture-id", required=True)
    mapped = sub.add_parser("sync-mapped-sportmonks")
    mapped.add_argument("--limit", type=int, default=10)
    automap = sub.add_parser("auto-map-upcoming")
    automap.add_argument("--horizon-hours", type=int, default=168)
    map_cmd = sub.add_parser("map-fixture")
    map_cmd.add_argument("--game-id", required=True)
    map_cmd.add_argument("--fixture-id", required=True)
    map_cmd.add_argument("--sport-key", default=None)
    map_cmd.add_argument("--home-team", default=None)
    map_cmd.add_argument("--away-team", default=None)
    map_cmd.add_argument("--commence-time", default=None)
    sub.add_parser("list-mappings")
    sub.add_parser("grade-props")
    args = parser.parse_args()
    if args.cmd == "sync-sportmonks-fixture":
        print(json.dumps(sync_sportmonks_fixture(args.game_id, args.fixture_id), indent=2))
    elif args.cmd == "sync-mapped-sportmonks":
        print(json.dumps(sync_mapped_sportmonks(limit=args.limit), indent=2))
    elif args.cmd == "auto-map-upcoming":
        print(json.dumps(auto_map_upcoming_odds(horizon_hours=args.horizon_hours), indent=2, ensure_ascii=False))
    elif args.cmd == "map-fixture":
        upsert_fixture_mapping({
            "game_id": args.game_id,
            "provider_fixture_id": args.fixture_id,
            "sport_key": args.sport_key,
            "home_team": args.home_team,
            "away_team": args.away_team,
            "commence_time": args.commence_time,
            "provider": "sportmonks",
        })
        print(json.dumps({"ok": True, "game_id": args.game_id, "provider": "sportmonks", "provider_fixture_id": args.fixture_id}, indent=2))
    elif args.cmd == "list-mappings":
        print(json.dumps(fixture_mappings(), indent=2, ensure_ascii=False))
    elif args.cmd == "grade-props":
        print(json.dumps(grade_prop_cards(), indent=2))
