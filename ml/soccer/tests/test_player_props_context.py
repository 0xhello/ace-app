from __future__ import annotations

from pathlib import Path


def test_matchup_prop_context_cards_have_variables(tmp_path: Path) -> None:
    from ml.soccer.understat_cache import init_tables, get_db, PROVIDER
    from ml.soccer.player_props import matchup_prop_context_cards

    db = tmp_path / "wc_signal_log.db"
    init_tables(db)
    conn = get_db(db)
    conn.execute(
        """
        INSERT INTO soccer_source_player_stats
        (provider, league, season, player_name, team, position, appearances, minutes, goals, shots, xg, raw_json)
        VALUES (?, 'ENG-Premier League', '2425', 'Ace Striker', 'Arsenal', 'F', 20, 1800, 15, 80, 16.0, '{}')
        """,
        (PROVIDER,),
    )
    for i in range(10):
        conn.execute(
            """
            INSERT INTO soccer_source_team_match_stats
            (provider, league, season, game_id, match_date, team, opponent, venue, goals_for, goals_against, xg_for, xg_against, raw_json)
            VALUES (?, 'ENG-Premier League', '2425', ?, '2025-05-01', 'Arsenal', 'Chelsea', 'home', 2, 1, 2.0, 0.9, '{}')
            """,
            (PROVIDER, f"a{i}"),
        )
        conn.execute(
            """
            INSERT INTO soccer_source_team_match_stats
            (provider, league, season, game_id, match_date, team, opponent, venue, goals_for, goals_against, xg_for, xg_against, raw_json)
            VALUES (?, 'ENG-Premier League', '2425', ?, '2025-05-01', 'Chelsea', 'Arsenal', 'away', 1, 2, 0.9, 1.8, '{}')
            """,
            (PROVIDER, f"c{i}"),
        )
    conn.commit(); conn.close()

    cards = matchup_prop_context_cards('Arsenal', 'Chelsea', home_goals=1.9, away_goals=1.1, path=db, limit_per_team=3)
    assert cards
    card = cards[0]
    assert card['player_name'] == 'Ace Striker'
    assert card['context']['team_environment']['projected_team_goals'] > 0
    assert card['context']['opponent_weakness']['opponent'] == 'Chelsea'
    assert card['context']['market_check']['status'] == 'not_priced'


def test_extract_prop_market_odds() -> None:
    from ml.soccer.player_props import extract_prop_market_odds

    game = {
        'bookmakers': [{
            'key': 'draftkings',
            'markets': [{
                'key': 'player_goal_scorer_anytime',
                'outcomes': [
                    {'name': 'Yes', 'description': 'Kylian Mbappe', 'price': 180},
                    {'name': 'No', 'description': 'Kylian Mbappe', 'price': -240},
                ],
            }],
        }, {
            'key': 'fanduel',
            'markets': [{
                'key': 'player_goal_scorer_anytime',
                'outcomes': [{'name': 'Yes', 'description': 'Kylian Mbappe', 'price': 200}],
            }],
        }]
    }
    odds = extract_prop_market_odds(game)
    assert odds['Kylian Mbappe']['player_goal_scorer_anytime']['book'] == 'fanduel'
    assert odds['Kylian Mbappe']['player_goal_scorer_anytime']['price'] == 200


def test_role_adjusted_card_updates_probability_and_reason() -> None:
    from ml.soccer.prop_cards import _role_adjusted_card

    card = {
        'assumed_minutes': 70,
        'expected_goals': 0.30,
        'anytime_scorer_prob': 0.2592,
        'shots_mean': 2.5,
        'context': {'role_today': {'assumed_minutes': 84, 'attack_role_score': 0.90, 'source': 'sportmonks'}},
        'props': [
            {'market': 'anytime_scorer', 'model_prob': 0.2592, 'reason': 'old'},
            {'market': 'shots', 'model_mean': 2.5, 'reason': 'old'},
        ],
    }
    out = _role_adjusted_card(card)
    assert out['expected_goals'] > card['expected_goals']
    assert out['anytime_scorer_prob'] > card['anytime_scorer_prob']
    assert out['shots_mean'] > card['shots_mean']
    assert out['context']['model_adjustment']['source'] == 'sportmonks'
    assert 'Live-role adjusted xG' in out['props'][0]['reason']


def test_cards_for_game_generates_fixture_rows(tmp_path: Path) -> None:
    from ml.soccer.understat_cache import init_tables, get_db, PROVIDER
    from ml.soccer.prop_cards import cards_for_game

    db = tmp_path / "wc_signal_log.db"
    init_tables(db)
    conn = get_db(db)
    conn.execute(
        """
        INSERT INTO soccer_source_player_stats
        (provider, league, season, player_name, team, position, appearances, minutes, goals, shots, xg, raw_json)
        VALUES (?, 'ENG-Premier League', '2425', 'Ace Striker', 'Arsenal', 'F', 20, 1800, 15, 80, 16.0, '{}')
        """,
        (PROVIDER,),
    )
    for team, opp, xgf, xga in [('Arsenal', 'Chelsea', 2.0, 0.9), ('Chelsea', 'Arsenal', 0.9, 1.8)]:
        for i in range(10):
            conn.execute(
                """
                INSERT INTO soccer_source_team_match_stats
                (provider, league, season, game_id, match_date, team, opponent, venue, goals_for, goals_against, xg_for, xg_against, raw_json)
                VALUES (?, 'ENG-Premier League', '2425', ?, '2025-05-01', ?, ?, 'home', 2, 1, ?, ?, '{}')
                """,
                (PROVIDER, f"{team}{i}", team, opp, xgf, xga),
            )
    conn.commit(); conn.close()

    game = {
        'id': 'g-props-1', 'home_team': 'Arsenal', 'away_team': 'Chelsea', 'commence_time': '2026-05-25T19:00:00Z',
        'bookmakers': [{'key': 'draftkings', 'markets': [
            {'key': 'totals', 'outcomes': [{'name': 'Over', 'point': 2.5, 'price': -110}, {'name': 'Under', 'point': 2.5, 'price': -110}]},
            {'key': 'h2h', 'outcomes': [{'name': 'Arsenal', 'price': -150}, {'name': 'Draw', 'price': 300}, {'name': 'Chelsea', 'price': 400}]},
        ]}],
    }
    # Patch the default DB used by player_props helpers for this unit test.
    import ml.soccer.player_props as pp
    old = pp.DB_PATH
    pp.DB_PATH = db
    try:
        rows = cards_for_game('soccer_epl', 'Premier League', game, limit_per_team=2)
    finally:
        pp.DB_PATH = old
    assert rows
    assert rows[0]['game_id'] == 'g-props-1'
    assert rows[0]['market'] in {'anytime_scorer', 'shots'}
    assert rows[0]['decision'] in {'watch', 'pass', 'lean', 'pick'}


def test_bettor_review_blocks_pick_without_lineup_or_market() -> None:
    from ml.soccer.prop_cards import _bettor_review

    card = {
        'sample_confidence': 'high',
        'anytime_scorer_prob': 0.42,
        'shots_mean': 4.0,
        'context': {
            'role_today': {'lineup_status': 'projected_unknown', 'penalty_role': 'unknown'},
            'team_environment': {'projected_team_goals': 2.2},
            'opponent_weakness': {'grade': 'soft', 'recent_xg_against': 1.8},
        },
    }
    decision, blockers, notes = _bettor_review(card, 'anytime_scorer', edge_pp=None, priced=False)
    assert decision == 'watch'
    assert 'lineup_unknown' in blockers
    assert 'market_price_missing' in blockers
    assert 'role_penalty_unknown' in blockers


def test_bettor_review_blocks_low_attack_role_even_with_edge() -> None:
    from ml.soccer.prop_cards import _bettor_review

    card = {
        'sample_confidence': 'high',
        'anytime_scorer_prob': 0.42,
        'shots_mean': 4.0,
        'context': {
            'role_today': {
                'lineup_status': 'confirmed_starting',
                'penalty_role': 'primary',
                'position_bucket': 'defender',
                'attack_role_score': 0.18,
            },
            'team_environment': {'projected_team_goals': 2.2},
            'opponent_weakness': {'grade': 'soft', 'recent_xg_against': 1.8},
        },
    }
    decision, blockers, notes = _bettor_review(card, 'anytime_scorer', edge_pp=0.10, priced=True)
    assert decision == 'watch'
    assert 'role_not_attacking_enough' in blockers
    assert any(n == 'role=defender' for n in notes)


def test_bettor_review_allows_pick_when_context_and_edge_clear() -> None:
    from ml.soccer.prop_cards import _bettor_review, _confidence

    card = {
        'sample_confidence': 'high',
        'anytime_scorer_prob': 0.42,
        'shots_mean': 4.0,
        'context': {
            'role_today': {'lineup_status': 'projected_starting', 'penalty_role': 'primary', 'position_bucket': 'attacker', 'attack_role_score': 0.88},
            'team_environment': {'projected_team_goals': 2.2},
            'opponent_weakness': {'grade': 'soft', 'recent_xg_against': 1.8},
        },
    }
    decision, blockers, notes = _bettor_review(card, 'anytime_scorer', edge_pp=0.08, priced=True)
    assert decision == 'pick'
    assert 'lineup_unknown' not in blockers
    assert _confidence(card, 'anytime_scorer', 0.08, blockers) == 'A'
