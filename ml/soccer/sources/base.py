"""Normalized provider schemas for ACE soccer data sources.

These dataclasses are deliberately provider-neutral. Scraper/API-specific fields
belong in `raw`, while the model consumes normalized values.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, Dict, List, Optional


@dataclass
class ProviderCapability:
    name: str
    coverage: int
    freshness: int
    reliability: int
    commercial_safety: int
    cost_fit: int
    integration_difficulty: int
    notes: str

    @property
    def total(self) -> int:
        return (
            self.coverage
            + self.freshness
            + self.reliability
            + self.commercial_safety
            + self.cost_fit
            + self.integration_difficulty
        )

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["total"] = self.total
        return d


@dataclass
class ProviderProbeResult:
    provider: str
    ok: bool
    installed: bool = True
    message: str = ""
    counts: Dict[str, int] = field(default_factory=dict)
    sample: Dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class TeamMatchStats:
    provider: str
    league: str
    season: str
    team: str
    opponent: Optional[str] = None
    match_date: Optional[str] = None
    venue: Optional[str] = None
    goals_for: Optional[float] = None
    goals_against: Optional[float] = None
    xg_for: Optional[float] = None
    xg_against: Optional[float] = None
    shots_for: Optional[float] = None
    shots_against: Optional[float] = None
    sot_for: Optional[float] = None
    sot_against: Optional[float] = None
    corners_for: Optional[float] = None
    corners_against: Optional[float] = None
    raw: Dict[str, Any] = field(default_factory=dict)


@dataclass
class PlayerSeasonStats:
    provider: str
    league: str
    season: str
    player_name: str
    team: Optional[str] = None
    position: Optional[str] = None
    minutes: Optional[float] = None
    goals: Optional[float] = None
    assists: Optional[float] = None
    shots: Optional[float] = None
    shots_on_target: Optional[float] = None
    xg: Optional[float] = None
    xa: Optional[float] = None
    starts: Optional[int] = None
    appearances: Optional[int] = None
    raw: Dict[str, Any] = field(default_factory=dict)


@dataclass
class AvailabilityReport:
    provider: str
    player_name: str
    team: str
    status: str
    reason: Optional[str] = None
    expected_return: Optional[str] = None
    raw: Dict[str, Any] = field(default_factory=dict)


@dataclass
class LineupProjection:
    provider: str
    match_id: str
    team: str
    player_name: str
    expected_start: Optional[bool] = None
    confirmed_start: Optional[bool] = None
    position: Optional[str] = None
    confidence: Optional[float] = None
    raw: Dict[str, Any] = field(default_factory=dict)


SOURCE_SCORECARD: List[ProviderCapability] = [
    ProviderCapability(
        name="Sportmonks",
        coverage=4,
        freshness=4,
        reliability=4,
        commercial_safety=5,
        cost_fit=4,
        integration_difficulty=3,
        notes="Best first paid trial: lineups/player stats/injuries; expected lineups add-on.",
    ),
    ProviderCapability(
        name="soccerdata",
        coverage=4,
        freshness=2,
        reliability=2,
        commercial_safety=2,
        cost_fit=5,
        integration_difficulty=3,
        notes="Best free/internal POC; scraper/ToS risk for production.",
    ),
    ProviderCapability(
        name="SportsDataIO",
        coverage=5,
        freshness=5,
        reliability=5,
        commercial_safety=5,
        cost_fit=2,
        integration_difficulty=3,
        notes="Best all-in-one production candidate if budget works.",
    ),
    ProviderCapability(
        name="StatsBomb Open Data",
        coverage=2,
        freshness=1,
        reliability=5,
        commercial_safety=4,
        cost_fit=5,
        integration_difficulty=3,
        notes="Great training/event data; not a live daily source.",
    ),
    ProviderCapability(
        name="API-Football",
        coverage=3,
        freshness=3,
        reliability=2,
        commercial_safety=4,
        cost_fit=2,
        integration_difficulty=3,
        notes="100 daily credits and current account/season restrictions; sparse fallback only.",
    ),
]
