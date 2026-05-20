"""
Tests for the shared Odds API Redis read-through helper.

We don't hit a real Redis here — we monkeypatch httpx.get so each test
exercises a different cache state (fresh hit, stale, missing key, empty
payload, malformed JSON, transport error).
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import pytest

import ml.common.odds_cache as oc


class _StubResp:
    def __init__(self, status_code: int, payload: Any) -> None:
        self.status_code = status_code
        self._payload = payload

    def json(self) -> Any:
        return self._payload


def _set_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io")
    monkeypatch.setenv("UPSTASH_REDIS_REST_TOKEN", "test-token")


def _wrap(games: List[Dict[str, Any]], age_ms: int = 0) -> Dict[str, Any]:
    """Build the cache-entry payload the way the Next.js side writes it.
    Negative age = future timestamp (still fresh); positive age = older."""
    fetched_at = datetime.now(timezone.utc).timestamp() * 1000 - age_ms
    return {"data": games, "fetchedAt": fetched_at}


# ---------------------------------------------------------------------------
# No env / no Redis credentials → always None (don't crash, just fall through)
# ---------------------------------------------------------------------------

def test_no_env_returns_none(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("UPSTASH_REDIS_REST_URL", raising=False)
    monkeypatch.delenv("UPSTASH_REDIS_REST_TOKEN", raising=False)
    assert oc.try_get_odds("__raw_odds_wc__") is None


def test_only_url_without_token_returns_none(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io")
    monkeypatch.delenv("UPSTASH_REDIS_REST_TOKEN", raising=False)
    assert oc.try_get_odds("__raw_odds_wc__") is None


# ---------------------------------------------------------------------------
# Happy path — fresh entry returns the games list
# ---------------------------------------------------------------------------

def test_fresh_cache_hit_returns_games(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_env(monkeypatch)
    games = [{"id": "g1", "home_team": "Brazil", "away_team": "Argentina"}]
    entry = _wrap(games, age_ms=30_000)  # 30s old — fresh
    monkeypatch.setattr(oc.httpx, "get", lambda *a, **kw: _StubResp(200, {"result": json.dumps(entry)}))

    out = oc.try_get_odds("__raw_odds_wc__")
    assert out == games


def test_redis_returns_already_parsed_dict(monkeypatch: pytest.MonkeyPatch) -> None:
    """Upstash sometimes returns the value pre-parsed (depending on SDK).
    The helper should accept either string or dict for the 'result' field."""
    _set_env(monkeypatch)
    games = [{"id": "g1"}]
    entry = _wrap(games, age_ms=30_000)
    monkeypatch.setattr(oc.httpx, "get", lambda *a, **kw: _StubResp(200, {"result": entry}))
    assert oc.try_get_odds("__raw_odds_mlb__") == games


# ---------------------------------------------------------------------------
# Stale or empty payloads → None (caller falls back to direct API)
# ---------------------------------------------------------------------------

def test_stale_entry_returns_none(monkeypatch: pytest.MonkeyPatch) -> None:
    """26-minute-old entry exceeds the 25-min staleness threshold."""
    _set_env(monkeypatch)
    entry = _wrap([{"id": "g1"}], age_ms=26 * 60 * 1000)
    monkeypatch.setattr(oc.httpx, "get", lambda *a, **kw: _StubResp(200, {"result": json.dumps(entry)}))
    assert oc.try_get_odds("__raw_odds_wc__") is None


def test_empty_data_list_returns_none(monkeypatch: pytest.MonkeyPatch) -> None:
    """An entry with no games is the same as "no cache" — fall through."""
    _set_env(monkeypatch)
    entry = _wrap([], age_ms=30_000)
    monkeypatch.setattr(oc.httpx, "get", lambda *a, **kw: _StubResp(200, {"result": json.dumps(entry)}))
    assert oc.try_get_odds("__raw_odds_nba__") is None


def test_missing_key_returns_none(monkeypatch: pytest.MonkeyPatch) -> None:
    """Upstash returns {result: null} for an absent key."""
    _set_env(monkeypatch)
    monkeypatch.setattr(oc.httpx, "get", lambda *a, **kw: _StubResp(200, {"result": None}))
    assert oc.try_get_odds("__raw_odds_wc__") is None


# ---------------------------------------------------------------------------
# Transport errors → None (never raise to the caller)
# ---------------------------------------------------------------------------

def test_http_error_status_returns_none(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_env(monkeypatch)
    monkeypatch.setattr(oc.httpx, "get", lambda *a, **kw: _StubResp(500, {}))
    assert oc.try_get_odds("__raw_odds_wc__") is None


def test_exception_swallowed(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_env(monkeypatch)
    def boom(*a, **kw):
        raise RuntimeError("network down")
    monkeypatch.setattr(oc.httpx, "get", boom)
    # Must not raise — caller falls back to direct API
    assert oc.try_get_odds("__raw_odds_wc__") is None


# ---------------------------------------------------------------------------
# Integration: WC/MLB fetchers use the helper before the HTTP call
# ---------------------------------------------------------------------------

def test_wc_fetcher_skips_api_on_cache_hit(monkeypatch: pytest.MonkeyPatch) -> None:
    """fetch_wc_odds must consult try_get_odds first and short-circuit
    on a hit. We assert the API path is never reached."""
    from ml.world_cup import fetch_signals as wc

    games = [{"id": "wc1", "home_team": "France", "away_team": "Mexico"}]
    monkeypatch.setattr("ml.common.odds_cache.try_get_odds", lambda key: games if key == "__raw_odds_wc__" else None)

    def fail_if_called(*a, **kw):
        raise AssertionError("Should not hit Odds API when cache is fresh")
    monkeypatch.setattr(wc.httpx, "get", fail_if_called)

    assert wc.fetch_wc_odds() == games


def test_mlb_fetcher_skips_api_on_cache_hit(monkeypatch: pytest.MonkeyPatch) -> None:
    from ml.mlb import fetch_signals as mlb

    games = [{"id": "mlb1", "home_team": "Yankees", "away_team": "Red Sox"}]
    monkeypatch.setattr("ml.common.odds_cache.try_get_odds", lambda key: games if key == "__raw_odds_mlb__" else None)

    def fail_if_called(*a, **kw):
        raise AssertionError("Should not hit Odds API when cache is fresh")
    monkeypatch.setattr(mlb.httpx, "get", fail_if_called)

    assert mlb.fetch_mlb_odds() == games


def test_wc_fetcher_falls_through_to_api_on_cache_miss(monkeypatch: pytest.MonkeyPatch) -> None:
    """When the cache is empty, the fetcher must hit the API. We stub the
    HTTP response so no real network call happens."""
    from ml.world_cup import fetch_signals as wc

    monkeypatch.setattr("ml.common.odds_cache.try_get_odds", lambda key: None)
    monkeypatch.setenv("ODDS_API_KEY", "stub")  # bypass the key check

    fake_games = [{"id": "wc-from-api"}]
    monkeypatch.setattr(wc.httpx, "get", lambda *a, **kw: _StubResp(200, fake_games))
    # Stub headers on the response — fetcher reads x-requests-remaining
    class _RespWithHeaders(_StubResp):
        def __init__(self, status: int, payload, headers=None):
            super().__init__(status, payload)
            self.headers = headers or {}
        def raise_for_status(self):
            if self.status_code >= 400:
                raise RuntimeError(f"HTTP {self.status_code}")
    monkeypatch.setattr(wc.httpx, "get", lambda *a, **kw: _RespWithHeaders(200, fake_games, {}))

    assert wc.fetch_wc_odds() == fake_games
