#!/usr/bin/env python3
"""
prop_cards.py — fixture-driven ACE soccer player-prop context cards.

This is the durable layer above `player_props.py`:
  upcoming fixture -> player/team/opponent context cards -> optional market price

Default scans DO NOT fetch per-event player prop markets because those calls can
spend Odds API credits per event. Use --with-market when deliberately checking
prices.
"""
from __future__ import annotations

import json
import math
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from statistics import median
from typing import Any, Dict, Iterable, List, Optional, Tuple

from ml.soccer.leagues import LEAGUES, fetch_league_odds, filter_upcoming
from ml.soccer.live_state import apply_live_state_to_card, init_db as init_live_state_db
from ml.soccer.player_props import (
    extract_prop_market_odds,
    fetch_event_player_prop_odds,
    matchup_prop_context_cards,
)
from ml.world_cup.signal_logger import DB_PATH as DEFAULT_DB_PATH, update_meta

SUPPORTED_LEAGUES = {"Premier League", "La Liga", "Bundesliga", "Serie A", "Ligue 1", "UCL"}
PROP_MARKETS = ("anytime_scorer", "shots", "shots_on_target")


def get_db(path: Optional[Path] = None) -> sqlite3.Connection:
    p = path or DEFAULT_DB_PATH
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(p)
    conn.row_factory = sqlite3.Row
    return conn


def init_db(path: Optional[Path] = None) -> None:
    init_live_state_db(path)
    conn = get_db(path)
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS soccer_prop_cards (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            game_id            TEXT NOT NULL,
            sport_key          TEXT NOT NULL,
            tournament         TEXT NOT NULL,
            commence_time      TEXT,
            home_team          TEXT NOT NULL,
            away_team          TEXT NOT NULL,
            team               TEXT NOT NULL,
            opponent           TEXT NOT NULL,
            player_name        TEXT NOT NULL,
            market             TEXT NOT NULL,
            model_prob         REAL,
            model_mean         REAL,
            book               TEXT,
            book_odds          REAL,
            book_point         REAL,
            implied_prob       REAL,
            edge_pp            REAL,
            decision           TEXT NOT NULL,
            confidence_tier    TEXT NOT NULL,
            status             TEXT NOT NULL DEFAULT 'watch',
            blocker_reasons    TEXT NOT NULL DEFAULT '[]',
            bettor_notes       TEXT NOT NULL DEFAULT '[]',
            card_json          TEXT NOT NULL,
            context_json       TEXT NOT NULL,
            result_value       REAL,
            result_hit         INTEGER,
            graded_at          TEXT,
            detected_at        TEXT NOT NULL,
            updated_at         TEXT NOT NULL,
            created_at         TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS uidx_soccer_prop_cards
          ON soccer_prop_cards(game_id, team, player_name, market, COALESCE(book, '__model__'), COALESCE(book_point, -999));
        CREATE INDEX IF NOT EXISTS idx_soccer_prop_cards_status
          ON soccer_prop_cards(status, commence_time);
        CREATE INDEX IF NOT EXISTS idx_soccer_prop_cards_edge
          ON soccer_prop_cards(edge_pp DESC);
        """
    )
    existing = {r["name"] for r in conn.execute("PRAGMA table_info(soccer_prop_cards)").fetchall()}
    for col, typ in [
        ("result_value", "REAL"), ("result_hit", "INTEGER"), ("graded_at", "TEXT"),
        ("blocker_reasons", "TEXT NOT NULL DEFAULT '[]'"),
        ("bettor_notes", "TEXT NOT NULL DEFAULT '[]'"),
    ]:
        if col not in existing:
            conn.execute(f"ALTER TABLE soccer_prop_cards ADD COLUMN {col} {typ}")
    conn.commit()
    conn.close()


def _american_to_implied_prob(american: float) -> float:
    if american > 0:
        return 100.0 / (american + 100.0)
    return -american / (-american + 100.0)


def _norm(s: str) -> str:
    return "".join(ch.lower() for ch in (s or "") if ch.isalnum())


def _market_for_prop(prop_market: str) -> str:
    if prop_market == "anytime_scorer":
        return "player_goal_scorer_anytime"
    if prop_market == "shots":
        return "player_shots"
    return "player_shots_on_target"


def _find_player_odds(odds: Dict[str, Dict[str, Any]], player_name: str, prop_market: str) -> Optional[Dict[str, Any]]:
    market_key = _market_for_prop(prop_market)
    if player_name in odds and market_key in odds[player_name]:
        return odds[player_name][market_key]
    n = _norm(player_name)
    for name, markets in odds.items():
        nn = _norm(name)
        if (n == nn or n in nn or nn in n) and market_key in markets:
            return markets[market_key]
    return None


def _confidence(card: Dict[str, Any], market: str, edge_pp: Optional[float], blockers: Optional[List[str]] = None) -> str:
    blockers = blockers or []
    sample = (card.get("sample_confidence") or "low").lower()
    # Unknown lineup/penalty context caps confidence. A real bettor does not
    # call this A-tier until the player is expected/confirmed to start.
    if any(b.startswith("lineup_") or b.startswith("role_") for b in blockers):
        if edge_pp is not None and edge_pp >= 0.07 and sample == "high":
            return "B"
        return "C"
    if edge_pp is not None:
        if edge_pp >= 0.08 and sample == "high":
            return "A"
        if edge_pp >= 0.05 and sample in {"high", "medium"}:
            return "B"
    if market == "anytime_scorer" and float(card.get("anytime_scorer_prob") or 0) >= 0.30 and sample == "high":
        return "B"
    return "C"


def _bettor_review(card: Dict[str, Any], market: str, edge_pp: Optional[float], priced: bool) -> Tuple[str, List[str], List[str]]:
    """Return decision + explicit bettor blockers/notes.

    Rules intentionally conservative. This prevents ACE from pretending a famous
    player baseline is an actionable bet before lineup, role, opponent, and
    market context are present.
    """
    blockers: List[str] = []
    notes: List[str] = []
    ctx = card.get("context") or {}
    role = ctx.get("role_today") or {}
    team_env = ctx.get("team_environment") or {}
    opp = ctx.get("opponent_weakness") or {}
    sample = (card.get("sample_confidence") or "low").lower()
    lineup = role.get("lineup_status") or "projected_unknown"
    availability = role.get("availability") or "unknown"
    penalty = role.get("penalty_role") or "unknown"
    position_bucket = role.get("position_bucket") or "unknown"
    attack_role_score = role.get("attack_role_score")
    try:
        attack_role_score = float(attack_role_score) if attack_role_score is not None else None
    except Exception:
        attack_role_score = None
    team_goals = team_env.get("projected_team_goals")
    opp_grade = opp.get("grade") or "unknown"
    opp_xga = opp.get("recent_xg_against")
    prob = float(card.get("anytime_scorer_prob") or 0.0)
    shots = float(card.get("shots_mean") or 0.0)

    if sample == "low":
        blockers.append("sample_low")
    if team_goals is None:
        blockers.append("team_total_missing")
    elif float(team_goals) < 1.35 and market == "anytime_scorer":
        blockers.append("team_total_too_low")
    if opp_grade == "unknown" or opp_xga is None:
        blockers.append("opponent_context_missing")
    elif opp_grade == "strong" and market == "anytime_scorer":
        blockers.append("opponent_defense_strong")
    if availability in {"out", "suspended", "injured"} or lineup == "out":
        blockers.append("player_unavailable")
    elif lineup not in {"confirmed_starting", "projected_starting"}:
        blockers.append("lineup_unknown")
    if market == "anytime_scorer" and penalty == "unknown":
        blockers.append("role_penalty_unknown")
    if attack_role_score is not None:
        if market == "anytime_scorer" and attack_role_score < 0.45:
            blockers.append("role_not_attacking_enough")
        if market == "shots" and attack_role_score < 0.35:
            blockers.append("role_low_shot_profile")
    if not priced:
        blockers.append("market_price_missing")
    elif edge_pp is None and market == "anytime_scorer":
        blockers.append("edge_unavailable")

    if market == "anytime_scorer":
        notes.append(f"scorer_prob={prob:.1%}")
        if penalty == "primary":
            notes.append("penalty_boost")
        elif penalty == "unknown":
            notes.append("penalty_role_not_verified")
    if market == "shots":
        notes.append(f"shots_mean={shots:.2f}")
    if attack_role_score is not None:
        notes.append(f"attack_role={attack_role_score:.2f}")
    if position_bucket and position_bucket != "unknown":
        notes.append(f"role={position_bucket}")
    if team_goals is not None:
        notes.append(f"team_goals={float(team_goals):.2f}")
    if opp_xga is not None:
        notes.append(f"opp_xga={float(opp_xga):.2f}")

    hard_blockers = {"player_unavailable", "lineup_unknown", "market_price_missing", "team_total_missing", "opponent_context_missing", "role_not_attacking_enough", "role_low_shot_profile"}
    if priced and edge_pp is not None:
        if edge_pp < 0.02:
            return "pass", blockers + ["edge_too_thin"], notes
        if edge_pp >= 0.06 and not (set(blockers) & hard_blockers):
            return "pick", blockers, notes
        if edge_pp >= 0.035 and not (set(blockers) & hard_blockers):
            return "lean", blockers, notes
        return "watch", blockers, notes

    # Pre-market cards are only scouting/watchlist items, never picks.
    if market == "anytime_scorer" and prob >= 0.25 and sample in {"high", "medium"} and not (set(blockers) & {"player_unavailable", "role_not_attacking_enough"}):
        return "watch", blockers, notes
    if market == "shots" and shots >= 3.0 and sample in {"high", "medium"} and not (set(blockers) & {"player_unavailable", "role_low_shot_profile"}):
        return "watch", blockers, notes
    return "pass", blockers, notes


def _extract_total_lines(game: Dict[str, Any]) -> List[float]:
    lines: List[float] = []
    for bm in game.get("bookmakers") or []:
        for mkt in bm.get("markets") or []:
            if mkt.get("key") != "totals":
                continue
            for outcome in mkt.get("outcomes") or []:
                try:
                    if outcome.get("point") is not None:
                        lines.append(float(outcome["point"]))
                except Exception:
                    pass
    return lines


def _h2h_home_away_ratio(game: Dict[str, Any]) -> Tuple[float, float]:
    home = game.get("home_team")
    away = game.get("away_team")
    for bm in game.get("bookmakers") or []:
        for mkt in bm.get("markets") or []:
            if mkt.get("key") != "h2h":
                continue
            prices = {o.get("name"): o.get("price") for o in mkt.get("outcomes") or []}
            if home not in prices or away not in prices:
                continue
            hp = _american_to_implied_prob(float(prices[home]))
            ap = _american_to_implied_prob(float(prices[away]))
            s = hp + ap
            if s > 0:
                return hp / s, ap / s
    return 0.5, 0.5


def estimate_team_goals(game: Dict[str, Any]) -> Tuple[Optional[float], Optional[float]]:
    """Rough team-goal split from total line + h2h favorite strength."""
    lines = _extract_total_lines(game)
    if not lines:
        return None, None
    total = median(lines)
    home_share, away_share = _h2h_home_away_ratio(game)
    # Keep split conservative; h2h odds are noisy with draws/vig.
    home_share = max(0.38, min(home_share, 0.62))
    away_share = 1.0 - home_share
    return round(total * home_share, 3), round(total * away_share, 3)


def _clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def _role_adjusted_card(card: Dict[str, Any]) -> Dict[str, Any]:
    """Adjust projection outputs using confirmed lineup/minutes/role features.

    Baseline xG comes from season Understat + team environment. Sportmonks live
    features tell us whether today's actual role supports that baseline.
    """
    ctx = card.get("context") or {}
    role = ctx.get("role_today") or {}
    try:
        base_mins = float(card.get("assumed_minutes") or 0)
        live_mins = float(role.get("assumed_minutes") or base_mins or 0)
    except Exception:
        base_mins = live_mins = 0.0
    minute_factor = _clamp(live_mins / base_mins, 0.35, 1.25) if base_mins > 0 and live_mins > 0 else 1.0
    attack_score = role.get("attack_role_score")
    try:
        attack_score = float(attack_score) if attack_score is not None else None
    except Exception:
        attack_score = None
    goal_role_factor = _clamp(0.65 + 0.60 * attack_score, 0.45, 1.25) if attack_score is not None else 1.0
    shot_role_factor = _clamp(0.72 + 0.42 * attack_score, 0.45, 1.18) if attack_score is not None else 1.0

    if abs(minute_factor - 1.0) < 0.01 and abs(goal_role_factor - 1.0) < 0.01 and abs(shot_role_factor - 1.0) < 0.01:
        return card

    out = dict(card)
    out_ctx = dict(ctx)
    out_ctx["model_adjustment"] = {
        "source": role.get("source") or "live_role_features",
        "minute_factor": round(minute_factor, 3),
        "goal_role_factor": round(goal_role_factor, 3),
        "shot_role_factor": round(shot_role_factor, 3),
        "attack_role_score": attack_score,
    }
    out["context"] = out_ctx
    try:
        old_xg = float(out.get("expected_goals") or 0.0)
    except Exception:
        old_xg = 0.0
    try:
        old_shots = float(out.get("shots_mean") or 0.0)
    except Exception:
        old_shots = 0.0
    new_xg = max(0.0, old_xg * minute_factor * goal_role_factor)
    new_shots = max(0.0, old_shots * minute_factor * shot_role_factor)
    out["assumed_minutes"] = live_mins or out.get("assumed_minutes")
    out["expected_goals"] = round(new_xg, 3)
    out["anytime_scorer_prob"] = round(1.0 - math.exp(-new_xg), 4)
    out["shots_mean"] = round(new_shots, 2)

    props = []
    for prop in out.get("props") or []:
        p = dict(prop)
        if p.get("market") == "anytime_scorer":
            p["model_prob"] = out["anytime_scorer_prob"]
            p["reason"] = f"Live-role adjusted xG: {new_xg:.2f} from {live_mins or base_mins:.0f} minutes, attack-role factor {goal_role_factor:.2f}, minute factor {minute_factor:.2f}."
        elif p.get("market") == "shots":
            p["model_mean"] = out["shots_mean"]
            p["reason"] = f"Live-role adjusted shots mean: {new_shots:.2f}, attack-role factor {shot_role_factor:.2f}, minute factor {minute_factor:.2f}."
        props.append(p)
    out["props"] = props
    return out


def cards_for_game(
    sport_key: str,
    tournament: str,
    game: Dict[str, Any],
    *,
    prop_odds: Optional[Dict[str, Dict[str, Any]]] = None,
    limit_per_team: int = 4,
    db_path: Optional[Path] = None,
) -> List[Dict[str, Any]]:
    home = game.get("home_team")
    away = game.get("away_team")
    if not home or not away:
        return []
    home_goals, away_goals = estimate_team_goals(game)
    base_cards = matchup_prop_context_cards(
        home,
        away,
        home_goals=home_goals,
        away_goals=away_goals,
        league=None,
        season=None,
        limit_per_team=limit_per_team,
        market_odds=prop_odds,
    )
    now = datetime.now(timezone.utc).isoformat()
    rows: List[Dict[str, Any]] = []
    for card in base_cards:
        card = apply_live_state_to_card(card, game["id"], db_path)
        card = _role_adjusted_card(card)
        for prop in card.get("props") or []:
            market = prop.get("market")
            if market not in PROP_MARKETS:
                continue
            if market == "shots_on_target" and prop.get("model_mean") is None:
                # Understat season cache lacks SoT; do not create fake cards.
                continue
            odds = _find_player_odds(prop_odds or {}, card["player_name"], market)
            implied = None
            edge_pp = None
            model_prob = prop.get("model_prob") if market == "anytime_scorer" else None
            model_mean = prop.get("model_mean") if market != "anytime_scorer" else card.get("expected_goals")
            if odds and odds.get("price") is not None:
                implied = _american_to_implied_prob(float(odds["price"]))
                if model_prob is not None:
                    edge_pp = float(model_prob) - implied
            decision, blockers, bettor_notes = _bettor_review(card, market, edge_pp, odds is not None)
            confidence = _confidence(card, market, edge_pp, blockers)
            rows.append({
                "game_id": game["id"],
                "sport_key": sport_key,
                "tournament": tournament,
                "commence_time": game.get("commence_time"),
                "home_team": home,
                "away_team": away,
                "team": card.get("team") or card.get("country"),
                "opponent": card.get("opponent") or (away if card.get("team") == home else home),
                "player_name": card["player_name"],
                "market": market,
                "model_prob": model_prob,
                "model_mean": model_mean,
                "book": odds.get("book") if odds else None,
                "book_odds": odds.get("price") if odds else None,
                "book_point": odds.get("point") if odds else None,
                "implied_prob": implied,
                "edge_pp": edge_pp,
                "decision": decision,
                "confidence_tier": confidence,
                "blocker_reasons": json.dumps(blockers, ensure_ascii=False),
                "bettor_notes": json.dumps(bettor_notes, ensure_ascii=False),
                "card_json": json.dumps(card, ensure_ascii=False),
                "context_json": json.dumps(card.get("context") or {}, ensure_ascii=False),
                "detected_at": now,
                "updated_at": now,
            })
    rows.sort(key=lambda r: (
        {"pick": 3, "lean": 2, "watch": 1, "pass": 0}.get(r["decision"], 0),
        r.get("edge_pp") if r.get("edge_pp") is not None else -99,
        r.get("model_prob") if r.get("model_prob") is not None else 0,
        r.get("model_mean") if r.get("model_mean") is not None else 0,
    ), reverse=True)
    return rows


def _upsert(conn: sqlite3.Connection, row: Dict[str, Any]) -> None:
    cols = [
        "game_id", "sport_key", "tournament", "commence_time", "home_team", "away_team",
        "team", "opponent", "player_name", "market", "model_prob", "model_mean",
        "book", "book_odds", "book_point", "implied_prob", "edge_pp", "decision",
        "confidence_tier", "blocker_reasons", "bettor_notes", "card_json", "context_json", "detected_at", "updated_at",
    ]
    values = [row.get(c) for c in cols]
    placeholders = ",".join("?" for _ in cols)
    updates = ", ".join(f"{c}=excluded.{c}" for c in cols if c not in {"game_id", "team", "player_name", "market", "book", "book_point", "detected_at"})
    conn.execute(
        f"""
        INSERT INTO soccer_prop_cards ({','.join(cols)}) VALUES ({placeholders})
        ON CONFLICT(game_id, team, player_name, market, COALESCE(book, '__model__'), COALESCE(book_point, -999))
        DO UPDATE SET {updates}
        WHERE soccer_prop_cards.status IN ('watch', 'lean', 'pick')
        """,
        values,
    )


def scan(
    db_path: Optional[Path] = None,
    horizon_hours: int = 72,
    *,
    with_market: bool = False,
    limit_per_team: int = 4,
    max_market_events: int = 8,
) -> Dict[str, Any]:
    init_db(db_path)
    ran_at = datetime.now(timezone.utc).isoformat()
    update_meta("job:prop_cards:last_run_at", ran_at, path=db_path)
    update_meta("job:prop_cards:last_error", "", path=db_path)
    summary: Dict[str, Any] = {
        "ran_at": ran_at,
        "horizon_hours": horizon_hours,
        "with_market": with_market,
        "leagues": {},
        "cards": 0,
        "priced_cards": 0,
        "market_events_checked": 0,
        "skipped": [],
    }
    conn = get_db(db_path)
    try:
        for sport_key, tournament, _active_until in LEAGUES:
            if tournament not in SUPPORTED_LEAGUES:
                continue
            try:
                raw_games = fetch_league_odds(sport_key)
            except Exception as e:
                summary["leagues"][tournament] = {"status": "fetch-error", "error": str(e), "games": 0, "cards": 0}
                continue
            games = filter_upcoming(raw_games, horizon_hours=horizon_hours)
            n_cards = 0
            for game in games:
                prop_odds: Dict[str, Dict[str, Any]] = {}
                if with_market and summary["market_events_checked"] < max_market_events:
                    try:
                        fetched = fetch_event_player_prop_odds(sport_key, game["id"])
                        prop_odds = fetched.get("odds") or {}
                        summary["market_events_checked"] += 1
                    except Exception as e:
                        summary["skipped"].append({"game_id": game.get("id"), "reason": f"prop-odds:{e}"})
                rows = cards_for_game(sport_key, tournament, game, prop_odds=prop_odds, limit_per_team=limit_per_team, db_path=db_path)
                if not rows:
                    summary["skipped"].append({"game_id": game.get("id"), "reason": "no-cards"})
                    continue
                for row in rows:
                    _upsert(conn, row)
                    n_cards += 1
                    summary["cards"] += 1
                    if row.get("book") is not None:
                        summary["priced_cards"] += 1
            summary["leagues"][tournament] = {"status": "ok", "games": len(games), "cards": n_cards}
        conn.commit()
        update_meta("job:prop_cards:market_events_checked", str(summary["market_events_checked"]), path=db_path)
        update_meta("job:prop_cards:priced_cards", str(summary["priced_cards"]), path=db_path)
        update_meta("job:prop_cards:last_mode", "market" if with_market else "context", path=db_path)
    except Exception as e:
        update_meta("job:prop_cards:last_error", str(e), path=db_path)
        raise
    finally:
        conn.close()
    return summary


def list_cards(db_path: Optional[Path] = None, limit: int = 30, decisions: Iterable[str] = ("pick", "lean", "watch")) -> List[Dict[str, Any]]:
    init_db(db_path)
    decs = list(decisions)
    conn = get_db(db_path)
    placeholders = ",".join("?" for _ in decs)
    rows = conn.execute(
        f"""
        SELECT * FROM soccer_prop_cards
        WHERE decision IN ({placeholders})
        ORDER BY CASE decision WHEN 'pick' THEN 0 WHEN 'lean' THEN 1 WHEN 'watch' THEN 2 ELSE 3 END,
                 COALESCE(edge_pp, -99) DESC,
                 COALESCE(model_prob, 0) DESC,
                 COALESCE(model_mean, 0) DESC,
                 updated_at DESC
        LIMIT ?
        """,
        (*decs, limit),
    ).fetchall()
    conn.close()
    out: List[Dict[str, Any]] = []
    for r in rows:
        d = dict(r)
        try:
            d["context"] = json.loads(d.pop("context_json") or "{}")
        except Exception:
            d["context"] = {}
        try:
            d["card"] = json.loads(d.pop("card_json") or "{}")
        except Exception:
            d["card"] = {}
        try:
            d["blocker_reasons"] = json.loads(d.get("blocker_reasons") or "[]")
        except Exception:
            d["blocker_reasons"] = []
        try:
            d["bettor_notes"] = json.loads(d.get("bettor_notes") or "[]")
        except Exception:
            d["bettor_notes"] = []
        out.append(d)
    return out


def stats(db_path: Optional[Path] = None) -> Dict[str, Any]:
    init_db(db_path)
    conn = get_db(db_path)
    rows = conn.execute("SELECT decision, COUNT(*) n FROM soccer_prop_cards GROUP BY decision").fetchall()
    priced = conn.execute("SELECT COUNT(*) FROM soccer_prop_cards WHERE book IS NOT NULL").fetchone()[0]
    top = conn.execute("SELECT MAX(edge_pp) FROM soccer_prop_cards WHERE edge_pp IS NOT NULL").fetchone()[0]
    conn.close()
    return {"by_decision": {r["decision"]: r["n"] for r in rows}, "priced": priced, "top_edge_pp": top}


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("cmd", choices=["scan", "list", "stats"])
    parser.add_argument("--horizon-hours", type=int, default=72)
    parser.add_argument("--with-market", action="store_true", help="Fetch per-event Odds API player-prop markets; costs credits")
    parser.add_argument("--limit", type=int, default=30)
    parser.add_argument("--limit-per-team", type=int, default=4)
    parser.add_argument("--max-market-events", type=int, default=8)
    args = parser.parse_args()
    if args.cmd == "scan":
        print(json.dumps(scan(horizon_hours=args.horizon_hours, with_market=args.with_market, limit_per_team=args.limit_per_team, max_market_events=args.max_market_events), indent=2, ensure_ascii=False))
    elif args.cmd == "list":
        print(json.dumps(list_cards(limit=args.limit), indent=2, ensure_ascii=False))
    else:
        print(json.dumps(stats(), indent=2, ensure_ascii=False))
