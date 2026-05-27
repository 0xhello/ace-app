#!/usr/bin/env python3
"""
candidates.py — internal soccer model candidate signal layer.

This is the Phase 4A bridge between the historical Big Five model and the
product. It does NOT publish subscriber picks. It scans live odds, compares
model probabilities against de-vigged book probabilities, and stores candidate
opportunities for operator review in the ops dashboard.

Flow:
  live odds + fitted model -> soccer_model_candidates -> ops review

Usage:
    python3 -m ml.soccer.candidates scan
    python3 -m ml.soccer.candidates list
"""
from __future__ import annotations

import json
import math
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from ml.soccer.leagues import LEAGUES, fetch_league_odds, filter_upcoming
from ml.soccer.model import get_db as get_form_db, load_fits, predict_match
from ml.world_cup.signal_logger import DB_PATH as DEFAULT_DB_PATH, update_meta

EDGE_THRESHOLD = 0.03
SUPPORTED_LEAGUES = {"Premier League", "La Liga", "Bundesliga", "Serie A", "Ligue 1"}
# Candidate rows are actionable routing targets, so Pinnacle is excluded here.
# We still use Pinnacle in the separate sharp-divergence engine; this layer is
# model-vs-playable-book opportunity review.
BOOKS_TO_COMPARE = ("fanduel", "draftkings", "betmgm", "williamhill_us", "betrivers", "caesars", "bet365")

# Minimal Odds API -> football-data/model aliases. Exact model names are kept
# as values because predict_match() requires the training-set names.
ALIASES: Dict[str, Dict[str, str]] = {
    "Premier League": {
        "Manchester United": "Man United",
        "Manchester City": "Man City",
        "Newcastle United": "Newcastle",
        "Tottenham Hotspur": "Tottenham",
        "Nottingham Forest": "Nott'm Forest",
        "Wolverhampton Wanderers": "Wolves",
        "West Ham United": "West Ham",
        "Brighton and Hove Albion": "Brighton",
        "Leeds United": "Leeds",
        "Leicester City": "Leicester",
    },
    "La Liga": {
        "Atletico Madrid": "Ath Madrid",
        "Athletic Bilbao": "Ath Bilbao",
        "Real Betis": "Betis",
        "Real Sociedad": "Sociedad",
        "Celta Vigo": "Celta",
        "Espanyol": "Espanol",
        "Alaves": "Alaves",
    },
    "Bundesliga": {
        "Bayern Munich": "Bayern Munich",
        "Borussia Dortmund": "Dortmund",
        "Eintracht Frankfurt": "Ein Frankfurt",
        "Borussia Monchengladbach": "M'gladbach",
        "FC Cologne": "FC Koln",
        "1. FC Köln": "FC Koln",
        "Cologne": "FC Koln",
        "Bayer Leverkusen": "Leverkusen",
        "VfB Stuttgart": "Stuttgart",
        "RB Leipzig": "RB Leipzig",
    },
    "Serie A": {
        "Internazionale": "Inter",
        "Inter Milan": "Inter",
        "AC Milan": "Milan",
        "Hellas Verona": "Verona",
        "AS Roma": "Roma",
        "Lazio": "Lazio",
    },
    "Ligue 1": {
        "Paris Saint-Germain": "Paris SG",
        "Paris SG": "Paris SG",
        "Olympique Marseille": "Marseille",
        "Olympique Lyonnais": "Lyon",
        "AS Monaco": "Monaco",
        "St Etienne": "St Etienne",
        "Saint-Etienne": "St Etienne",
    },
}


def get_db(path: Optional[Path] = None) -> sqlite3.Connection:
    p = path or DEFAULT_DB_PATH
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(p)
    conn.row_factory = sqlite3.Row
    return conn


def init_db(path: Optional[Path] = None) -> None:
    conn = get_db(path)
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS soccer_model_candidates (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            game_id            TEXT NOT NULL,
            sport_key          TEXT NOT NULL,
            tournament         TEXT NOT NULL,
            game_date          TEXT NOT NULL,
            home_team          TEXT NOT NULL,
            away_team          TEXT NOT NULL,
            model_home_team    TEXT NOT NULL,
            model_away_team    TEXT NOT NULL,
            commence_time      TEXT,
            market             TEXT NOT NULL,
            bet_side           TEXT NOT NULL,
            total_line         REAL,
            model_prob         REAL NOT NULL,
            book_prob          REAL NOT NULL,
            book_odds          REAL NOT NULL,
            book               TEXT NOT NULL,
            edge_pp            REAL NOT NULL,
            confidence_tier    TEXT NOT NULL,
            status             TEXT NOT NULL DEFAULT 'candidate',
            rationale_json     TEXT,
            review_notes       TEXT,
            reviewed_at        TEXT,
            home_score         INTEGER,
            away_score         INTEGER,
            result             TEXT,
            correct            INTEGER,
            graded_at          TEXT,
            exposed_to_beta    INTEGER NOT NULL DEFAULT 0,
            detected_at        TEXT NOT NULL,
            updated_at         TEXT NOT NULL,
            created_at         TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS uidx_soccer_model_candidate
          ON soccer_model_candidates(game_id, market, bet_side, COALESCE(total_line, -999), book);
        CREATE INDEX IF NOT EXISTS idx_soccer_model_candidates_status
          ON soccer_model_candidates(status, game_date);
        CREATE INDEX IF NOT EXISTS idx_soccer_model_candidates_edge
          ON soccer_model_candidates(edge_pp DESC);
        """
    )
    existing = {row["name"] for row in conn.execute("PRAGMA table_info(soccer_model_candidates)").fetchall()}
    if "review_notes" not in existing:
        conn.execute("ALTER TABLE soccer_model_candidates ADD COLUMN review_notes TEXT")
    if "reviewed_at" not in existing:
        conn.execute("ALTER TABLE soccer_model_candidates ADD COLUMN reviewed_at TEXT")
    for col, typ in [
        ("home_score", "INTEGER"), ("away_score", "INTEGER"),
        ("result", "TEXT"), ("correct", "INTEGER"), ("graded_at", "TEXT"),
    ]:
        if col not in existing:
            conn.execute(f"ALTER TABLE soccer_model_candidates ADD COLUMN {col} {typ}")
    conn.commit()
    conn.close()


def _american_to_raw_prob(odds: float) -> float:
    if odds < 0:
        return abs(odds) / (abs(odds) + 100.0)
    return 100.0 / (odds + 100.0)


def _devig(odds: List[float]) -> List[float]:
    raw = [_american_to_raw_prob(o) for o in odds]
    s = sum(raw)
    if s <= 0:
        return [1.0 / len(raw)] * len(raw)
    return [p / s for p in raw]


def _confidence(edge_pp: float) -> str:
    if edge_pp >= 0.07:
        return "A"
    if edge_pp >= 0.05:
        return "B"
    return "C"


def _et_game_date(commence_time: str) -> str:
    # Keep dependency-free here; UTC date is acceptable for internal candidate
    # storage and avoids importing zoneinfo in older Python environments.
    return datetime.fromisoformat(commence_time.replace("Z", "+00:00")).date().isoformat()


def _norm(s: str) -> str:
    return "".join(ch.lower() for ch in s if ch.isalnum())


def _resolve_team(league: str, raw: str, model_teams: Iterable[str]) -> Optional[str]:
    teams = list(model_teams)
    if raw in teams:
        return raw
    alias = ALIASES.get(league, {}).get(raw)
    if alias in teams:
        return alias
    nraw = _norm(raw)
    by_norm = {_norm(t): t for t in teams}
    if nraw in by_norm:
        return by_norm[nraw]
    # Conservative fuzzy fallback: only accept containment when unique.
    matches = [t for t in teams if nraw in _norm(t) or _norm(t) in nraw]
    return matches[0] if len(matches) == 1 else None


def _book_h2h_probs(game: Dict[str, Any], book_key: str) -> Optional[Dict[str, Dict[str, float]]]:
    home, away = game["home_team"], game["away_team"]
    for bm in game.get("bookmakers") or []:
        if bm.get("key") != book_key:
            continue
        for market in bm.get("markets") or []:
            if market.get("key") != "h2h":
                continue
            outcomes = {o.get("name"): float(o.get("price")) for o in market.get("outcomes") or [] if o.get("price") is not None}
            if home not in outcomes or away not in outcomes or "Draw" not in outcomes:
                return None
            probs = _devig([outcomes[home], outcomes["Draw"], outcomes[away]])
            return {
                "home": {"prob": probs[0], "odds": outcomes[home]},
                "draw": {"prob": probs[1], "odds": outcomes["Draw"]},
                "away": {"prob": probs[2], "odds": outcomes[away]},
            }
    return None


def _book_totals_probs(game: Dict[str, Any], book_key: str, line: float = 2.5) -> Optional[Dict[str, Dict[str, float]]]:
    for bm in game.get("bookmakers") or []:
        if bm.get("key") != book_key:
            continue
        for market in bm.get("markets") or []:
            if market.get("key") != "totals":
                continue
            over = under = None
            for o in market.get("outcomes") or []:
                try:
                    if abs(float(o.get("point", line)) - line) > 1e-9:
                        continue
                except Exception:
                    continue
                if o.get("name") == "Over":
                    over = o
                elif o.get("name") == "Under":
                    under = o
            if not over or not under:
                return None
            odds_o, odds_u = float(over["price"]), float(under["price"])
            probs = _devig([odds_o, odds_u])
            return {
                "over": {"prob": probs[0], "odds": odds_o},
                "under": {"prob": probs[1], "odds": odds_u},
            }
    return None


def _candidate_rows_for_game(
    sport_key: str,
    league: str,
    game: Dict[str, Any],
    fit: Any,
    form_conn: sqlite3.Connection,
) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    home_raw = game.get("home_team")
    away_raw = game.get("away_team")
    if not home_raw or not away_raw:
        return [], "missing-team"

    home = _resolve_team(league, home_raw, fit.alpha.keys())
    away = _resolve_team(league, away_raw, fit.alpha.keys())
    if not home or not away:
        return [], f"unmatched-team:{away_raw}@{home_raw}"

    pred = predict_match(
        fit, home, away, league=league, apply_adjustments=True,
        conn=form_conn, before_date=None,
    )
    if pred is None:
        return [], "prediction-none"

    now = datetime.now(timezone.utc).isoformat()
    base = {
        "game_id": game["id"],
        "sport_key": sport_key,
        "tournament": league,
        "game_date": _et_game_date(game["commence_time"]),
        "home_team": home_raw,
        "away_team": away_raw,
        "model_home_team": home,
        "model_away_team": away,
        "commence_time": game.get("commence_time"),
        "detected_at": now,
        "updated_at": now,
    }

    candidates: List[Dict[str, Any]] = []
    model_sides = {
        "h2h": {"home": pred["p_home"], "draw": pred["p_draw"], "away": pred["p_away"]},
        "totals": {"over": pred["over_2.5"], "under": pred["under_2.5"]},
    }

    for book in BOOKS_TO_COMPARE:
        h2h = _book_h2h_probs(game, book)
        if h2h:
            for side, model_prob in model_sides["h2h"].items():
                book_prob = h2h[side]["prob"]
                edge = model_prob - book_prob
                if edge >= EDGE_THRESHOLD:
                    candidates.append({
                        **base, "market": "h2h", "bet_side": side, "total_line": None,
                        "model_prob": model_prob, "book_prob": book_prob,
                        "book_odds": h2h[side]["odds"], "book": book,
                        "edge_pp": edge, "confidence_tier": _confidence(edge),
                        "rationale_json": json.dumps({
                            "source": "soccer_model_v1",
                            "lambda_h": pred.get("lambda_h"),
                            "lambda_a": pred.get("lambda_a"),
                            "adjustments": pred.get("_adj"),
                            "note": "Internal candidate only; not subscriber-facing.",
                        }),
                    })
        totals = _book_totals_probs(game, book, 2.5)
        if totals:
            for side, model_prob in model_sides["totals"].items():
                book_prob = totals[side]["prob"]
                edge = model_prob - book_prob
                if edge >= EDGE_THRESHOLD:
                    candidates.append({
                        **base, "market": "totals", "bet_side": side, "total_line": 2.5,
                        "model_prob": model_prob, "book_prob": book_prob,
                        "book_odds": totals[side]["odds"], "book": book,
                        "edge_pp": edge, "confidence_tier": _confidence(edge),
                        "rationale_json": json.dumps({
                            "source": "soccer_model_v1",
                            "lambda_h": pred.get("lambda_h"),
                            "lambda_a": pred.get("lambda_a"),
                            "adjustments": pred.get("_adj"),
                            "note": "Internal candidate only; not subscriber-facing.",
                        }),
                    })
    return candidates, None


def _upsert_candidate(conn: sqlite3.Connection, row: Dict[str, Any]) -> int:
    cols = [
        "game_id", "sport_key", "tournament", "game_date", "home_team", "away_team",
        "model_home_team", "model_away_team", "commence_time", "market", "bet_side",
        "total_line", "model_prob", "book_prob", "book_odds", "book", "edge_pp",
        "confidence_tier", "rationale_json", "detected_at", "updated_at",
    ]
    values = [row.get(c) for c in cols]
    placeholders = ",".join("?" for _ in cols)
    updates = ", ".join(
        f"{c}=excluded.{c}" for c in cols
        if c not in {"game_id", "market", "bet_side", "total_line", "book", "detected_at"}
    )
    sql = f"""
        INSERT INTO soccer_model_candidates ({','.join(cols)}) VALUES ({placeholders})
        ON CONFLICT(game_id, market, bet_side, COALESCE(total_line, -999), book)
        DO UPDATE SET {updates}, updated_at=excluded.updated_at
        WHERE soccer_model_candidates.status IN ('candidate', 'watching')
    """
    cur = conn.execute(sql, values)
    return cur.lastrowid or 0


def scan(db_path: Optional[Path] = None, horizon_hours: int = 72) -> Dict[str, Any]:
    init_db(db_path)
    ran_at = datetime.now(timezone.utc).isoformat()
    update_meta("job:candidates:last_run_at", ran_at, path=db_path)
    update_meta("job:candidates:last_error", "", path=db_path)
    fits, _elos = load_fits()
    form_conn = get_form_db()
    conn = get_db(db_path)

    summary: Dict[str, Any] = {
        "ran_at": ran_at,
        "horizon_hours": horizon_hours,
        "threshold_pp": EDGE_THRESHOLD,
        "leagues": {},
        "inserted_or_updated": 0,
        "skipped": [],
    }

    try:
        for sport_key, league, active_until in LEAGUES:
            if league not in SUPPORTED_LEAGUES:
                continue
            fit = fits.get(league)
            if fit is None:
                summary["leagues"][league] = {"status": "no-fit", "games": 0, "candidates": 0}
                continue
            try:
                raw_games = fetch_league_odds(sport_key)
            except Exception as e:
                summary["leagues"][league] = {"status": "fetch-error", "error": str(e), "games": 0, "candidates": 0}
                continue
            games = filter_upcoming(raw_games, horizon_hours=horizon_hours)
            n_candidates = 0
            for game in games:
                rows, skip = _candidate_rows_for_game(sport_key, league, game, fit, form_conn)
                if skip:
                    summary["skipped"].append({"league": league, "game_id": game.get("id"), "reason": skip})
                    continue
                # Collapse book-level rows into one candidate per opportunity.
                # The chosen row is the current best route: largest edge, then
                # longest American price as a tie-breaker. We still keep book
                # and odds so the operator sees where to play it.
                best_by_key: Dict[Tuple[Any, ...], Dict[str, Any]] = {}
                for row in rows:
                    key = (row["game_id"], row["market"], row["bet_side"], row.get("total_line"))
                    prev = best_by_key.get(key)
                    if prev is None or (row["edge_pp"], row["book_odds"]) > (prev["edge_pp"], prev["book_odds"]):
                        best_by_key[key] = row
                for row in best_by_key.values():
                    _upsert_candidate(conn, row)
                    n_candidates += 1
                    summary["inserted_or_updated"] += 1
            summary["leagues"][league] = {"status": "ok", "games": len(games), "candidates": n_candidates}
        conn.commit()
    except Exception as e:
        update_meta("job:candidates:last_error", str(e), path=db_path)
        raise
    finally:
        form_conn.close()
        conn.close()
    return summary


def backfill_from_form(
    days_back: int = 45,
    db_path: Optional[Path] = None,
    *,
    min_edge_pp: float = 0.03,
    max_edge_pp: float = 0.20,
) -> Dict[str, Any]:
    """One-shot backfill that mints model candidates retrospectively for
    recently-completed Big 5 matches we already have in `soccer_team_form`.
    Picks are graded immediately using the real result.

    Refits the model on training data PRIOR to the backfill window so all
    backfilled picks are genuine out-of-sample predictions — same protocol
    as the held-out backtest. The persisted model artifact (used for live
    predictions) stays untouched; we only build a temporary fit in memory.

    Idempotent: skips matches that already have a candidate on game_id.

    Args:
      days_back   how far back to scan
      min_edge_pp lower edge bound for emitting a candidate
      max_edge_pp upper bound (anything above is treated as model
                  over-extension, suppressed — same ceiling the
                  subscriber loader uses)
    """
    import hashlib
    from datetime import timedelta
    from ml.soccer.model import fit_dixon_coles, predict_match

    init_db(db_path)

    target_path = db_path or DEFAULT_DB_PATH
    conn = get_db(target_path)

    # One-time cleanup: earlier backfill iterations stored book='pinnacle',
    # which list_candidates explicitly excludes (US subscribers can't bet
    # Pinnacle). Clear those legacy rows so the new run re-inserts under
    # book='market_close'. Safe — these are deterministic and reproducible
    # from the same form data + model fit.
    conn.execute(
        "DELETE FROM soccer_model_candidates "
        "WHERE book = 'pinnacle' AND rationale_json LIKE '%backfill%'"
    )
    conn.commit()

    cutoff = (datetime.now(timezone.utc) - timedelta(days=int(days_back))).strftime("%Y-%m-%d")

    # Fit a backfill-specific model: training set ENDS at the cutoff date
    # so every backfilled match is strictly out-of-sample. This is the same
    # split protocol the held-out backtest uses (no leakage).
    print(f"  [backfill] Fitting out-of-sample model with train_before={cutoff}…", flush=True)
    fits: Dict[str, Any] = {}
    for sport_key, league, _active_until in LEAGUES:
        if league not in SUPPORTED_LEAGUES:
            continue
        f = fit_dixon_coles(league, conn, reference_date=cutoff, train_before=cutoff)
        if f is not None:
            fits[league] = f
    if not fits:
        return {"ok": False, "reason": "model-refit-failed", "candidates": 0}

    matches = conn.execute(
        """SELECT match_date, team_name AS home, opponent AS away, league,
                  goals_for AS gh, goals_against AS ga,
                  close_home_odds, close_draw_odds, close_away_odds,
                  close_ou_line, close_over_odds, close_under_odds
           FROM soccer_team_form
           WHERE venue = 'home'
             AND match_date >= ?
             AND goals_for IS NOT NULL AND goals_against IS NOT NULL
             AND league IN ('Premier League', 'La Liga', 'Bundesliga', 'Serie A', 'Ligue 1')
           ORDER BY match_date ASC""",
        (cutoff,),
    ).fetchall()

    inserted = graded = skipped_existing = skipped_noedge = skipped_unmatched = 0
    sport_keys = {label: key for key, label, _u in LEAGUES}
    now = datetime.now(timezone.utc).isoformat()

    for m in matches:
        league = m["league"]
        if league not in fits:
            skipped_unmatched += 1
            continue
        fit = fits[league]
        # Use team names as-is — football-data names align with our fitted team list
        if m["home"] not in fit.alpha or m["away"] not in fit.alpha:
            skipped_unmatched += 1
            continue

        # Deterministic game_id so re-runs dedupe naturally
        game_id = hashlib.md5(
            f"backfill|{m['match_date']}|{m['home']}|{m['away']}".encode("utf-8")
        ).hexdigest()

        # Skip if we already backfilled this match
        already = conn.execute(
            "SELECT 1 FROM soccer_model_candidates WHERE game_id = ? LIMIT 1",
            (game_id,),
        ).fetchone()
        if already:
            skipped_existing += 1
            continue

        pred = predict_match(
            fit, m["home"], m["away"], league=league,
            apply_adjustments=True, conn=conn,
            before_date=m["match_date"],  # no leakage — only data BEFORE the match
        )
        if not pred:
            skipped_unmatched += 1
            continue

        # ── h2h ──
        if all([m["close_home_odds"], m["close_draw_odds"], m["close_away_odds"]]):
            book_devig = _devig([m["close_home_odds"], m["close_draw_odds"], m["close_away_odds"]])
            actual_h = 1 if m["gh"] > m["ga"] else 0
            actual_d = 1 if m["gh"] == m["ga"] else 0
            actual_a = 1 if m["gh"] < m["ga"] else 0
            for side, model_p, book_p, book_o, actual in [
                ("home", pred["p_home"], book_devig[0], m["close_home_odds"], actual_h),
                ("draw", pred["p_draw"], book_devig[1], m["close_draw_odds"], actual_d),
                ("away", pred["p_away"], book_devig[2], m["close_away_odds"], actual_a),
            ]:
                edge = model_p - book_p
                if edge < min_edge_pp or edge > max_edge_pp:
                    continue
                tier = "A" if edge >= 0.10 else "B" if edge >= 0.07 else "C"
                conn.execute(
                    """INSERT INTO soccer_model_candidates
                       (game_id, sport_key, tournament, game_date, home_team, away_team,
                        model_home_team, model_away_team, commence_time,
                        market, bet_side, total_line,
                        model_prob, book_prob, book_odds, book, edge_pp,
                        confidence_tier, status, rationale_json,
                        home_score, away_score, result, correct, graded_at,
                        detected_at, updated_at)
                       VALUES (?,?,?,?,?,?, ?,?,?, ?,?,?, ?,?,?,?,?, ?,?,?, ?,?,?,?,?, ?,?)""",
                    (game_id, sport_keys.get(league, "soccer"), league, m["match_date"],
                     m["home"], m["away"], m["home"], m["away"], None,
                     "h2h", side, None,
                     model_p, book_p, _dec_to_amer(book_o), "market_close", edge,
                     tier, "graded",
                     json.dumps({"backfill": True, "source": "soccer_model_v1+shrinkage",
                                "lambda_h": pred["lambda_h"], "lambda_a": pred["lambda_a"]}),
                     int(m["gh"]), int(m["ga"]),
                     ("home" if m["gh"] > m["ga"] else "draw" if m["gh"] == m["ga"] else "away"),
                     actual, now,
                     now, now),
                )
                inserted += 1
                graded += 1

        # ── totals over/under (only the 2.5 line that football-data carries) ──
        line = m["close_ou_line"]
        if (
            m["close_over_odds"] and m["close_under_odds"]
            and line is not None and abs(float(line) - 2.5) < 0.01
        ):
            book_tot = _devig([m["close_over_odds"], m["close_under_odds"]])
            total = m["gh"] + m["ga"]
            actual_over = 1 if total > 2.5 else 0
            actual_under = 1 if total < 2.5 else 0
            for side, model_p, book_p, book_o, actual in [
                ("over",  pred["over_2.5"],  book_tot[0], m["close_over_odds"],  actual_over),
                ("under", pred["under_2.5"], book_tot[1], m["close_under_odds"], actual_under),
            ]:
                edge = model_p - book_p
                if edge < min_edge_pp or edge > max_edge_pp:
                    continue
                tier = "A" if edge >= 0.10 else "B" if edge >= 0.07 else "C"
                conn.execute(
                    """INSERT INTO soccer_model_candidates
                       (game_id, sport_key, tournament, game_date, home_team, away_team,
                        model_home_team, model_away_team, commence_time,
                        market, bet_side, total_line,
                        model_prob, book_prob, book_odds, book, edge_pp,
                        confidence_tier, status, rationale_json,
                        home_score, away_score, result, correct, graded_at,
                        detected_at, updated_at)
                       VALUES (?,?,?,?,?,?, ?,?,?, ?,?,?, ?,?,?,?,?, ?,?,?, ?,?,?,?,?, ?,?)""",
                    (game_id, sport_keys.get(league, "soccer"), league, m["match_date"],
                     m["home"], m["away"], m["home"], m["away"], None,
                     "totals", side, 2.5,
                     model_p, book_p, _dec_to_amer(book_o), "market_close", edge,
                     tier, "graded",
                     json.dumps({"backfill": True, "source": "soccer_model_v1+shrinkage",
                                "lambda_h": pred["lambda_h"], "lambda_a": pred["lambda_a"],
                                "actual_total": int(total)}),
                     int(m["gh"]), int(m["ga"]),
                     ("over" if total > 2.5 else "under"),
                     actual, now,
                     now, now),
                )
                inserted += 1
                graded += 1
        else:
            skipped_noedge += 1

    conn.commit()
    conn.close()
    summary = {
        "ok": True,
        "ran_at": now,
        "days_back": days_back,
        "matches_examined": len(matches),
        "candidates_inserted": inserted,
        "candidates_graded": graded,
        "skipped_existing": skipped_existing,
        "skipped_unmatched_team": skipped_unmatched,
        "skipped_no_edge": skipped_noedge,
    }
    try:
        update_meta("job:soccer_backfill:last_run_at", now, path=target_path)
        update_meta("job:soccer_backfill:last_summary", json.dumps(summary), path=target_path)
    except Exception:
        pass
    return summary


def _dec_to_amer(decimal_odds: float) -> float:
    """football-data carries DECIMAL odds; our candidate schema stores
    American. Convert: 1.50 dec = -200 amer, 3.00 dec = +200 amer."""
    if decimal_odds <= 1.0:
        return -10000.0
    if decimal_odds >= 2.0:
        return round((decimal_odds - 1.0) * 100.0, 1)
    return round(-100.0 / (decimal_odds - 1.0), 1)


def list_candidates(db_path: Optional[Path] = None, limit: int = 50) -> List[Dict[str, Any]]:
    init_db(db_path)
    conn = get_db(db_path)
    rows = conn.execute(
        """
        WITH ranked AS (
          SELECT *,
                 ROW_NUMBER() OVER (
                   PARTITION BY game_id, market, bet_side, COALESCE(total_line, -999)
                   ORDER BY edge_pp DESC, book_odds DESC, updated_at DESC
                 ) AS rn
          FROM soccer_model_candidates
          WHERE book != 'pinnacle'
        )
        SELECT * FROM ranked
        WHERE rn = 1
        ORDER BY CASE status WHEN 'approved' THEN 0 WHEN 'candidate' THEN 1 WHEN 'watching' THEN 2 WHEN 'graded' THEN 3 ELSE 4 END,
                 edge_pp DESC, updated_at DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    conn.close()
    out = []
    for r in rows:
        d = dict(r)
        d.pop("rn", None)
        out.append(d)
    return out


def _stake_units(edge_pp: float, tier: str) -> float:
    """Conservative internal stake suggestion.

    This is intentionally simple until we have live model-candidate history.
    It gives us an actual-pick card without pretending the model is calibrated
    enough for full Kelly sizing yet.
    """
    if tier == "A" and edge_pp >= 0.10:
        return 1.0
    if tier in ("A", "B") and edge_pp >= 0.05:
        return 0.5
    return 0.25


def _pick_title(row: Dict[str, Any]) -> str:
    if row["market"] == "totals":
        line = row.get("total_line") if row.get("total_line") is not None else 2.5
        return f"{row['bet_side'].upper()} {line}"
    if row["market"] == "h2h":
        if row["bet_side"] == "draw":
            return "Draw"
        return row["home_team"] if row["bet_side"] == "home" else row["away_team"]
    return row["bet_side"].upper()


def _to_pick(row: Dict[str, Any], source: str) -> Dict[str, Any]:
    return {
        "id": row["id"],
        "source": source,  # approved | shortlist
        "status": row["status"],
        "tournament": row["tournament"],
        "game_date": row["game_date"],
        "commence_time": row.get("commence_time"),
        "matchup": f"{row['away_team']} @ {row['home_team']}",
        "market": row["market"],
        "pick": _pick_title(row),
        "book": row["book"],
        "odds": row["book_odds"],
        "model_prob": row["model_prob"],
        "market_prob": row["book_prob"],
        "edge_pp": row["edge_pp"],
        "confidence_tier": row["confidence_tier"],
        "stake_units": _stake_units(float(row["edge_pp"]), row["confidence_tier"]),
        "reason": (
            f"Model gives {_pick_title(row)} {row['model_prob']*100:.1f}% vs "
            f"market {row['book_prob']*100:.1f}% at {row['book']}."
        ),
        "correct": row.get("correct"),
        "result": row.get("result"),
    }


def list_actual_picks(db_path: Optional[Path] = None, limit: int = 10, include_shortlist: bool = True) -> List[Dict[str, Any]]:
    """Clean internal picks feed.

    Approved rows are actual ACE picks. Until an operator approves rows, we
    optionally return a conservative `shortlist` so the dashboard has the
    plain-English pick cards Pixl asked for without pretending they are final.
    """
    candidates = list_candidates(db_path, limit=80)
    approved = [c for c in candidates if c.get("status") == "approved"]
    rows = approved
    source = "approved"
    if not rows and include_shortlist:
        rows = [
            c for c in candidates
            if c.get("status") in ("candidate", "watching")
            and c.get("confidence_tier") in ("A", "B")
            and float(c.get("edge_pp") or 0) >= 0.05
        ]
        source = "shortlist"
    return [_to_pick(r, source if r not in approved else "approved") for r in rows[:limit]]


ALLOWED_STATUSES = {"candidate", "watching", "approved", "rejected", "expired", "graded"}
TOURNAMENT_TO_SPORT_KEY = {league: sport_key for sport_key, league, _active_until in LEAGUES}


def _parse_score(scores_list: Optional[List[Dict[str, Any]]], team_name: str) -> Optional[int]:
    if not scores_list:
        return None
    for entry in scores_list:
        if entry.get("name") == team_name:
            try:
                return int(entry["score"])
            except (KeyError, ValueError, TypeError):
                return None
    return None


def _result_for_candidate(row: Dict[str, Any], home_score: int, away_score: int) -> Tuple[str, Optional[int]]:
    market = row["market"]
    side = row["bet_side"]
    if market == "h2h":
        result = "home" if home_score > away_score else "away" if away_score > home_score else "draw"
        return result, 1 if side == result else 0
    if market == "totals":
        line = row.get("total_line") if row.get("total_line") is not None else 2.5
        total = home_score + away_score
        if abs(total - float(line)) < 1e-9:
            return "push", None
        result = "over" if total > float(line) else "under"
        return result, 1 if side == result else 0
    return "unknown", None


def grade_candidates(db_path: Optional[Path] = None, days_back: int = 3) -> Dict[str, Any]:
    """Grade internal model candidates against completed Odds API scores.

    Grades candidate/watching/approved rows only. Rejected/expired rows remain
    untouched; this preserves operator intent.
    """
    from ml.world_cup.fetch_signals import fetch_scores_for_sport

    init_db(db_path)
    conn = get_db(db_path)
    rows = [dict(r) for r in conn.execute(
        """
        SELECT * FROM soccer_model_candidates
        WHERE status IN ('candidate', 'watching', 'approved')
        ORDER BY game_date ASC, edge_pp DESC
        """
    ).fetchall()]

    summary: Dict[str, Any] = {
        "ran_at": datetime.now(timezone.utc).isoformat(),
        "checked": len(rows),
        "graded": 0,
        "wins": 0,
        "losses": 0,
        "voids": 0,
        "not_found": 0,
        "sports": {},
    }
    if not rows:
        conn.close()
        return summary

    by_sport: Dict[str, List[Dict[str, Any]]] = {}
    for r in rows:
        sport_key = r.get("sport_key") or TOURNAMENT_TO_SPORT_KEY.get(r.get("tournament"), "soccer_fifa_world_cup")
        by_sport.setdefault(sport_key, []).append(r)

    now = datetime.now(timezone.utc).isoformat()
    try:
        for sport_key, sport_rows in by_sport.items():
            try:
                score_games = fetch_scores_for_sport(sport_key, days_back)
            except Exception as e:
                summary["sports"][sport_key] = {"error": str(e), "completed": 0}
                continue
            completed = [g for g in score_games if g.get("completed")]
            score_map = {g["id"]: g for g in completed}
            summary["sports"][sport_key] = {"completed": len(completed)}

            for row in sport_rows:
                game = score_map.get(row["game_id"])
                if game is None:
                    for g in completed:
                        if g.get("home_team") == row["home_team"] and g.get("away_team") == row["away_team"]:
                            game = g
                            break
                if game is None:
                    summary["not_found"] += 1
                    continue
                home_score = _parse_score(game.get("scores"), game["home_team"])
                away_score = _parse_score(game.get("scores"), game["away_team"])
                if home_score is None or away_score is None:
                    summary["not_found"] += 1
                    continue
                result, correct = _result_for_candidate(row, home_score, away_score)
                conn.execute(
                    """
                    UPDATE soccer_model_candidates
                    SET status = 'graded', home_score = ?, away_score = ?, result = ?,
                        correct = ?, graded_at = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (home_score, away_score, result, correct, now, now, row["id"]),
                )
                summary["graded"] += 1
                if correct == 1:
                    summary["wins"] += 1
                elif correct == 0:
                    summary["losses"] += 1
                else:
                    summary["voids"] += 1
        conn.commit()
    finally:
        conn.close()
    return summary


def update_candidate_status(
    candidate_id: int,
    status: str,
    notes: Optional[str] = None,
    db_path: Optional[Path] = None,
) -> Optional[Dict[str, Any]]:
    """Operator lifecycle update for internal model candidates.

    This intentionally does not publish anything to subscribers. `approved`
    means approved for internal tracking/review; beta exposure will be a later,
    explicit promotion step.
    """
    if status not in ALLOWED_STATUSES:
        raise ValueError(f"invalid status: {status}")
    init_db(db_path)
    now = datetime.now(timezone.utc).isoformat()
    conn = get_db(db_path)
    row = conn.execute(
        "SELECT * FROM soccer_model_candidates WHERE id = ?",
        (candidate_id,),
    ).fetchone()
    if row is None:
        conn.close()
        return None
    conn.execute(
        """
        UPDATE soccer_model_candidates
        SET status = ?, review_notes = COALESCE(?, review_notes),
            reviewed_at = ?, updated_at = ?
        WHERE id = ?
        """,
        (status, notes, now, now, candidate_id),
    )
    conn.commit()
    updated = conn.execute(
        "SELECT * FROM soccer_model_candidates WHERE id = ?",
        (candidate_id,),
    ).fetchone()
    conn.close()
    return dict(updated) if updated is not None else None


def stats(db_path: Optional[Path] = None) -> Dict[str, Any]:
    init_db(db_path)
    conn = get_db(db_path)
    rows = conn.execute(
        """
        WITH ranked AS (
          SELECT status, edge_pp, correct,
                 ROW_NUMBER() OVER (
                   PARTITION BY game_id, market, bet_side, COALESCE(total_line, -999)
                   ORDER BY edge_pp DESC, book_odds DESC, updated_at DESC
                 ) AS rn
          FROM soccer_model_candidates
          WHERE book != 'pinnacle'
        )
        SELECT status, COUNT(*) n FROM ranked WHERE rn = 1 GROUP BY status
        """
    ).fetchall()
    top = conn.execute("SELECT MAX(edge_pp) FROM soccer_model_candidates WHERE book != 'pinnacle'").fetchone()[0]
    graded_rows = conn.execute(
        """
        WITH ranked AS (
          SELECT correct,
                 ROW_NUMBER() OVER (
                   PARTITION BY game_id, market, bet_side, COALESCE(total_line, -999)
                   ORDER BY edge_pp DESC, book_odds DESC, updated_at DESC
                 ) AS rn
          FROM soccer_model_candidates
          WHERE book != 'pinnacle' AND status = 'graded'
        )
        SELECT correct, COUNT(*) n FROM ranked WHERE rn = 1 GROUP BY correct
        """
    ).fetchall()
    conn.close()
    by_status = {r["status"]: r["n"] for r in rows}
    by_result = {str(r["correct"]): r["n"] for r in graded_rows}
    wins = by_result.get("1", 0)
    losses = by_result.get("0", 0)
    graded = wins + losses + by_result.get("None", 0)
    return {
        "total": sum(by_status.values()),
        "by_status": by_status,
        "top_edge_pp": top,
        "record": {
            "graded": graded,
            "wins": wins,
            "losses": losses,
            "win_rate": (wins / (wins + losses)) if (wins + losses) else None,
        },
    }


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("cmd", choices=["scan", "list", "picks", "status", "grade"])
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument("--horizon-hours", type=int, default=72)
    parser.add_argument("--id", type=int)
    parser.add_argument("--status")
    parser.add_argument("--notes")
    args = parser.parse_args()
    if args.cmd == "scan":
        print(json.dumps(scan(horizon_hours=args.horizon_hours), indent=2))
    elif args.cmd == "grade":
        print(json.dumps(grade_candidates(days_back=3), indent=2))
    elif args.cmd == "status":
        if args.id is None or not args.status:
            raise SystemExit("status requires --id and --status")
        print(json.dumps(update_candidate_status(args.id, args.status, args.notes), indent=2))
    elif args.cmd == "picks":
        print(json.dumps(list_actual_picks(limit=args.limit), indent=2))
    else:
        print(json.dumps(list_candidates(limit=args.limit), indent=2))
