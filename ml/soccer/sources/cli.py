#!/usr/bin/env python3
"""CLI for ACE soccer data source bakeoff.

Examples:
    python3 -m ml.soccer.sources.cli scorecard
    python3 -m ml.soccer.sources.cli soccerdata-status
    python3 -m ml.soccer.sources.cli soccerdata-probe
"""
from __future__ import annotations

import argparse
import json

from .base import SOURCE_SCORECARD
from dataclasses import asdict

from .soccerdata_adapter import (
    provider_status,
    probe,
    read_understat_player_season_stats,
    read_understat_team_match_stats,
)


def main() -> None:
    parser = argparse.ArgumentParser(description="ACE soccer data-source bakeoff")
    parser.add_argument("cmd", choices=["scorecard", "soccerdata-status", "soccerdata-probe", "understat-players", "understat-team-matches"])
    parser.add_argument("--league", action="append", help="soccerdata league code/name for probe")
    parser.add_argument("--season", action="append", help="soccerdata season for probe")
    args = parser.parse_args()

    if args.cmd == "scorecard":
        rows = sorted((s.to_dict() for s in SOURCE_SCORECARD), key=lambda r: r["total"], reverse=True)
        print(json.dumps(rows, indent=2))
    elif args.cmd == "soccerdata-status":
        print(json.dumps(provider_status(), indent=2))
    elif args.cmd == "soccerdata-probe":
        print(json.dumps(probe(args.league, args.season).to_dict(), indent=2, default=str))
    elif args.cmd == "understat-players":
        rows = [asdict(r) for r in read_understat_player_season_stats(args.league, args.season, limit=10)]
        print(json.dumps(rows, indent=2, default=str))
    elif args.cmd == "understat-team-matches":
        rows = [asdict(r) for r in read_understat_team_match_stats(args.league, args.season, limit=10)]
        print(json.dumps(rows, indent=2, default=str))


if __name__ == "__main__":
    main()
