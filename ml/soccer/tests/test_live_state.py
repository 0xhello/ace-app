from __future__ import annotations

from pathlib import Path


def test_sportmonks_feature_parser_extracts_role_features(tmp_path: Path) -> None:
    from ml.soccer.live_state import _player_feature_rows

    payload = {
        "participants": [
            {"id": 1, "name": "Arsenal", "meta": {"location": "home"}},
            {"id": 2, "name": "Chelsea", "meta": {"location": "away"}},
        ],
        "lineups": [{
            "player_id": 7,
            "team_id": 1,
            "type_id": 11,
            "formation_field": "4:3",
            "player": {"id": 7, "display_name": "Ace Winger"},
            "position": {"name": "Attacker"},
            "details": [{"type": {"name": "Shots On Target"}, "value": 2}],
        }],
    }
    rows = _player_feature_rows(payload, game_id="g", provider_fixture_id="sm-1")
    assert rows[0]["position_bucket"] == "attacker"
    assert rows[0]["formation_line"] == 4
    assert rows[0]["is_attacking_role"] is True
    assert rows[0]["shots_on_target"] == 2


def test_live_state_upgrades_card_role_context(tmp_path: Path) -> None:
    from ml.soccer.live_state import apply_live_state_to_card, upsert_player_features, upsert_player_state

    db = tmp_path / "wc_signal_log.db"
    upsert_player_state({
        "game_id": "game-1",
        "provider": "manual",
        "team": "Arsenal",
        "opponent": "Chelsea",
        "player_name": "Ace Striker",
        "lineup_status": "confirmed_starting",
        "projected_minutes": 82,
        "penalty_role": "primary",
        "availability": "available",
    }, db)

    upsert_player_features({
        "game_id": "game-1",
        "provider": "manual",
        "team": "Arsenal",
        "opponent": "Chelsea",
        "player_name": "Ace Striker",
        "lineup_status": "confirmed_starting",
        "projected_minutes": 82,
        "availability": "available",
        "position": "Attacker",
        "position_bucket": "attacker",
        "formation_field": "4:2",
        "formation_line": 4,
        "attack_role_score": 0.91,
        "is_attacking_role": True,
    }, db)

    card = {
        "team": "Arsenal",
        "player_name": "Ace Striker",
        "context": {"role_today": {"lineup_status": "projected_unknown", "penalty_role": "unknown", "assumed_minutes": 65}},
    }
    out = apply_live_state_to_card(card, "game-1", db)
    role = out["context"]["role_today"]
    assert role["lineup_status"] == "confirmed_starting"
    assert role["penalty_role"] == "primary"
    assert role["assumed_minutes"] == 82
    assert role["position_bucket"] == "attacker"
    assert role["attack_role_score"] == 0.91


def test_bettor_review_blocks_unavailable_player() -> None:
    from ml.soccer.prop_cards import _bettor_review

    card = {
        "sample_confidence": "high",
        "anytime_scorer_prob": 0.42,
        "shots_mean": 4.0,
        "context": {
            "role_today": {"lineup_status": "out", "availability": "out", "penalty_role": "primary"},
            "team_environment": {"projected_team_goals": 2.2},
            "opponent_weakness": {"grade": "soft", "recent_xg_against": 1.8},
        },
    }
    decision, blockers, _notes = _bettor_review(card, "anytime_scorer", edge_pp=0.12, priced=True)
    assert decision == "watch"
    assert "player_unavailable" in blockers


def test_bettor_review_promotes_with_live_state_and_price(tmp_path: Path) -> None:
    from ml.soccer.understat_cache import PROVIDER, get_db, init_tables
    from ml.soccer.live_state import upsert_player_state
    from ml.soccer.prop_cards import cards_for_game

    db = tmp_path / "wc_signal_log.db"
    init_tables(db)
    conn = get_db(db)
    conn.execute(
        """
        INSERT INTO soccer_source_player_stats
        (provider, league, season, player_name, team, position, appearances, minutes, goals, shots, xg, raw_json)
        VALUES (?, 'ENG-Premier League', '2425', 'Ace Striker', 'Arsenal', 'F', 30, 2400, 22, 120, 24.0, '{}')
        """,
        (PROVIDER,),
    )
    for i in range(10):
        conn.execute(
            """
            INSERT INTO soccer_source_team_match_stats
            (provider, league, season, game_id, match_date, team, opponent, venue, goals_for, goals_against, xg_for, xg_against, raw_json)
            VALUES (?, 'ENG-Premier League', '2425', ?, '2025-05-01', 'Arsenal', 'Chelsea', 'home', 3, 1, 2.4, 0.9, '{}')
            """,
            (PROVIDER, f"a{i}"),
        )
        conn.execute(
            """
            INSERT INTO soccer_source_team_match_stats
            (provider, league, season, game_id, match_date, team, opponent, venue, goals_for, goals_against, xg_for, xg_against, raw_json)
            VALUES (?, 'ENG-Premier League', '2425', ?, '2025-05-01', 'Chelsea', 'Arsenal', 'away', 1, 3, 0.9, 1.9, '{}')
            """,
            (PROVIDER, f"c{i}"),
        )
    conn.commit(); conn.close()

    upsert_player_state({
        "game_id": "game-2",
        "provider": "manual",
        "team": "Arsenal",
        "opponent": "Chelsea",
        "player_name": "Ace Striker",
        "lineup_status": "confirmed_starting",
        "projected_minutes": 82,
        "penalty_role": "primary",
        "availability": "available",
    }, db)

    game = {
        "id": "game-2",
        "home_team": "Arsenal",
        "away_team": "Chelsea",
        "commence_time": "2026-05-25T19:00:00Z",
        "bookmakers": [{"key": "draftkings", "markets": [
            {"key": "totals", "outcomes": [{"name": "Over", "point": 3.0, "price": -110}, {"name": "Under", "point": 3.0, "price": -110}]},
            {"key": "h2h", "outcomes": [{"name": "Arsenal", "price": -220}, {"name": "Draw", "price": 330}, {"name": "Chelsea", "price": 600}]},
        ]}],
    }
    prop_odds = {"Ace Striker": {"player_goal_scorer_anytime": {"book": "draftkings", "price": 450, "point": None}}}

    import ml.soccer.player_props as pp
    old = pp.DB_PATH
    pp.DB_PATH = db
    try:
        rows = cards_for_game("soccer_epl", "Premier League", game, prop_odds=prop_odds, limit_per_team=1, db_path=db)
    finally:
        pp.DB_PATH = old

    scorer = next(r for r in rows if r["player_name"] == "Ace Striker" and r["market"] == "anytime_scorer")
    assert scorer["book"] == "draftkings"
    assert scorer["decision"] in {"pick", "lean"}
    assert "lineup_unknown" not in scorer["blocker_reasons"]


def test_team_match_aliases() -> None:
    from ml.soccer.live_state import _team_match

    assert _team_match("Saint Etienne", "Saint-Étienne")
    assert _team_match("Paris Saint Germain", "PSG")
    assert _team_match("SC Paderborn", "Paderborn")


def test_fixture_mapping_round_trip(tmp_path: Path) -> None:
    from ml.soccer.live_state import fixture_mappings, upsert_fixture_mapping

    db = tmp_path / "wc_signal_log.db"
    upsert_fixture_mapping({
        "game_id": "odds-game-1",
        "sport_key": "soccer_epl",
        "provider": "sportmonks",
        "provider_fixture_id": "12345",
        "home_team": "Arsenal",
        "away_team": "Chelsea",
        "commence_time": "2026-05-25T19:00:00Z",
    }, db)
    rows = fixture_mappings(db)
    assert len(rows) == 1
    assert rows[0]["game_id"] == "odds-game-1"
    assert rows[0]["provider_fixture_id"] == "12345"


def test_grade_prop_cards_from_player_results(tmp_path: Path) -> None:
    from ml.soccer.prop_cards import get_db, init_db
    from ml.soccer.live_state import grade_prop_cards, upsert_player_result

    db = tmp_path / "wc_signal_log.db"
    init_db(db)
    conn = get_db(db)
    conn.execute(
        """
        INSERT INTO soccer_prop_cards
        (game_id, sport_key, tournament, home_team, away_team, team, opponent, player_name, market,
         model_prob, decision, confidence_tier, card_json, context_json, detected_at, updated_at)
        VALUES ('game-3', 'soccer_epl', 'Premier League', 'Arsenal', 'Chelsea', 'Arsenal', 'Chelsea',
                'Ace Striker', 'anytime_scorer', 0.31, 'pick', 'A', '{}', '{}', 'now', 'now')
        """
    )
    conn.commit(); conn.close()

    upsert_player_result({
        "game_id": "game-3",
        "provider": "manual",
        "team": "Arsenal",
        "player_name": "Ace Striker",
        "minutes": 88,
        "goals": 1,
        "shots": 4,
        "shots_on_target": 2,
    }, db)
    result = grade_prop_cards(db)
    assert result["graded"] == 1
    conn = get_db(db)
    row = conn.execute("SELECT result_value, result_hit, status FROM soccer_prop_cards").fetchone()
    conn.close()
    assert row["result_value"] == 1
    assert row["result_hit"] == 1
    assert row["status"] == "graded"
