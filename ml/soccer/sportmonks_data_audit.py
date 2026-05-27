#!/usr/bin/env python3
"""Audit the Sportmonks data ACE has collected/normalized.

This is local and quota-safe by default: it reads ACE's SQLite tables and the
saved Sportmonks inventory artifact. It does not call Sportmonks unless future
flags are added deliberately.
"""
from __future__ import annotations

import json
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from ml.soccer.live_state import get_db, init_db
from ml.soccer.prop_cards import init_db as init_prop_cards_db
from ml.world_cup.signal_logger import DB_PATH as DEFAULT_DB_PATH

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
ARTIFACT = _REPO_ROOT / "ml" / "soccer" / "artifacts" / "sportmonks_inventory.json"
REPORT = _REPO_ROOT / "ml" / "soccer" / "artifacts" / "sportmonks_data_audit.json"

SPORTMONKS_TABLES = [
    "soccer_fixture_provider_map",
    "soccer_fixture_feature_snapshot",
    "soccer_player_feature_snapshot",
    "soccer_live_player_state",
]
MODEL_TABLES = [
    "soccer_prop_cards",
    "soccer_player_prop_results",
]


def _count(conn, table: str) -> int:
    try:
        return int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
    except Exception:
        return 0


def _load_inventory() -> Dict[str, Any]:
    if not ARTIFACT.exists():
        return {"exists": False}
    try:
        raw = json.loads(ARTIFACT.read_text())
    except Exception as e:
        return {"exists": True, "error": str(e)}
    probes = raw.get("probes") or {}
    return {
        "exists": True,
        "path": str(ARTIFACT),
        "bytes": ARTIFACT.stat().st_size,
        "date_window": raw.get("date_window"),
        "mapped_fixture_id_used": raw.get("mapped_fixture_id_used"),
        "probes": {
            name: {
                "ok": p.get("ok"),
                "status_code": p.get("status_code"),
                "has_data": p.get("has_data"),
                "data_count": p.get("data_count"),
                "subscription_present": p.get("subscription_present"),
                "sample_keys": p.get("sample_keys") or [],
                "message": p.get("message"),
            }
            for name, p in probes.items()
        },
    }


def _coverage(conn) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    out["tables"] = {t: _count(conn, t) for t in SPORTMONKS_TABLES + MODEL_TABLES}

    out["fixture_features"] = [dict(r) for r in conn.execute(
        """
        SELECT game_id, provider_fixture_id, state_name, home_team, away_team,
               league_id, season_id, has_odds, has_premium_odds,
               lineup_count, starters_count, bench_count, sidelined_count,
               event_count, statistic_count, updated_at
        FROM soccer_fixture_feature_snapshot
        ORDER BY updated_at DESC
        """
    ).fetchall()]

    rows = [dict(r) for r in conn.execute(
        """
        SELECT team, opponent, player_name, lineup_status, availability, position,
               position_bucket, formation_field, formation_line, attack_role_score,
               projected_minutes, is_attacking_role, unavailable_reason,
               minutes, goals, assists, shots, shots_on_target, yellow_cards, red_cards
        FROM soccer_player_feature_snapshot
        ORDER BY team, player_name
        """
    ).fetchall()]
    out["player_feature_rows"] = len(rows)
    out["by_lineup_status"] = dict(Counter(r.get("lineup_status") or "unknown" for r in rows))
    out["by_position_bucket"] = dict(Counter(r.get("position_bucket") or "unknown" for r in rows))
    out["teams"] = sorted({r.get("team") for r in rows if r.get("team")})
    out["players_with_attack_role"] = sum(1 for r in rows if r.get("attack_role_score") is not None)
    out["players_with_formation"] = sum(1 for r in rows if r.get("formation_field"))
    out["players_with_result_stats"] = sum(
        1 for r in rows
        if any(r.get(k) is not None for k in ("minutes", "goals", "assists", "shots", "shots_on_target", "yellow_cards", "red_cards"))
    )
    out["top_attack_roles"] = sorted(
        [r for r in rows if r.get("attack_role_score") is not None],
        key=lambda r: (float(r.get("attack_role_score") or 0), r.get("projected_minutes") or 0),
        reverse=True,
    )[:15]
    out["unavailable_players"] = [r for r in rows if (r.get("availability") or "") != "available" or r.get("lineup_status") == "out"]

    # How much of the generated prop-card layer is actually using Sportmonks features?
    cards = [dict(r) for r in conn.execute(
        """
        SELECT player_name, team, opponent, market, decision, confidence_tier,
               model_prob, model_mean, book, book_odds, edge_pp,
               blocker_reasons, bettor_notes, context_json, updated_at
        FROM soccer_prop_cards
        ORDER BY updated_at DESC
        LIMIT 500
        """
    ).fetchall()]
    sportmonks_cards: List[Dict[str, Any]] = []
    adjusted_cards: List[Dict[str, Any]] = []
    by_decision = Counter()
    by_market = Counter()
    for c in cards:
        by_decision[c.get("decision") or "unknown"] += 1
        by_market[c.get("market") or "unknown"] += 1
        try:
            ctx = json.loads(c.get("context_json") or "{}")
        except Exception:
            ctx = {}
        role = ctx.get("role_today") or {}
        if role.get("source") == "sportmonks" or ctx.get("model_adjustment", {}).get("source") == "sportmonks":
            c2 = dict(c)
            c2.pop("context_json", None)
            c2["role_today"] = role
            c2["model_adjustment"] = ctx.get("model_adjustment")
            sportmonks_cards.append(c2)
        if ctx.get("model_adjustment"):
            c2 = dict(c)
            c2.pop("context_json", None)
            c2["model_adjustment"] = ctx.get("model_adjustment")
            adjusted_cards.append(c2)
    out["prop_cards_recent"] = len(cards)
    out["prop_cards_by_decision_recent"] = dict(by_decision)
    out["prop_cards_by_market_recent"] = dict(by_market)
    out["prop_cards_using_sportmonks_recent"] = len(sportmonks_cards)
    out["prop_cards_with_model_adjustment_recent"] = len(adjusted_cards)
    out["sportmonks_card_examples"] = sportmonks_cards[:12]

    # Feature readiness by category for modeling.
    out["model_feature_readiness"] = {
        "fixture_identity": bool(out["fixture_features"]),
        "fixture_state": any(f.get("state_name") for f in out["fixture_features"]),
        "lineups": out["player_feature_rows"] > 0,
        "formations": out["players_with_formation"] > 0,
        "availability": bool(out["by_lineup_status"]),
        "attack_role_score": out["players_with_attack_role"] > 0,
        "result_player_stats": out["players_with_result_stats"] > 0,
        "fixture_events": any((f.get("event_count") or 0) > 0 for f in out["fixture_features"]),
        "fixture_statistics": any((f.get("statistic_count") or 0) > 0 for f in out["fixture_features"]),
        "explicit_sportmonks_xg": False,
    }
    return out


def run(db_path: Optional[Path] = None, write_report: bool = True) -> Dict[str, Any]:
    db = db_path or DEFAULT_DB_PATH
    init_db(db)
    init_prop_cards_db(db)
    conn = get_db(db)
    try:
        report = {
            "ok": True,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "db_path": str(db),
            "inventory_artifact": _load_inventory(),
            "coverage": _coverage(conn),
            "notes": [
                "This audit is local/quota-safe; it reads normalized ACE tables and saved inventory artifacts.",
                "Sportmonks explicit xG was not observed in the current saved inventory/sample; ACE currently uses Understat xG plus Sportmonks live role/lineup features.",
            ],
        }
    finally:
        conn.close()
    if write_report:
        REPORT.parent.mkdir(parents=True, exist_ok=True)
        REPORT.write_text(json.dumps(report, indent=2, ensure_ascii=False))
        report["report_path"] = str(REPORT)
    return report


if __name__ == "__main__":
    r = run()
    c = r["coverage"]
    compact = {
        "ok": r["ok"],
        "report_path": r.get("report_path"),
        "tables": c["tables"],
        "fixtures": len(c["fixture_features"]),
        "player_feature_rows": c["player_feature_rows"],
        "teams": c["teams"],
        "by_lineup_status": c["by_lineup_status"],
        "by_position_bucket": c["by_position_bucket"],
        "prop_cards_using_sportmonks_recent": c["prop_cards_using_sportmonks_recent"],
        "prop_cards_with_model_adjustment_recent": c["prop_cards_with_model_adjustment_recent"],
        "model_feature_readiness": c["model_feature_readiness"],
        "top_attack_roles": [
            {k: x.get(k) for k in ("team", "player_name", "lineup_status", "position_bucket", "formation_field", "attack_role_score", "projected_minutes")}
            for x in c["top_attack_roles"][:8]
        ],
    }
    print(json.dumps(compact, indent=2, ensure_ascii=False))
