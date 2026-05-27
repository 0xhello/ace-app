#!/usr/bin/env python3
"""sportmonks_inventory.py — lightweight trial-access inventory for ACE.

Goal: don't model blindly. Probe a small, bounded set of Sportmonks endpoints
and includes, then save what this token/subscription can actually return.
"""
from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
from dotenv import load_dotenv

from ml.soccer.live_state import fixture_mappings, _sportmonks_token
from ml.world_cup.signal_logger import DB_PATH as DEFAULT_DB_PATH, update_meta

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
load_dotenv(_REPO_ROOT / ".env.local")
ARTIFACT = _REPO_ROOT / "ml" / "soccer" / "artifacts" / "sportmonks_inventory.json"
BASE = "https://api.sportmonks.com/v3/football"


def _redact(text: str, token: str) -> str:
    return text.replace(token, "[REDACTED]") if token else text


def _get(path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    token = _sportmonks_token()
    if not token:
        raise EnvironmentError("SPORTMONKS_API_TOKEN not set")
    merged = {"api_token": token, **(params or {})}
    r = httpx.get(f"{BASE}{path}", params=merged, timeout=20)
    body_text = _redact(r.text[:1200], token)
    out: Dict[str, Any] = {"status_code": r.status_code, "ok": r.status_code == 200}
    try:
        body = r.json()
    except Exception:
        body = {"raw": body_text}
    out["has_data"] = bool(body.get("data")) if isinstance(body, dict) else False
    if isinstance(body, dict):
        data = body.get("data")
        out["data_count"] = len(data) if isinstance(data, list) else (1 if data else 0)
        out["message"] = body.get("message")
        out["subscription_present"] = bool(body.get("subscription"))
        if isinstance(data, list) and data:
            out["sample_keys"] = sorted(list(data[0].keys()))[:40] if isinstance(data[0], dict) else []
        elif isinstance(data, dict):
            out["sample_keys"] = sorted(list(data.keys()))[:40]
    out["sample_body"] = body_text[:500]
    return out


def run(db_path: Optional[Path] = None) -> Dict[str, Any]:
    db = db_path or DEFAULT_DB_PATH
    today = date.today()
    start = today.isoformat()
    end = (today + timedelta(days=14)).isoformat()
    mappings = fixture_mappings(db)
    fixture_id = mappings[0]["provider_fixture_id"] if mappings else None

    probes: Dict[str, Any] = {}
    probes["leagues"] = _get("/leagues", {"per_page": 5})
    probes["fixtures_next_14d"] = _get(f"/fixtures/between/{start}/{end}", {"include": "participants;league", "per_page": 5})
    probes["teams_search_arsenal"] = _get("/teams/search/Arsenal", {"per_page": 5})
    probes["players_search_mbappe"] = _get("/players/search/Mbappe", {"per_page": 5})
    if fixture_id:
        probes["mapped_fixture_basic"] = _get(f"/fixtures/{fixture_id}", {"include": "participants;league;venue;state", "per_page": 1})
        probes["mapped_fixture_lineups"] = _get(f"/fixtures/{fixture_id}", {"include": "lineups.player;lineups.position;sidelined.sideline;sidelined.player", "per_page": 1})
        probes["mapped_fixture_events_stats"] = _get(f"/fixtures/{fixture_id}", {"include": "events;statistics;periods;scores", "per_page": 1})
        probes["mapped_fixture_player_stats"] = _get(f"/fixtures/{fixture_id}", {"include": "lineups.details.type;lineups.player", "per_page": 1})
    summary = {
        "ok": True,
        "date_window": {"start": start, "end": end},
        "mapped_fixture_id_used": fixture_id,
        "probes": probes,
    }
    ARTIFACT.parent.mkdir(parents=True, exist_ok=True)
    ARTIFACT.write_text(json.dumps(summary, indent=2, ensure_ascii=False))
    update_meta("job:sportmonks_inventory:last_run_at", date.today().isoformat(), path=db)
    update_meta("job:sportmonks_inventory:last_error", "", path=db)
    return summary


if __name__ == "__main__":
    try:
        result = run()
        compact = {
            "ok": result["ok"],
            "artifact": str(ARTIFACT),
            "mapped_fixture_id_used": result.get("mapped_fixture_id_used"),
            "available": {k: {"ok": v.get("ok"), "has_data": v.get("has_data"), "data_count": v.get("data_count"), "message": v.get("message")} for k, v in result["probes"].items()},
        }
        print(json.dumps(compact, indent=2, ensure_ascii=False))
    except Exception as e:
        update_meta("job:sportmonks_inventory:last_error", str(e)[:300])
        raise
