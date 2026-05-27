"""Proof-of-concept adapter for the `soccerdata` Python package.

The dependency is intentionally optional. In environments where it is missing,
`probe()` returns a clean not-installed result instead of crashing builds.

Install for local POC:
    python3 -m pip install soccerdata
"""
from __future__ import annotations

import importlib
from typing import Any, Dict, List, Optional

from .base import PlayerSeasonStats, ProviderProbeResult, TeamMatchStats


def _load_soccerdata():
    return importlib.import_module("soccerdata")


def is_installed() -> bool:
    try:
        _load_soccerdata()
        return True
    except Exception:
        return False


def provider_status() -> Dict[str, Any]:
    try:
        sd = _load_soccerdata()
        providers = [
            name for name in [
                "ClubElo", "ESPN", "FBref", "FotMob", "Sofascore",
                "SoFIFA", "Understat", "WhoScored",
            ] if hasattr(sd, name)
        ]
        methods = {}
        for name in providers:
            cls = getattr(sd, name, None)
            methods[name] = sorted(m for m in dir(cls) if m.startswith("read_")) if cls else []
        return {
            "installed": True,
            "version": getattr(sd, "__version__", None),
            "providers": providers,
            "methods": methods,
        }
    except Exception as e:
        return {
            "installed": False,
            "install": "python3 -m pip install soccerdata",
            "error": str(e),
        }


def _safe_len(obj: Any) -> int:
    try:
        return len(obj)
    except Exception:
        return 0


def _sample_df(df: Any, n: int = 2) -> List[Dict[str, Any]]:
    try:
        return df.head(n).reset_index().to_dict(orient="records")
    except Exception:
        return []


def read_understat_player_season_stats(
    leagues: Optional[List[str]] = None,
    seasons: Optional[List[str]] = None,
    limit: int = 25,
) -> List[PlayerSeasonStats]:
    """Read and normalize Understat player season stats via soccerdata."""
    sd = _load_soccerdata()
    selected_leagues = leagues or ["ENG-Premier League"]
    selected_seasons = seasons or ["2024/2025"]
    reader = sd.Understat(leagues=selected_leagues, seasons=selected_seasons)
    df = reader.read_player_season_stats().reset_index()
    rows: List[PlayerSeasonStats] = []
    for raw in df.head(limit).to_dict(orient="records"):
        rows.append(PlayerSeasonStats(
            provider="soccerdata:understat",
            league=str(raw.get("league") or ""),
            season=str(raw.get("season") or ""),
            player_name=str(raw.get("player") or raw.get("player_name") or ""),
            team=raw.get("team"),
            position=raw.get("position"),
            minutes=raw.get("minutes"),
            goals=raw.get("goals"),
            assists=raw.get("assists"),
            shots=raw.get("shots"),
            xg=raw.get("xg"),
            xa=raw.get("xa"),
            appearances=raw.get("matches"),
            raw=raw,
        ))
    return rows


def read_understat_team_match_stats(
    leagues: Optional[List[str]] = None,
    seasons: Optional[List[str]] = None,
    limit: int = 25,
) -> List[TeamMatchStats]:
    """Read and normalize Understat match-level team xG rows."""
    sd = _load_soccerdata()
    selected_leagues = leagues or ["ENG-Premier League"]
    selected_seasons = seasons or ["2024/2025"]
    reader = sd.Understat(leagues=selected_leagues, seasons=selected_seasons)
    df = reader.read_team_match_stats().reset_index()
    rows: List[TeamMatchStats] = []
    for raw in df.head(limit).to_dict(orient="records"):
        rows.append(TeamMatchStats(
            provider="soccerdata:understat",
            league=str(raw.get("league") or ""),
            season=str(raw.get("season") or ""),
            team=str(raw.get("home_team") or ""),
            opponent=raw.get("away_team"),
            match_date=str(raw.get("date")) if raw.get("date") is not None else None,
            venue="home",
            goals_for=raw.get("home_goals"),
            goals_against=raw.get("away_goals"),
            xg_for=raw.get("home_xg"),
            xg_against=raw.get("away_xg"),
            raw=raw,
        ))
    return rows


def probe(leagues: Optional[List[str]] = None, seasons: Optional[List[str]] = None) -> ProviderProbeResult:
    """Lightweight smoke probe.

    We avoid hard-coding a fragile full scrape. The probe verifies the package,
    available provider classes, and attempts a small Understat league schedule
    read if possible because Understat is useful for xG/player stats.
    """
    try:
        sd = _load_soccerdata()
    except Exception as e:
        return ProviderProbeResult(
            provider="soccerdata",
            ok=False,
            installed=False,
            message="soccerdata is not installed; adapter skeleton is ready.",
            error=str(e),
        )

    counts: Dict[str, int] = {}
    sample: Dict[str, Any] = {
        "version": getattr(sd, "__version__", None),
        "providers": provider_status().get("providers", []),
    }

    # Try one tiny call if the current soccerdata API supports it. This is best
    # effort because provider constructor signatures have changed across
    # versions and sites can throttle/break scrapers.
    try:
        if hasattr(sd, "Understat"):
            selected_leagues = leagues or ["ENG-Premier League"]
            selected_seasons = seasons or ["2024/2025"]
            understat = sd.Understat(leagues=selected_leagues, seasons=selected_seasons)
            if hasattr(understat, "read_schedule"):
                schedule = understat.read_schedule()
                counts["understat_schedule_rows"] = _safe_len(schedule)
                sample["understat_schedule"] = _sample_df(schedule)
            if hasattr(understat, "read_player_season_stats"):
                players = understat.read_player_season_stats()
                counts["understat_player_season_rows"] = _safe_len(players)
                sample["understat_player_season"] = _sample_df(players)
            if hasattr(understat, "read_team_match_stats"):
                team_matches = understat.read_team_match_stats()
                counts["understat_team_match_rows"] = _safe_len(team_matches)
                sample["understat_team_match"] = _sample_df(team_matches)
    except Exception as e:
        sample["understat_probe_error"] = str(e)

    return ProviderProbeResult(
        provider="soccerdata",
        ok=True,
        installed=True,
        message="soccerdata package is importable; see counts/sample for probe details.",
        counts=counts,
        sample=sample,
    )
