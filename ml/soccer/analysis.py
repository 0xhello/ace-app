#!/usr/bin/env python3
"""
analysis.py — real-variable soccer handicapping layer.

This is intentionally NOT an arbitrage/value scanner. It builds match cards from
actual football variables first (form, goals pace, shots/SoT, corners, cards,
Dixon-Coles goal expectancy), then emits human-readable leans/picks. Odds are
only routing context after the football case exists.

Usage:
    python3 -m ml.soccer.analysis slate
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from ml.soccer.candidates import _resolve_team, _book_h2h_probs, _book_totals_probs
from ml.soccer.form import get_db, init_form_tables, get_recent_form, summarize_form, get_h2h, summarize_h2h
from ml.soccer.leagues import LEAGUES, fetch_league_odds, filter_upcoming
from ml.soccer.model import load_fits, predict_match

SUPPORTED_LEAGUES = {"Premier League", "La Liga", "Bundesliga", "Serie A", "Ligue 1"}
PLAYABLE_BOOKS = ("fanduel", "draftkings", "betmgm", "williamhill_us", "betrivers", "caesars", "bet365")


def _avg(vals: Iterable[Optional[float]]) -> Optional[float]:
    xs = [float(v) for v in vals if v is not None]
    return round(sum(xs) / len(xs), 2) if xs else None


def _team_flow(team: str, league: str, venue: Optional[str] = None, n: int = 10) -> Dict[str, Any]:
    init_form_tables()
    before = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    conn = get_db()
    try:
        sql = """
            SELECT goals_for, goals_against, shots, shots_against, sot, sot_against,
                   corners, corners_against, yellows, yellows_against, reds, reds_against,
                   result
            FROM soccer_team_form
            WHERE team_name = ? AND league = ? AND match_date < ?
        """
        params: List[Any] = [team, league, before]
        if venue in ("home", "away"):
            sql += " AND venue = ?"
            params.append(venue)
        sql += " ORDER BY match_date DESC LIMIT ?"
        params.append(n)
        rows = [dict(r) for r in conn.execute(sql, params).fetchall()]
    finally:
        conn.close()
    if not rows:
        return {"n": 0}
    return {
        "n": len(rows),
        "goals_for_pg": _avg(r["goals_for"] for r in rows),
        "goals_against_pg": _avg(r["goals_against"] for r in rows),
        "shots_for_pg": _avg(r["shots"] for r in rows),
        "shots_against_pg": _avg(r["shots_against"] for r in rows),
        "sot_for_pg": _avg(r["sot"] for r in rows),
        "sot_against_pg": _avg(r["sot_against"] for r in rows),
        "corners_for_pg": _avg(r["corners"] for r in rows),
        "corners_against_pg": _avg(r["corners_against"] for r in rows),
        "cards_pg": _avg((r["yellows"] or 0) + (r["reds"] or 0) for r in rows),
    }


def _best_h2h_price(game: Dict[str, Any], side: str) -> Optional[Dict[str, Any]]:
    best = None
    for book in PLAYABLE_BOOKS:
        probs = _book_h2h_probs(game, book)
        if not probs or side not in probs:
            continue
        row = {"book": book, "odds": probs[side]["odds"], "market_prob": probs[side]["prob"]}
        if best is None or row["odds"] > best["odds"]:
            best = row
    return best


def _best_total_price(game: Dict[str, Any], side: str, line: float = 2.5) -> Optional[Dict[str, Any]]:
    best = None
    for book in PLAYABLE_BOOKS:
        probs = _book_totals_probs(game, book, line)
        if not probs or side not in probs:
            continue
        row = {"book": book, "odds": probs[side]["odds"], "market_prob": probs[side]["prob"]}
        if best is None or row["odds"] > best["odds"]:
            best = row
    return best


def _total_pick(pred: Dict[str, Any], home_flow: Dict[str, Any], away_flow: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    total_lambda = pred["lambda_h"] + pred["lambda_a"]
    under_p = pred["under_2.5"]
    over_p = pred["over_2.5"]
    recent_combined = None
    if home_flow.get("goals_for_pg") is not None and away_flow.get("goals_for_pg") is not None:
        # Expected game pace using each side's attack plus opponent concessions.
        recent_combined = round(
            (home_flow.get("goals_for_pg", 0) + home_flow.get("goals_against_pg", 0) +
             away_flow.get("goals_for_pg", 0) + away_flow.get("goals_against_pg", 0)) / 2,
            2,
        )
    if under_p >= 0.58 and total_lambda <= 2.35:
        return {
            "market": "totals", "pick": "UNDER 2.5", "model_prob": under_p,
            "confidence": "A" if under_p >= 0.63 else "B",
            "football_case": [
                f"Model goal expectancy is {total_lambda:.2f} total goals.",
                f"Under 2.5 probability is {under_p*100:.1f}%.",
                f"Recent combined goal pace is {recent_combined} goals/game." if recent_combined is not None else "Recent goal pace sample is thin.",
            ],
        }
    if over_p >= 0.58 and total_lambda >= 2.75:
        return {
            "market": "totals", "pick": "OVER 2.5", "model_prob": over_p,
            "confidence": "A" if over_p >= 0.63 else "B",
            "football_case": [
                f"Model goal expectancy is {total_lambda:.2f} total goals.",
                f"Over 2.5 probability is {over_p*100:.1f}%.",
                f"Recent combined goal pace is {recent_combined} goals/game." if recent_combined is not None else "Recent goal pace sample is thin.",
            ],
        }
    return None


def _side_pick(pred: Dict[str, Any], home: str, away: str, home_form: Dict[str, Any], away_form: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    sides = [("home", home, pred["p_home"]), ("draw", "Draw", pred["p_draw"]), ("away", away, pred["p_away"])]
    side, label, prob = max(sides, key=lambda x: x[2])
    # Only make a side recommendation when the model has clear conviction.
    if side != "draw" and prob >= 0.52:
        return {
            "market": "h2h", "side": side, "pick": label, "model_prob": prob,
            "confidence": "A" if prob >= 0.60 else "B",
            "football_case": [
                f"Model makes {label} the most likely result at {prob*100:.1f}%.",
                f"Recent form: {home} {home_form['record']} ({home_form['gf']}-{home_form['ga']} goals), {away} {away_form['record']} ({away_form['gf']}-{away_form['ga']} goals).",
                f"Expected goals: {home} {pred['lambda_h']:.2f}, {away} {pred['lambda_a']:.2f}.",
            ],
        }
    if side == "draw" and prob >= 0.31:
        return {
            "market": "h2h", "side": "draw", "pick": "Draw", "model_prob": prob,
            "confidence": "B",
            "football_case": [
                f"Draw probability is elevated at {prob*100:.1f}%.",
                f"Expected goals are balanced: {home} {pred['lambda_h']:.2f}, {away} {pred['lambda_a']:.2f}.",
            ],
        }
    return None


def analyze_game(sport_key: str, league: str, game: Dict[str, Any], fit: Any) -> Optional[Dict[str, Any]]:
    home_raw, away_raw = game.get("home_team"), game.get("away_team")
    home = _resolve_team(league, home_raw, fit.alpha.keys()) if home_raw else None
    away = _resolve_team(league, away_raw, fit.alpha.keys()) if away_raw else None
    if not home or not away:
        return None

    conn = get_db()
    try:
        pred = predict_match(fit, home, away, league=league, apply_adjustments=True, conn=conn)
    finally:
        conn.close()
    if not pred:
        return None

    home_form_rows = get_recent_form(home, n=5)
    away_form_rows = get_recent_form(away, n=5)
    home_form = summarize_form(home_form_rows)
    away_form = summarize_form(away_form_rows)
    h2h = summarize_h2h(get_h2h(home, away, n=5), home, away)
    home_flow = _team_flow(home, league, venue="home", n=10)
    away_flow = _team_flow(away, league, venue="away", n=10)

    picks: List[Dict[str, Any]] = []
    side = _side_pick(pred, home_raw, away_raw, home_form, away_form)
    if side:
        route = _best_h2h_price(game, side.get("side", "home"))
        side["route"] = route
        picks.append(side)
    total = _total_pick(pred, home_flow, away_flow)
    if total:
        total_side = "under" if "UNDER" in total["pick"] else "over"
        total["route"] = _best_total_price(game, total_side, 2.5)
        picks.append(total)

    return {
        "game_id": game.get("id"),
        "sport_key": sport_key,
        "league": league,
        "matchup": f"{away_raw} @ {home_raw}",
        "home_team": home_raw,
        "away_team": away_raw,
        "model_home_team": home,
        "model_away_team": away,
        "commence_time": game.get("commence_time"),
        "prediction": {
            "home_win": pred["p_home"], "draw": pred["p_draw"], "away_win": pred["p_away"],
            "lambda_home": pred["lambda_h"], "lambda_away": pred["lambda_a"],
            "over_2_5": pred["over_2.5"], "under_2_5": pred["under_2.5"],
            "btts_yes": pred["btts_yes"], "adjustments": pred.get("_adj"),
        },
        "variables": {
            "home_form_last5": home_form,
            "away_form_last5": away_form,
            "home_flow_home_last10": home_flow,
            "away_flow_away_last10": away_flow,
            "h2h_last5": h2h,
        },
        "picks": picks,
    }


def analyze_slate(horizon_hours: int = 72, limit: int = 20) -> List[Dict[str, Any]]:
    fits, _ = load_fits()
    out: List[Dict[str, Any]] = []
    for sport_key, league, _active_until in LEAGUES:
        if league not in SUPPORTED_LEAGUES or league not in fits:
            continue
        try:
            games = filter_upcoming(fetch_league_odds(sport_key), horizon_hours=horizon_hours)
        except Exception:
            continue
        for game in games:
            card = analyze_game(sport_key, league, game, fits[league])
            if card:
                out.append(card)
    out.sort(key=lambda c: max([p.get("model_prob", 0) for p in c.get("picks", [])] or [0]), reverse=True)
    return out[:limit]


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("cmd", choices=["slate"])
    parser.add_argument("--limit", type=int, default=10)
    args = parser.parse_args()
    print(json.dumps(analyze_slate(limit=args.limit), indent=2))
