"""
Tests for the daily market-probe + auto-flip pipeline.

We don't hit the real Odds API — we monkeypatch httpx.get so each test
exercises a specific shape of response (empty / only btts / player markets
just opened / API outage). The point is to verify the auto-flip behavior:
when market_probe sees player_goal_scorer_anytime on > 0 games, the
meta key wc:player_props_first_seen_at gets stamped, and
fetch_signals._player_props_enabled() then returns True.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

import pytest


@pytest.fixture
def db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    p = tmp_path / "wc_signal_log.db"
    from ml.world_cup import signal_logger, market_probe
    monkeypatch.setattr(signal_logger, "DB_PATH", p)
    monkeypatch.setattr(market_probe,  "DB_PATH", p)
    monkeypatch.setenv("ODDS_API_KEY", "stub-key")
    return p


class _StubResp:
    def __init__(self, status_code: int, json_payload: Any, headers: Dict[str, str] | None = None) -> None:
        self.status_code = status_code
        self._json = json_payload
        self.headers = headers or {}
    def json(self) -> Any: return self._json
    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


def _game_with(markets: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Build an Odds API event with one bookmaker carrying the given markets."""
    return {
        "id": "g1",
        "home_team": "France", "away_team": "Argentina",
        "commence_time": "2026-06-15T19:00:00Z",
        "bookmakers": [{
            "key": "fanduel", "title": "FanDuel",
            "markets": markets,
        }],
    }


# ─── Pre-tournament: 422 / no games ──────────────────────────────────────────

def test_probe_handles_422_off_season(db: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Odds API returns 422 when a sport isn't live yet. Probe should
    log the result with 0 games and not crash."""
    from ml.world_cup import market_probe as mp
    monkeypatch.setattr(mp.httpx, "get",
        lambda *a, **kw: _StubResp(422, None, {"x-requests-remaining": "98000"}))
    payload = mp.run_probe(path=db)
    assert payload["ok"] is True
    assert payload["total_games"] == 0
    # No markets flip — wc:player_props_first_seen_at should NOT be stamped
    assert not mp.is_player_props_live(db)


def test_probe_handles_only_btts_live(db: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Pre-WC state: btts available, player props not posted yet."""
    from ml.world_cup import market_probe as mp
    game = _game_with([{"key": "btts", "outcomes": [
        {"name": "Yes", "price": -110}, {"name": "No", "price": -110},
    ]}])
    monkeypatch.setattr(mp.httpx, "get",
        lambda *a, **kw: _StubResp(200, [game], {"x-requests-last": "10", "x-requests-remaining": "98000"}))
    payload = mp.run_probe(path=db)
    btts = next(m for m in payload["markets"] if m["market"] == "btts")
    psm  = next(m for m in payload["markets"] if m["market"] == "player_goal_scorer_anytime")
    assert btts["games_with_market"] == 1
    assert psm["games_with_market"] == 0
    # Player-prop flag must STILL be off
    assert not mp.is_player_props_live(db)


# ─── The big moment: player markets go live ──────────────────────────────────

def test_probe_flips_player_props_meta_when_market_appears(
    db: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When player_goal_scorer_anytime has > 0 games, the meta key
    wc:player_props_first_seen_at gets stamped and is_player_props_live
    returns True for all subsequent calls."""
    from ml.world_cup import market_probe as mp
    game = _game_with([
        {"key": "player_goal_scorer_anytime", "outcomes": [
            {"name": "Yes", "description": "Kylian Mbappe", "price": 150},
            {"name": "Yes", "description": "Lionel Messi",  "price": 220},
        ]},
    ])
    monkeypatch.setattr(mp.httpx, "get",
        lambda *a, **kw: _StubResp(200, [game], {"x-requests-last": "10", "x-requests-remaining": "97990"}))

    # Pre-probe: not live
    assert not mp.is_player_props_live(db)

    payload = mp.run_probe(path=db)

    # Post-probe: meta flipped
    assert mp.is_player_props_live(db)
    psm = next(m for m in payload["markets"] if m["market"] == "player_goal_scorer_anytime")
    assert psm["games_with_market"] == 1


def test_probe_flip_is_idempotent(db: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A second probe with the same player markets shouldn't overwrite the
    first-seen-at timestamp — we want the *first* detection time persisted.
    """
    from ml.world_cup import market_probe as mp
    from ml.world_cup.signal_logger import get_db

    game = _game_with([{"key": "player_goal_scorer_anytime", "outcomes": [
        {"name": "Yes", "description": "Kylian Mbappe", "price": 150},
    ]}])
    monkeypatch.setattr(mp.httpx, "get",
        lambda *a, **kw: _StubResp(200, [game], {"x-requests-remaining": "97000"}))

    mp.run_probe(path=db)
    conn = get_db(db)
    first = conn.execute("SELECT value FROM meta WHERE key = 'wc:player_props_first_seen_at'").fetchone()[0]
    conn.close()

    mp.run_probe(path=db)  # second probe
    conn = get_db(db)
    second = conn.execute("SELECT value FROM meta WHERE key = 'wc:player_props_first_seen_at'").fetchone()[0]
    conn.close()

    assert first == second  # unchanged — we don't unstamp / re-stamp


# ─── fetch_signals integration ───────────────────────────────────────────────

def test_fetch_signals_auto_enables_when_flag_set(db: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """fetch_signals._player_props_enabled() should return True after the
    meta flag is stamped, even with no env var set."""
    monkeypatch.delenv("WC_PLAYER_PROPS_ENABLED", raising=False)
    from ml.world_cup import market_probe as mp
    from ml.world_cup import fetch_signals as fs

    # Before: false
    assert fs._player_props_enabled() is False

    # Simulate a probe-flip
    from ml.world_cup.signal_logger import update_meta
    update_meta("wc:player_props_first_seen_at",
                "2026-06-01T00:00:00+00:00", db)

    # After: true (auto-flip)
    assert fs._player_props_enabled() is True


def test_env_override_off_kills_player_props(db: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """WC_PLAYER_PROPS_ENABLED=0 is the kill-switch — wins even if the
    meta flag says live."""
    from ml.world_cup.signal_logger import update_meta
    update_meta("wc:player_props_first_seen_at",
                "2026-06-01T00:00:00+00:00", db)

    monkeypatch.setenv("WC_PLAYER_PROPS_ENABLED", "0")
    from ml.world_cup import fetch_signals as fs
    assert fs._player_props_enabled() is False


def test_env_override_on_works_without_meta(db: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """WC_PLAYER_PROPS_ENABLED=1 forces on even without probe-flip — useful
    for manual testing or local dev."""
    monkeypatch.setenv("WC_PLAYER_PROPS_ENABLED", "1")
    from ml.world_cup import fetch_signals as fs
    assert fs._player_props_enabled() is True


# ─── Network resilience ──────────────────────────────────────────────────────

def test_probe_returns_degraded_payload_on_transport_error(
    db: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A network exception should NOT propagate to the daily worker tick.
    Probe returns ok=False with the error captured."""
    from ml.world_cup import market_probe as mp
    def boom(*a, **kw): raise ConnectionError("network down")
    monkeypatch.setattr(mp.httpx, "get", boom)

    payload = mp.run_probe(path=db)
    assert payload["ok"] is False
    assert "network" in (payload.get("error") or "").lower()
    # No meta flip on error
    assert not mp.is_player_props_live(db)
