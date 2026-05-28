#!/usr/bin/env python3
"""
player_props.py — local player-prop intelligence from cached data.

This does not depend on live API-Football. It uses the data we already have:
  - wc_historical_form: player country, goals, shots, SoT, minutes by intl comp
  - player_baselines: Bayesian-shrunk player scoring/shot baselines

Goal: produce real player prop cards from the football variables first, then
route those cards to sportsbook lines once Odds API player props are posted.

Pipeline: player baseline -> role/minutes -> team environment -> opponent
weakness -> market check. The market price is deliberately last.
"""
from __future__ import annotations

import json
import math
import os
import sqlite3
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
from dotenv import load_dotenv

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
load_dotenv(_REPO_ROOT / ".env.local")
DB_PATH = _REPO_ROOT / "ml" / "nba_spread" / "data" / "wc_signal_log.db"
ODDS_BASE = "https://api.the-odds-api.com/v4"
# Expanded in M26 to widen the coverage of bettable player markets US books
# actually price. Caveats:
#   • player_to_record_assist — supported on FanDuel + DraftKings most weeks
#   • player_goal_scorer_first — niche, often only the bigger marquee games
#   • player_to_score_2_or_more — same caveat; ~+800 to +2500 typical
# Each adds ~1 Odds API credit per league per tick when scanned.
PLAYER_PROP_MARKETS = (
    "player_goal_scorer_anytime,"
    "player_shots,"
    "player_shots_on_target,"
    "player_to_record_assist,"
    "player_goal_scorer_first,"
    "player_to_score_2_or_more"
)
PLAYER_PROP_BOOKS = "fanduel,draftkings,betmgm,williamhill_us,betrivers,bet365"


def get_db(path: Optional[Path] = None) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path or DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def _norm(s: str) -> str:
    return "".join(ch.lower() for ch in (s or "") if ch.isalnum())


def resolve_cached_team(team: str, league: Optional[str] = None, path: Optional[Path] = None) -> Optional[str]:
    """Resolve Odds API/team-display names to the cached Understat team name."""
    conn = get_db(path)
    try:
        sql = "SELECT DISTINCT team FROM soccer_source_player_stats WHERE provider = 'soccerdata:understat'"
        params = []
        if league:
            sql += " AND league = ?"
            params.append(league)
        teams = [r[0] for r in conn.execute(sql, params).fetchall()]
    except Exception:
        teams = []
    finally:
        conn.close()
    if not teams:
        return None
    if team in teams:
        return team
    aliases = {
        "Manchester United": "Manchester United",
        "Manchester City": "Manchester City",
        "Tottenham Hotspur": "Tottenham",
        "Wolverhampton Wanderers": "Wolverhampton Wanderers",
        "Newcastle United": "Newcastle United",
        "West Ham United": "West Ham",
        "Nottingham Forest": "Nottingham Forest",
        "Brighton and Hove Albion": "Brighton",
        "Atletico Madrid": "Atletico Madrid",
        "Athletic Bilbao": "Athletic Club",
        "Real Betis": "Real Betis",
        "Real Sociedad": "Real Sociedad",
        "Internazionale": "Inter",
        "Inter Milan": "Inter",
        "AC Milan": "AC Milan",
        "AS Roma": "Roma",
        "Paris Saint-Germain": "Paris Saint Germain",
        "Paris SG": "Paris Saint Germain",
        "Olympique Marseille": "Marseille",
        "Olympique Lyonnais": "Lyon",
        "AS Monaco": "Monaco",
        "Bayern Munich": "Bayern Munich",
        "Borussia Dortmund": "Borussia Dortmund",
        "Bayer Leverkusen": "Bayer Leverkusen",
    }
    alias = aliases.get(team)
    if alias in teams:
        return alias
    n = _norm(alias or team)
    by_norm = {_norm(t): t for t in teams}
    if n in by_norm:
        return by_norm[n]
    matches = [t for t in teams if n in _norm(t) or _norm(t) in n]
    return matches[0] if len(matches) == 1 else None


def _assumed_minutes(position_bucket: str, sample_confidence: str) -> int:
    if position_bucket in ("forward", "attacker"):
        return 74 if sample_confidence in ("high", "medium") else 65
    if position_bucket == "midfielder":
        return 76 if sample_confidence in ("high", "medium") else 68
    return 70


def _poisson_at_least_one(lam: float) -> float:
    return 1.0 - math.exp(-max(lam, 0.0))


def _american_to_implied_prob(american: float) -> float:
    if american > 0:
        return 100.0 / (american + 100.0)
    return -american / (-american + 100.0)


def _position_bucket(position: Optional[str]) -> str:
    s = (position or "").lower()
    if "f" in s or "attack" in s or "forward" in s or "striker" in s:
        return "forward"
    if "m" in s or "mid" in s:
        return "midfielder"
    if "d" in s or "def" in s:
        return "defender"
    return "attacker"


def club_player_pool(team: str, league: Optional[str] = None, season: Optional[str] = None, limit: int = 14, path: Optional[Path] = None) -> List[Dict[str, Any]]:
    """Top attacking players from the persisted Understat/soccerdata cache."""
    cached_team = resolve_cached_team(team, league, path) or team
    conn = get_db(path)
    try:
        sql = """
            SELECT player_name, team, league, season, position, appearances,
                   minutes, goals, assists, shots, shots_on_target, xg, np_xg, xa,
                   key_passes, yellow_cards, red_cards
            FROM soccer_source_player_stats
            WHERE provider = 'soccerdata:understat'
              AND team = ?
              AND COALESCE(minutes, 0) >= 180
        """
        params: List[Any] = [cached_team]
        if league:
            sql += " AND league = ?"
            params.append(league)
        if season:
            sql += " AND season = ?"
            params.append(season)
        sql += " ORDER BY COALESCE(xg, 0) DESC, COALESCE(shots, 0) DESC LIMIT ?"
        params.append(limit)
        rows = [dict(r) for r in conn.execute(sql, params).fetchall()]
    except Exception:
        return []
    finally:
        conn.close()

    out: List[Dict[str, Any]] = []
    for r in rows:
        mins = float(r.get("minutes") or 0)
        if mins <= 0:
            continue
        shots = float(r.get("shots") or 0)
        xg = float(r.get("xg") or 0)
        out.append({
            "player_name": r["player_name"],
            "country": r.get("team"),
            "team": r.get("team"),
            "league": r.get("league"),
            "season": r.get("season"),
            "position_bucket": _position_bucket(r.get("position")),
            "sample_confidence": "high" if mins >= 1800 else "medium" if mins >= 900 else "low",
            "g_per_90_shrunk": round(xg / mins * 90.0, 4),
            "g_per_90_raw": round(float(r.get("goals") or 0) / mins * 90.0, 4),
            "shots_per_90": round(shots / mins * 90.0, 4),
            # Understat season endpoint does not expose SoT; keep None and let caller display unavailable.
            "sot_per_90": None,
            "conversion_rate": round(float(r.get("goals") or 0) / shots, 4) if shots > 0 else None,
            "total_goals": r.get("goals"),
            "total_assists": r.get("assists"),
            "total_shots": r.get("shots"),
            "total_sot": r.get("shots_on_target"),
            "total_minutes": r.get("minutes"),
            "xg": r.get("xg"),
            "xa": r.get("xa"),
            "key_passes": r.get("key_passes"),
        })
    return out



def _safe_avg(rows: List[sqlite3.Row], key: str) -> Optional[float]:
    vals = [float(r[key]) for r in rows if r[key] is not None]
    return sum(vals) / len(vals) if vals else None


def team_context(team: str, league: Optional[str] = None, season: Optional[str] = None, last_n: int = 10, path: Optional[Path] = None) -> Dict[str, Any]:
    """Summarize team attack/defense context from persisted Understat matches."""
    cached_team = resolve_cached_team(team, league, path) or team
    conn = get_db(path)
    try:
        sql = """
            SELECT league, season, match_date, team, opponent, venue,
                   goals_for, goals_against, xg_for, xg_against, np_xg_for,
                   ppda, deep_completions
            FROM soccer_source_team_match_stats
            WHERE provider = 'soccerdata:understat'
              AND team = ?
        """
        params: List[Any] = [cached_team]
        if league:
            sql += " AND league = ?"
            params.append(league)
        if season:
            sql += " AND season = ?"
            params.append(season)
        sql += " ORDER BY COALESCE(match_date, '') DESC LIMIT ?"
        params.append(max(last_n, 1))
        rows = conn.execute(sql, params).fetchall()
    except Exception:
        rows = []
    finally:
        conn.close()

    if not rows:
        return {
            "team": cached_team,
            "requested_team": team,
            "sample_matches": 0,
            "attack_xg_for": None,
            "defense_xg_against": None,
            "goals_for": None,
            "goals_against": None,
            "deep_completions": None,
            "league": league,
            "season": season,
        }
    return {
        "team": rows[0]["team"],
        "requested_team": team,
        "sample_matches": len(rows),
        "league": rows[0]["league"],
        "season": rows[0]["season"],
        "attack_xg_for": round(_safe_avg(rows, "xg_for") or 0.0, 3),
        "defense_xg_against": round(_safe_avg(rows, "xg_against") or 0.0, 3),
        "goals_for": round(_safe_avg(rows, "goals_for") or 0.0, 3),
        "goals_against": round(_safe_avg(rows, "goals_against") or 0.0, 3),
        "deep_completions": round(_safe_avg(rows, "deep_completions") or 0.0, 3),
    }


def _blend_team_goal_lambda(base: Optional[float], team_ctx: Dict[str, Any], opp_ctx: Dict[str, Any]) -> float:
    """Team scoring environment for this matchup. Market/team-total input, when present, is weighted most."""
    team_xg = float(team_ctx.get("attack_xg_for") or 1.35)
    opp_xga = float(opp_ctx.get("defense_xg_against") or 1.35)
    if base is not None:
        lam = 0.50 * max(base, 0.05) + 0.25 * team_xg + 0.25 * opp_xga
    else:
        lam = 0.55 * team_xg + 0.45 * opp_xga
    return round(max(0.25, min(lam, 3.50)), 3)


def _weakness_grade(opp_ctx: Dict[str, Any]) -> str:
    xga = opp_ctx.get("defense_xg_against")
    if xga is None:
        return "unknown"
    if xga >= 1.65:
        return "soft"
    if xga <= 1.05:
        return "strong"
    return "average"

def _build_prop_rows(
    pool: List[Dict[str, Any]],
    label: str,
    team_goal_lambda: float,
    limit: int,
    *,
    opponent: Optional[str] = None,
    team_ctx: Optional[Dict[str, Any]] = None,
    opp_ctx: Optional[Dict[str, Any]] = None,
    market_odds: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    attack_pool = [
        p for p in pool
        if (p.get("position_bucket") or "") in ("forward", "attacker", "midfielder")
        and (p.get("sample_confidence") or "minimal") != "minimal"
    ]
    if not attack_pool:
        return []

    raw_rows = []
    total_raw_xg = 0.0
    for p in attack_pool:
        pos = p.get("position_bucket") or "attacker"
        conf = p.get("sample_confidence") or "minimal"
        mins = _assumed_minutes(pos, conf)
        g90 = float(p.get("g_per_90_shrunk") or 0.0)
        raw_xg = max(0.0, g90 * mins / 90.0)
        total_raw_xg += raw_xg
        raw_rows.append((p, mins, raw_xg))

    target_named_xg = max(team_goal_lambda, 0.05) * 0.82
    scale = target_named_xg / total_raw_xg if total_raw_xg > 0 else 1.0

    out = []
    for p, mins, raw_xg in raw_rows:
        xg = raw_xg * scale
        anytime = _poisson_at_least_one(xg)
        shots90 = p.get("shots_per_90")
        sot90 = p.get("sot_per_90")
        shots_mu = float(shots90 or 0.0) * mins / 90.0
        sot_mu = float(sot90 or 0.0) * mins / 90.0 if sot90 is not None else None
        opponent_grade = _weakness_grade(opp_ctx or {}) if opponent else None
        price = (market_odds or {}).get(p["player_name"], {})
        anytime_price = price.get("player_goal_scorer_anytime")
        book_prob = _american_to_implied_prob(float(anytime_price["price"])) if anytime_price and anytime_price.get("price") is not None else None
        edge_pp = (anytime - book_prob) if book_prob is not None else None
        out.append({
            "country": label,
            "team": p.get("team") or label,
            "league": p.get("league"),
            "season": p.get("season"),
            "opponent": opponent,
            "player_name": p["player_name"],
            "position_bucket": p.get("position_bucket"),
            "sample_confidence": p.get("sample_confidence"),
            "assumed_minutes": mins,
            "expected_goals": round(xg, 3),
            "anytime_scorer_prob": round(anytime, 4),
            "shots_mean": round(shots_mu, 2),
            "sot_mean": round(sot_mu, 2) if sot_mu is not None else None,
            "goals_per_90_shrunk": p.get("g_per_90_shrunk"),
            "shots_per_90": p.get("shots_per_90"),
            "sot_per_90": p.get("sot_per_90"),
            "historical_goals": p.get("total_goals"),
            "historical_shots": p.get("total_shots"),
            "historical_sot": p.get("total_sot"),
            "historical_minutes": p.get("total_minutes"),
            "source": "understat_cache" if p.get("team") else "international_cache",
            "context": {
                "player_baseline": {
                    "xg_per_90": p.get("g_per_90_shrunk"),
                    "shots_per_90": p.get("shots_per_90"),
                    "minutes_sample": p.get("total_minutes"),
                    "confidence": p.get("sample_confidence"),
                },
                "role_today": {
                    "lineup_status": "projected_unknown",
                    "assumed_minutes": mins,
                    "penalty_role": "unknown",
                    "set_piece_role": "unknown",
                    "notes": "No confirmed lineup/penalty source wired yet; using role/minutes prior from position and sample confidence.",
                },
                "team_environment": {
                    "projected_team_goals": round(team_goal_lambda, 3),
                    "recent_xg_for": (team_ctx or {}).get("attack_xg_for"),
                    "recent_goals_for": (team_ctx or {}).get("goals_for"),
                    "sample_matches": (team_ctx or {}).get("sample_matches"),
                },
                "opponent_weakness": {
                    "opponent": opponent,
                    "grade": opponent_grade,
                    "recent_xg_against": (opp_ctx or {}).get("defense_xg_against"),
                    "recent_goals_against": (opp_ctx or {}).get("goals_against"),
                    "sample_matches": (opp_ctx or {}).get("sample_matches"),
                } if opponent else None,
                "market_check": {
                    "status": "priced" if book_prob is not None else "not_priced",
                    "best_book": anytime_price.get("book") if anytime_price else None,
                    "american_odds": anytime_price.get("price") if anytime_price else None,
                    "implied_prob": round(book_prob, 4) if book_prob is not None else None,
                    "edge_pp": round(edge_pp * 100, 2) if edge_pp is not None else None,
                },
            },
            "props": [
                {
                    "market": "anytime_scorer",
                    "pick": f"{p['player_name']} anytime scorer",
                    "model_prob": round(anytime, 4),
                    "reason": f"{p['player_name']} projects for {xg:.2f} goals from {mins} assumed minutes, {p.get('g_per_90_shrunk') or 0:.2f} xG/90 baseline, and {team_goal_lambda:.2f} team-goal environment.",
                },
                {
                    "market": "shots",
                    "pick": f"{p['player_name']} shots",
                    "model_mean": round(shots_mu, 2),
                    "reason": f"Shot volume baseline is {p.get('shots_per_90') or 0:.2f} shots/90, projecting {shots_mu:.2f} shots.",
                },
                {
                    "market": "shots_on_target",
                    "pick": f"{p['player_name']} shots on target",
                    "model_mean": round(sot_mu, 2) if sot_mu is not None else None,
                    "reason": "SoT unavailable from Understat season cache." if sot_mu is None else f"SoT baseline is {p.get('sot_per_90') or 0:.2f}/90, projecting {sot_mu:.2f} SoT.",
                },
            ],
        })
    out.sort(key=lambda r: (r["anytime_scorer_prob"], r["shots_mean"], r.get("sot_mean") or 0), reverse=True)
    return out[:limit]


def club_scorer_candidates(team: str, team_goal_lambda: float = 1.45, league: Optional[str] = None, season: Optional[str] = None, limit: int = 8, path: Optional[Path] = None) -> List[Dict[str, Any]]:
    return _build_prop_rows(club_player_pool(team, league, season, max(limit * 2, 14), path), team, team_goal_lambda, limit)




def club_prop_context_cards(
    team: str,
    opponent: str,
    *,
    team_goal_lambda: Optional[float] = None,
    league: Optional[str] = None,
    season: Optional[str] = None,
    limit: int = 8,
    path: Optional[Path] = None,
    market_odds: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    team_ctx = team_context(team, league, season, path=path)
    opp_ctx = team_context(opponent, league or team_ctx.get("league"), season or team_ctx.get("season"), path=path)
    # Cross-league fixtures (UCL/UEL/Club WC style) need the opponent's own
    # domestic cache. If Arsenal is facing PSG, looking for Arsenal inside
    # Ligue 1 returns no context; fall back to provider-wide team resolution.
    if not opp_ctx.get("sample_matches"):
        opp_ctx = team_context(opponent, None, season, path=path)
    lam = _blend_team_goal_lambda(team_goal_lambda, team_ctx, opp_ctx)
    return _build_prop_rows(
        club_player_pool(team, league or team_ctx.get("league"), season or team_ctx.get("season"), max(limit * 2, 14), path),
        team,
        lam,
        limit,
        opponent=opponent,
        team_ctx=team_ctx,
        opp_ctx=opp_ctx,
        market_odds=market_odds,
    )


def matchup_prop_context_cards(
    home_team: str,
    away_team: str,
    *,
    home_goals: Optional[float] = None,
    away_goals: Optional[float] = None,
    league: Optional[str] = None,
    season: Optional[str] = None,
    limit_per_team: int = 5,
    path: Optional[Path] = None,
    market_odds: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    return (
        club_prop_context_cards(home_team, away_team, team_goal_lambda=home_goals, league=league, season=season, limit=limit_per_team, path=path, market_odds=market_odds) +
        club_prop_context_cards(away_team, home_team, team_goal_lambda=away_goals, league=league, season=season, limit=limit_per_team, path=path, market_odds=market_odds)
    )


def extract_prop_market_odds(game: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    """All Odds API player-prop offerings indexed by player + market.

    Previous implementation kept ONLY the highest-priced outcome per
    (player, market), which silently picked FanDuel's longshot lines
    (e.g. "6+ shots @ +470" instead of "2+ shots @ -200") because higher
    American price = longer odds. That broke the picks layer: shots
    cards showed nonsense lines that aren't really bettable.

    New shape: for each (player, market) we keep the list of ALL price
    tiers — every (point, book, price) combo offered. Downstream callers
    (compute_prop_edge in prop_cards.py) iterate the tiers, compute the
    Poisson edge at each line, and pick the threshold where the model's
    edge is largest. That surfaces the actual best bet, not the longshot.

    Yes/No markets (anytime_scorer) have no 'point' — they always come
    back as a single tier with point=None. The downstream code treats
    point=None as the binary YES case.
    """
    out: Dict[str, Dict[str, List[Dict[str, Any]]]] = {}
    for bm in game.get("bookmakers") or []:
        book = bm.get("key") or bm.get("title")
        for mkt in bm.get("markets") or []:
            mk = mkt.get("key")
            if mk not in {
                "player_goal_scorer_anytime",
                "player_shots",
                "player_shots_on_target",
                "player_to_record_assist",
                "player_goal_scorer_first",
                "player_to_score_2_or_more",
            }:
                continue
            for outcome in mkt.get("outcomes") or []:
                player = outcome.get("description") or (outcome.get("name") if outcome.get("name") not in ("Yes", "No", "Over", "Under") else None)
                # Drop the NO side — for anytime_scorer we only price YES;
                # for X+ ladder markets there's no NO outcome per tier.
                if not player or outcome.get("name") == "No":
                    continue
                price = outcome.get("price")
                if price is None:
                    continue
                player_markets = out.setdefault(player, {})
                tiers = player_markets.setdefault(mk, [])
                tiers.append({
                    "book": book,
                    "price": price,
                    "point": outcome.get("point"),
                })

    # Back-compat shim: the existing scorer_candidates / club_prop_context_cards
    # code path expects a flat {player: {market: {book, price, point}}} dict.
    # Different selection policy per market type:
    #
    #   • anytime_scorer (no `point` — single YES outcome per book) → pick
    #     the HIGHEST American price, which gives the bettor the best
    #     payout on the same probabilistic bet. This is the original
    #     pre-M16 behavior; preserved for compatibility with downstream
    #     code that uses the surfaced odds for edge computation.
    #
    #   • shots, shots_on_target (count-ladder markets — multiple `point`
    #     tiers per book) → the surfaced default is the LOWEST threshold
    #     (most-bettable line, used by code paths that don't yet know how
    #     to search the ladder). prop_cards.py uses `_all_tiers` to do the
    #     real Poisson-edge search across every tier.
    #
    # Both cases expose the full ladder under `_all_tiers` so callers can
    # opt into the multi-line edge search.
    flat: Dict[str, Dict[str, Any]] = {}
    for player, markets in out.items():
        flat[player] = {}
        for mk, tiers in markets.items():
            if not tiers:
                continue
            has_points = any(t.get("point") is not None for t in tiers)
            if has_points:
                # Count-ladder: default to lowest threshold tier
                default = sorted(
                    tiers,
                    key=lambda t: (
                        float(t.get("point") or 0),
                        -float(t.get("price") or 0),  # secondary: higher price wins ties
                    ),
                )[0]
            else:
                # Single-tier (anytime_scorer style): pick highest American price
                default = max(tiers, key=lambda t: float(t.get("price") or -99999))
            entry = dict(default)
            entry["_all_tiers"] = tiers  # full ladder for downstream edge search
            flat[player][mk] = entry
    return flat


def fetch_event_player_prop_odds(sport_key: str, event_id: str, markets: str = PLAYER_PROP_MARKETS) -> Dict[str, Any]:
    """Odds API per-event player-prop fetch. Costs API credits; call deliberately."""
    api_key = os.getenv("ODDS_API_KEY", "")
    if not api_key:
        raise EnvironmentError("ODDS_API_KEY not set")
    resp = httpx.get(
        f"{ODDS_BASE}/sports/{sport_key}/events/{event_id}/odds",
        params={
            "apiKey": api_key,
            "regions": "us",
            "markets": markets,
            "bookmakers": PLAYER_PROP_BOOKS,
            "oddsFormat": "american",
        },
        timeout=15,
    )
    if resp.status_code == 422:
        return {"ok": True, "event_id": event_id, "available": False, "game": None, "odds": {}}
    if resp.status_code == 429:
        raise RuntimeError("Odds API quota exceeded")
    resp.raise_for_status()
    game = resp.json()
    return {"ok": True, "event_id": event_id, "available": True, "game": game, "odds": extract_prop_market_odds(game)}


def country_player_pool(country: str, limit: int = 12, path: Optional[Path] = None) -> List[Dict[str, Any]]:
    """Top attacking players for a national team/country from cached history.

    Uses country in wc_historical_form because wc_players squad sync is blocked
    until API-Football access is repaired. Joins player_baselines by name.
    """
    conn = get_db(path)
    try:
        rows = conn.execute(
            """
            SELECT
                h.player_name,
                h.country,
                SUM(h.goals) AS total_goals,
                SUM(h.assists) AS total_assists,
                SUM(h.shots) AS total_shots,
                SUM(h.shots_on_target) AS total_sot,
                SUM(h.minutes) AS total_minutes,
                SUM(h.matches_played) AS matches_played,
                COUNT(DISTINCT h.competition) AS comps_count,
                b.position_bucket,
                b.g_per_90_shrunk,
                b.g_per_90_raw,
                b.shots_per_90,
                b.sot_per_90,
                b.conversion_rate,
                b.sample_confidence
            FROM wc_historical_form h
            LEFT JOIN player_baselines b ON b.player_name = h.player_name
            WHERE lower(replace(h.country, '-', ' ')) = ?
            GROUP BY h.player_name, h.country
            HAVING total_minutes >= 180
            ORDER BY COALESCE(b.g_per_90_shrunk, 0) DESC, total_goals DESC, total_shots DESC
            LIMIT ?
            """,
            (_norm(country), limit),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def scorer_candidates(
    country: str,
    team_goal_lambda: float = 1.45,
    limit: int = 8,
    path: Optional[Path] = None,
) -> List[Dict[str, Any]]:
    """Estimate anytime scorer and shot prop candidates for one team.

    The player lambda starts from the player's shrunk g/90, scales by assumed
    minutes, then gently normalizes to the team's expected goals so candidate
    probabilities are tied to the match read rather than raw historical rates.
    """
    pool = country_player_pool(country, limit=max(limit * 2, 12), path=path)
    return _build_prop_rows(pool, country, team_goal_lambda, limit)


def data_status(path: Optional[Path] = None) -> Dict[str, Any]:
    conn = get_db(path)
    try:
        def count(table: str) -> int:
            try:
                return int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
            except Exception:
                return 0
        countries = [r[0] for r in conn.execute(
            "SELECT country FROM wc_historical_form GROUP BY country ORDER BY COUNT(*) DESC LIMIT 12"
        ).fetchall()]
        return {
            "historical_player_rows": count("wc_historical_form"),
            "player_baselines": count("player_baselines"),
            "wc_players": count("wc_players"),
            "club_players": count("club_players"),
            "wc_player_form": count("wc_player_form"),
            "wc_player_priors": count("wc_player_priors"),
            "source_player_stats": count("soccer_source_player_stats"),
            "source_team_match_stats": count("soccer_source_team_match_stats"),
            "top_countries": countries,
        }
    finally:
        conn.close()


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Local soccer player prop model")
    parser.add_argument("cmd", choices=["status", "country", "club", "match", "event-odds"])
    parser.add_argument("--country", default="France")
    parser.add_argument("--team", default="Arsenal")
    parser.add_argument("--home", default="Real Madrid")
    parser.add_argument("--away", default="Barcelona")
    parser.add_argument("--opponent", default="Chelsea")
    parser.add_argument("--league", default=None)
    parser.add_argument("--season", default=None)
    parser.add_argument("--team-goals", type=float, default=1.45)
    parser.add_argument("--home-goals", type=float, default=None)
    parser.add_argument("--away-goals", type=float, default=None)
    parser.add_argument("--sport-key", default="soccer_epl")
    parser.add_argument("--event-id", default=None)
    parser.add_argument("--limit", type=int, default=8)
    args = parser.parse_args()
    if args.cmd == "status":
        print(json.dumps(data_status(), indent=2))
    elif args.cmd == "country":
        print(json.dumps(scorer_candidates(args.country, args.team_goals, args.limit), indent=2, ensure_ascii=False))
    elif args.cmd == "club":
        print(json.dumps(club_prop_context_cards(args.team, args.opponent, team_goal_lambda=args.team_goals, league=args.league, season=args.season, limit=args.limit), indent=2, ensure_ascii=False))
    elif args.cmd == "match":
        print(json.dumps(matchup_prop_context_cards(args.home, args.away, home_goals=args.home_goals, away_goals=args.away_goals, league=args.league, season=args.season, limit_per_team=args.limit), indent=2, ensure_ascii=False))
    elif args.cmd == "event-odds":
        if not args.event_id:
            raise SystemExit("--event-id is required")
        print(json.dumps(fetch_event_player_prop_odds(args.sport_key, args.event_id), indent=2, ensure_ascii=False))
