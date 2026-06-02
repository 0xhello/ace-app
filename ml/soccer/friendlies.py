#!/usr/bin/env python3
"""friendlies.py — international-friendly candidates from Sportmonks (F1).

Why this exists
===============
The June international window is full of WC-team warmup friendlies
(Croatia v Belgium, Netherlands v Algeria, …). Our US-only Odds API
doesn't carry them, but Sportmonks does — 21 books, 146 markets, model
predictions, lineups. These games are the perfect LIVE dress rehearsal
for the World Cup: real WC teams, real games, this week.

Honest scope (read this before trusting a number)
--------------------------------------------------
Our Dixon-Coles model is club-trained — it has NO opinion on national
teams. So friendly candidates are built from **Sportmonks' model
predictions vs the market**, NOT from ACE's validated model. Every
candidate is therefore tagged:
    tier  = "experimental"
    model = "sportmonks"          (never "ace_dc")
    note  = friendlies are low-signal (experimental lineups, low intensity)

These exist to exercise the end-to-end pipeline (surface → approve →
grade) on live games before the WC, and to give honest market reads —
NOT to be shown as ACE-validated picks.

Markets covered: 1X2, Totals 2.5, BTTS (the ones Sportmonks predicts AND
we can grade from the final score).
"""
from __future__ import annotations

import os
import statistics as _stats
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx
from dotenv import load_dotenv

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
load_dotenv(_REPO_ROOT / ".env.local")

SPORTMONKS_BASE = "https://api.sportmonks.com/v3/football"
FRIENDLY_LEAGUE_ID = 1082  # Sportmonks "Friendly International"

# Sportmonks market_ids we grade (mirror sportmonks_historical.TARGET_MARKETS)
_MKT_FULLTIME = 1     # Home/Draw/Away
_MKT_TOTALS   = 80    # Over/Under @ line
_MKT_BTTS     = 14    # Yes/No

# Sportmonks prediction type names → our market key
_PRED_1X2   = "Fulltime Result Probability"
_PRED_OU25  = "Over/Under 2.5 Probability"
_PRED_BTTS  = "Both Teams To Score Probability"

# Only surface a candidate when the model edge clears this (pp). Friendlies
# are noisy; keep the bar a touch higher than club play.
_MIN_EDGE_PP = 6.0
# Edges above this are almost always a data artifact (stale/outlier book
# price or a miscalibrated model on an obscure mismatch), NOT real value —
# same discipline as the ">15pp vs Pinnacle = suspect" rule. Drop them.
_MAX_EDGE_PP = 15.0
# A market needs at least this many books quoting it to be trustworthy
# (liquidity / not a lone outlier price). Thin obscure-nation markets fail.
_MIN_BOOKS = 6


# ── HTTP ───────────────────────────────────────────────────────────────────

def _token() -> str:
    t = os.getenv("SPORTMONKS_API_TOKEN") or os.getenv("SPORTMONKS_TOKEN") or ""
    if not t:
        raise EnvironmentError("SPORTMONKS_API_TOKEN not set")
    return t


def _get(path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    merged = {"api_token": _token(), **(params or {})}
    r = httpx.get(f"{SPORTMONKS_BASE}{path}", params=merged, timeout=30)
    r.raise_for_status()
    return r.json()


def _amer_to_implied(american: float) -> float:
    a = float(american)
    return 100.0 / (a + 100.0) if a >= 0 else (-a) / ((-a) + 100.0)


def _decimal_to_american(dec: float) -> float:
    d = float(dec)
    if d <= 1.0:
        return 0.0
    return round((d - 1.0) * 100.0) if d >= 2.0 else round(-100.0 / (d - 1.0))


# ── Discovery ──────────────────────────────────────────────────────────────

def discover_friendlies(date_from: Optional[date] = None,
                        days: int = 5) -> List[Dict[str, Any]]:
    """List international-friendly fixtures (Sportmonks league 1082) in the
    window. Returns [{fixture_id, name, home, away, starting_at}]."""
    date_from = date_from or datetime.now(timezone.utc).date()
    date_to = date_from + timedelta(days=days)
    out: List[Dict[str, Any]] = []
    page = 1
    while page <= 10:
        payload = _get(f"/fixtures/between/{date_from.isoformat()}/{date_to.isoformat()}",
                       {"include": "participants", "per_page": 100, "page": page})
        for fx in payload.get("data") or []:
            if fx.get("league_id") != FRIENDLY_LEAGUE_ID:
                continue
            home = away = None
            for p in fx.get("participants") or []:
                loc = (p.get("meta") or {}).get("location")
                if loc == "home": home = p.get("name")
                elif loc == "away": away = p.get("name")
            out.append({
                "fixture_id": fx.get("id"),
                "name": fx.get("name"),
                "home": home, "away": away,
                "starting_at": fx.get("starting_at"),
            })
        pg = payload.get("pagination") or {}
        if not pg.get("has_more"):
            break
        page += 1
    return out


# ── Odds + predictions extraction ──────────────────────────────────────────

def _collect_book_prices(odds_rows: List[Dict[str, Any]]) -> Dict[Tuple[int, str, Optional[float]], List[Tuple[float, str]]]:
    """Collect ALL (decimal, book_name) per (market_id, label, line) for our
    three graded markets — so we can take a consensus, not a lone outlier,
    and know which book holds the best price."""
    prices: Dict[Tuple[int, str, Optional[float]], List[Tuple[float, str]]] = {}
    for o in odds_rows:
        mid = o.get("market_id")
        if mid not in (_MKT_FULLTIME, _MKT_TOTALS, _MKT_BTTS):
            continue
        label = (o.get("label") or "").strip()
        dec = None
        for fld in ("dp3", "value"):
            v = o.get(fld)
            if v is not None:
                try: dec = float(v); break
                except (TypeError, ValueError): pass
        if dec is None or dec <= 1.0:
            continue
        line = None
        if mid == _MKT_TOTALS:
            tot = o.get("total")
            try: line = float(tot) if tot is not None else None
            except (TypeError, ValueError): line = None
            if line != 2.5 or label not in ("Over", "Under"):
                continue
        elif mid == _MKT_FULLTIME and label not in ("Home", "Draw", "Away"):
            continue
        elif mid == _MKT_BTTS and label not in ("Yes", "No"):
            continue
        book = (o.get("bookmaker") or {}).get("name") or f"book#{o.get('bookmaker_id')}"
        prices.setdefault((mid, label, line), []).append((dec, book))
    return prices


def _market_summary(prices: Dict[Tuple[int, str, Optional[float]], List[Tuple[float, str]]]):
    """Per selection: {n_books, consensus_decimal (median), best_decimal (max),
    best_book}. Consensus is what we measure edge against; best is what we'd
    bet at."""
    out: Dict[Tuple[int, str, Optional[float]], Dict[str, Any]] = {}
    for key, quotes in prices.items():
        if not quotes:
            continue
        decs = [d for d, _ in quotes]
        best_dec, best_book = max(quotes, key=lambda q: q[0])
        out[key] = {
            "n_books": len(decs),
            "consensus_decimal": float(_stats.median(decs)),
            "best_decimal": float(best_dec),
            "best_book": best_book,
        }
    return out


def _predictions(preds: List[Dict[str, Any]]) -> Dict[str, Dict[str, float]]:
    out: Dict[str, Dict[str, float]] = {}
    for p in preds or []:
        name = (p.get("type") or {}).get("name")
        if name in (_PRED_1X2, _PRED_OU25, _PRED_BTTS):
            out[name] = p.get("predictions") or {}
    return out


# ── Candidate generation ───────────────────────────────────────────────────

def friendly_candidates(fixture: Dict[str, Any]) -> List[Dict[str, Any]]:
    """For one friendly fixture, build edge-based candidates from the
    Sportmonks model prediction vs the best market price. EXPERIMENTAL tier,
    Sportmonks model (not ACE DC). Returns only positive-edge candidates."""
    fid = fixture["fixture_id"]
    data = _get(f"/fixtures/{fid}",
                {"include": "odds.bookmaker;predictions.type;participants"}).get("data", {})
    summ = _market_summary(_collect_book_prices(data.get("odds") or []))
    preds = _predictions(data.get("predictions") or [])

    home = fixture.get("home") or "Home"
    away = fixture.get("away") or "Away"
    base = {
        "fixture_id": fid,
        "fixture_label": f"{home} vs {away} · Int'l Friendly",
        "commence_time": fixture.get("starting_at"),
        "tier": "experimental",
        "model": "sportmonks",          # NEVER ace_dc — national teams uncovered
        "note": "Friendly (low-signal) · Sportmonks model, not ACE-validated",
    }

    # De-vig consensus implied probs per market group so the comparison is
    # against the market's true estimate, not the vig-inflated raw price.
    def devig(keys: List[Tuple[int, str, Optional[float]]]) -> Dict[Tuple, float]:
        raws = {k: 1.0 / summ[k]["consensus_decimal"] for k in keys if k in summ}
        s = sum(raws.values())
        return {k: v / s for k, v in raws.items()} if s > 0 else {}

    out: List[Dict[str, Any]] = []

    def add(market: str, side: str, label: str, model_pct: Optional[float],
            key: Tuple[int, str, Optional[float]], devigged: Dict[Tuple, float]):
        if model_pct is None or key not in summ:
            return
        info = summ[key]
        if info["n_books"] < _MIN_BOOKS:
            return                                  # thin/illiquid — skip
        model_p = model_pct / 100.0
        consensus_implied = devigged.get(key, 1.0 / info["consensus_decimal"])
        edge_pp = (model_p - consensus_implied) * 100.0
        if edge_pp < _MIN_EDGE_PP:
            return
        if edge_pp > _MAX_EDGE_PP:
            return                                  # suspect outlier/model error — drop
        out.append({
            **base, "market": market, "side": side, "bet_label": label,
            "model_prob": round(model_p, 4),
            "consensus_prob": round(consensus_implied, 4),
            "best_decimal": round(info["best_decimal"], 4),
            "best_american": _decimal_to_american(info["best_decimal"]),
            "best_book": info["best_book"],
            "n_books": info["n_books"],
            "edge_pp": round(edge_pp, 2),
        })

    # 1X2 (de-vig the 3-way)
    p1x2 = preds.get(_PRED_1X2, {})
    k_h, k_d, k_a = (_MKT_FULLTIME,"Home",None), (_MKT_FULLTIME,"Draw",None), (_MKT_FULLTIME,"Away",None)
    dv3 = devig([k_h, k_d, k_a])
    add("1x2", "home", f"{home} to win", p1x2.get("home"), k_h, dv3)
    add("1x2", "away", f"{away} to win", p1x2.get("away"), k_a, dv3)
    add("1x2", "draw", "Draw",           p1x2.get("draw"), k_d, dv3)
    # Totals 2.5 (de-vig the 2-way)
    pou = preds.get(_PRED_OU25, {})
    k_o, k_u = (_MKT_TOTALS,"Over",2.5), (_MKT_TOTALS,"Under",2.5)
    dv_t = devig([k_o, k_u])
    add("totals_2.5", "over",  "Over 2.5 goals",  pou.get("yes"), k_o, dv_t)
    add("totals_2.5", "under", "Under 2.5 goals", pou.get("no"),  k_u, dv_t)
    # BTTS (de-vig the 2-way)
    pbtts = preds.get(_PRED_BTTS, {})
    k_by, k_bn = (_MKT_BTTS,"Yes",None), (_MKT_BTTS,"No",None)
    dv_b = devig([k_by, k_bn])
    add("btts", "yes", "Both teams to score — yes", pbtts.get("yes"), k_by, dv_b)
    add("btts", "no",  "Both teams to score — no",  pbtts.get("no"),  k_bn, dv_b)

    out.sort(key=lambda c: c["edge_pp"], reverse=True)
    return out


def scan_friendlies(days: int = 5, sleep_between: float = 0.12) -> Dict[str, Any]:
    """Discover this window's friendlies + build candidates for each."""
    import time
    fixtures = discover_friendlies(days=days)
    all_candidates: List[Dict[str, Any]] = []
    errors: List[Dict[str, Any]] = []
    for fx in fixtures:
        try:
            all_candidates.extend(friendly_candidates(fx))
            if sleep_between:
                time.sleep(sleep_between)
        except Exception as exc:  # noqa: BLE001
            errors.append({"fixture": fx.get("name"), "error": str(exc)[:150]})
    all_candidates.sort(key=lambda c: c["edge_pp"], reverse=True)
    return {
        "fixtures_scanned": len(fixtures),
        "candidates": all_candidates,
        "errors": errors,
    }


# ── CLI ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse, json
    p = argparse.ArgumentParser(description="International-friendly candidates (Sportmonks)")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("discover").add_argument("--days", type=int, default=5)
    pc = sub.add_parser("candidates"); pc.add_argument("fixture_id", type=int)
    pc.add_argument("--home", default="Home"); pc.add_argument("--away", default="Away")
    sub.add_parser("scan").add_argument("--days", type=int, default=5)
    args = p.parse_args()

    if args.cmd == "discover":
        print(json.dumps(discover_friendlies(days=args.days), indent=2, ensure_ascii=False))
    elif args.cmd == "candidates":
        fx = {"fixture_id": args.fixture_id, "home": args.home, "away": args.away,
              "starting_at": None}
        print(json.dumps(friendly_candidates(fx), indent=2, ensure_ascii=False))
    elif args.cmd == "scan":
        print(json.dumps(scan_friendlies(days=args.days), indent=2, ensure_ascii=False))
