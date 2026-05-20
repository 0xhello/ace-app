"""
odds_cache.py — shared Redis read-through for Odds API responses.

The Next.js web frontend already fetches odds from The Odds API on every
dashboard hit and writes raw responses to Upstash Redis (one key per sport,
e.g. __raw_odds_nba__, __raw_odds_wc__, __raw_odds_mlb__). Python workers
that poll the same sports can read those Redis entries first and skip the
API call when the cache is still fresh — paying zero credits for data the
frontend just paid for.

Previously only the NBA worker did this. Extending to WC and MLB saves an
estimated 150-400 credits/day depending on dashboard load.

Returns the cached odds list when fresh, None otherwise (caller falls back
to a direct API call). Stale or unreachable Redis is treated as "no cache"
— the worker continues with its own API call.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import httpx

# Stale threshold — if the Redis entry is older than this, ignore it and
# let the caller hit the API for fresh data. 25 minutes lines up with the
# longest TTL in src/lib/server-cache.ts (TTL_DEFAULT = 20 min) plus a 5-min
# grace window for clock skew between Vercel and Railway.
_STALE_AFTER_MS = 25 * 60 * 1000


def try_get_odds(cache_key: str) -> Optional[List[Dict[str, Any]]]:
    """Read raw odds from Upstash Redis under `cache_key` (e.g. '__raw_odds_wc__').

    Returns the parsed games list when the entry exists, is non-empty, and
    is within the stale window. Returns None on any failure — Redis down,
    auth missing, key absent, entry stale, malformed payload.
    """
    rest_url = os.getenv("UPSTASH_REDIS_REST_URL", "").rstrip("/")
    token = os.getenv("UPSTASH_REDIS_REST_TOKEN", "")
    if not rest_url or not token:
        return None
    try:
        resp = httpx.get(
            f"{rest_url}/get/{cache_key}",
            headers={"Authorization": f"Bearer {token}"},
            timeout=4,
        )
        if resp.status_code != 200:
            return None
        result = resp.json().get("result")
        if result is None:
            return None
        entry = json.loads(result) if isinstance(result, str) else result
        age_ms = datetime.now(timezone.utc).timestamp() * 1000 - (entry.get("fetchedAt") or 0)
        if age_ms > _STALE_AFTER_MS:
            return None
        data: List[Dict[str, Any]] = entry.get("data") or []
        if not data:
            return None
        sport_tag = cache_key.replace("__raw_odds_", "").replace("__", "").upper() or "ODDS"
        print(f"  [cache] Redis hit ({sport_tag}): {len(data)} games, age {age_ms/1000:.0f}s — skipping API call")
        return data
    except Exception as e:
        print(f"  [cache] Redis miss ({e})", file=sys.stderr)
        return None
