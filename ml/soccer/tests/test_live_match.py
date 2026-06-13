from ml.soccer.live_match import _normalize_events, _normalize_lineups, _player_position_index, _ticking_clock


def test_live_events_include_player_positions_from_lineups():
    lineups = _normalize_lineups([
        {"player_id": 10, "player_name": "Alex Nine", "team_id": 1, "position_id": 27, "type_id": 11},
        {"player_id": 6, "player_name": "Milo Six", "team_id": 1, "position_id": 26, "type_id": 12},
    ], home_id=1)

    events = _normalize_events([
        {
            "minute": 67,
            "type": {"developer_name": "SUBSTITUTION"},
            "participant_id": 1,
            "player_id": 10,
            "player_name": "Alex Nine",
            "related_player_id": 6,
            "related_player_name": "Milo Six",
        }
    ], home_id=1, pos_index=_player_position_index(lineups))

    assert events[0]["player_position"] == "FWD"
    assert events[0]["related_position"] == "MID"


def test_ticking_clock_exposes_stoppage_time():
    clock = _ticking_clock([
        {"minutes": 45, "ticking": True, "extra_minute": 3},
    ])

    assert clock == {"minute": 45, "extra": 3}
