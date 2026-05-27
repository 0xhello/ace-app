#!/usr/bin/env python3
"""live_pipeline.py — one-shot ACE soccer live-pick refresh.

This is the server-side bridge job the Railway worker can run without external
cron:
  Odds upcoming slate -> Sportmonks fixture map -> live player state sync ->
  prop context cards + optional live prop prices.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

from ml.soccer.live_state import auto_map_upcoming_odds, sync_mapped_sportmonks
from ml.soccer.prop_cards import scan as scan_prop_cards, stats as prop_stats
from ml.world_cup.signal_logger import DB_PATH as DEFAULT_DB_PATH, update_meta


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def run(
    db_path: Optional[Path] = None,
    *,
    horizon_hours: int = 168,
    with_market: bool = True,
    max_market_events: int = 4,
    limit_per_team: int = 4,
    sync_limit: int = 12,
) -> Dict[str, Any]:
    path = db_path or DEFAULT_DB_PATH
    started = utc_now()
    update_meta("job:soccer_live_pipeline:last_run_at", started, path=path)
    update_meta("job:soccer_live_pipeline:last_error", "", path=path)
    try:
        mapping = auto_map_upcoming_odds(path=path, horizon_hours=horizon_hours)
        live_state = sync_mapped_sportmonks(path=path, limit=sync_limit)
        props = scan_prop_cards(
            db_path=path,
            horizon_hours=horizon_hours,
            with_market=with_market,
            max_market_events=max_market_events,
            limit_per_team=limit_per_team,
        )
        current_stats = prop_stats(path)
        summary = {
            "ok": True,
            "ran_at": started,
            "horizon_hours": horizon_hours,
            "with_market": with_market,
            "mapping": mapping,
            "live_state": live_state,
            "prop_cards": props,
            "prop_stats": current_stats,
        }
        update_meta("job:soccer_live_pipeline:last_mapped", str(mapping.get("mapped", 0)), path=path)
        update_meta("job:soccer_live_pipeline:last_synced", str(live_state.get("synced", 0)), path=path)
        update_meta("job:soccer_live_pipeline:last_cards", str(props.get("cards", 0)), path=path)
        update_meta("job:soccer_live_pipeline:last_priced", str(props.get("priced_cards", 0)), path=path)
        return summary
    except Exception as e:
        update_meta("job:soccer_live_pipeline:last_error", str(e)[:300], path=path)
        raise


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Run ACE soccer live mapping/state/pricing pipeline once")
    parser.add_argument("--horizon-hours", type=int, default=168)
    parser.add_argument("--no-market", action="store_true", help="Skip per-event prop-price fetches")
    parser.add_argument("--max-market-events", type=int, default=4)
    parser.add_argument("--limit-per-team", type=int, default=4)
    parser.add_argument("--sync-limit", type=int, default=12)
    args = parser.parse_args()
    print(json.dumps(run(
        horizon_hours=args.horizon_hours,
        with_market=not args.no_market,
        max_market_events=args.max_market_events,
        limit_per_team=args.limit_per_team,
        sync_limit=args.sync_limit,
    ), indent=2, ensure_ascii=False))
