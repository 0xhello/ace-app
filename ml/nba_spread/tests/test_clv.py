"""
Unit tests for pure functions in signal_logger.py:
  - compute_clv_points()
  - determine_covered()
  - compute_edge_status()
"""
import pytest
from ml.nba_spread.signal_logger import (
    compute_clv_points,
    determine_covered,
    compute_edge_status,
    MIN_SAMPLES_FOR_STATUS,
)


class TestComputeClvPoints:
    # ------------------------------------------------------------------
    # Exact docstring examples
    # ------------------------------------------------------------------
    def test_home_bet_got_easier_line(self):
        # Home bet, signal -3.5, close -5.5 → +2.0
        assert compute_clv_points(-3.5, -5.5, "home") == 2.0

    def test_home_bet_got_harder_line(self):
        # Home bet, signal -3.5, close -1.5 → -2.0
        assert compute_clv_points(-3.5, -1.5, "home") == -2.0

    def test_away_bet_close_moved_against(self):
        # Away bet, signal -3.5, close -5.5 → -2.0
        # (away got +3.5; close gave +5.5 — worse for the away bettor)
        assert compute_clv_points(-3.5, -5.5, "away") == -2.0

    def test_away_bet_got_better_line(self):
        # Away bet, signal -3.5, close -1.5 → +2.0
        # (away got +3.5; close only gave +1.5 — better)
        assert compute_clv_points(-3.5, -1.5, "away") == 2.0

    def test_home_underdog_got_fewer_points(self):
        # Home bet, signal +2.5, close +4.5 → -2.0
        assert compute_clv_points(2.5, 4.5, "home") == -2.0

    def test_away_underdog_gave_fewer_points(self):
        # Away bet, signal +2.5, close +4.5 → +2.0
        assert compute_clv_points(2.5, 4.5, "away") == 2.0

    # ------------------------------------------------------------------
    # Edge cases
    # ------------------------------------------------------------------
    def test_no_line_movement_zero_clv(self):
        assert compute_clv_points(-5.5, -5.5, "home") == 0.0
        assert compute_clv_points(-5.5, -5.5, "away") == 0.0

    def test_half_point_movement(self):
        assert compute_clv_points(-6.0, -6.5, "home") == 0.5
        assert compute_clv_points(-6.0, -6.5, "away") == -0.5

    def test_large_movement(self):
        assert compute_clv_points(-1.0, -8.0, "home") == 7.0
        assert compute_clv_points(-1.0, -8.0, "away") == -7.0

    def test_invalid_bet_side_raises(self):
        with pytest.raises(ValueError, match="bet_side must be"):
            compute_clv_points(-3.5, -5.5, "BOTH")

    def test_result_is_float(self):
        result = compute_clv_points(-3.5, -5.5, "home")
        assert isinstance(result, float)

    def test_rounding_two_decimal_places(self):
        # Verifies the round(…, 2) call
        result = compute_clv_points(-3.1, -5.4, "home")
        assert result == round(result, 2)


class TestDetermineCovered:
    # ------------------------------------------------------------------
    # Home covers
    # ------------------------------------------------------------------
    def test_home_favored_wins_by_enough(self):
        # home_line = -5.5, home wins by 10: cover_margin = 10 + (-5.5) = 4.5 > 0
        assert determine_covered(110, 100, -5.5) == 1

    def test_home_dog_wins_outright(self):
        # home_line = +4.5, home wins: cover_margin = 5 + 4.5 = 9.5
        assert determine_covered(105, 100, 4.5) == 1

    def test_home_dog_loses_less_than_spread(self):
        # home_line = +5.5, home loses by 3: cover_margin = -3 + 5.5 = 2.5 > 0
        assert determine_covered(100, 103, 5.5) == 1

    # ------------------------------------------------------------------
    # Away covers
    # ------------------------------------------------------------------
    def test_home_favored_wins_by_too_little(self):
        # home_line = -7.5, home wins by 3: cover_margin = 3 + (-7.5) = -4.5 < 0
        assert determine_covered(103, 100, -7.5) == 0

    def test_home_dog_loses_by_more_than_spread(self):
        # home_line = +3.5, home loses by 6: cover_margin = -6 + 3.5 = -2.5 < 0
        assert determine_covered(97, 103, 3.5) == 0

    def test_away_wins_outright(self):
        assert determine_covered(95, 110, -5.5) == 0

    # ------------------------------------------------------------------
    # Push
    # ------------------------------------------------------------------
    def test_exact_push_negative_spread(self):
        # home_line = -5, home wins by exactly 5: cover_margin = 5 + (-5) = 0
        assert determine_covered(105, 100, -5.0) is None

    def test_exact_push_positive_spread(self):
        # home_line = +3, home loses by exactly 3: cover_margin = -3 + 3 = 0
        assert determine_covered(100, 103, 3.0) is None

    def test_push_returns_none_not_zero(self):
        result = determine_covered(105, 100, -5.0)
        assert result is None

    # ------------------------------------------------------------------
    # Consistency: home=1 and away=0 are complementary (no push case)
    # ------------------------------------------------------------------
    def test_covered_and_not_covered_are_complements(self):
        home_result = determine_covered(110, 100, -5.5)   # home covers
        away_result = determine_covered(100, 110, -5.5)   # away covers (different score)
        assert home_result == 1
        assert away_result == 0


class TestComputeEdgeStatus:
    # ------------------------------------------------------------------
    # Below threshold → always 'accumulating' regardless of numbers
    # ------------------------------------------------------------------
    def test_below_min_samples_always_accumulating(self):
        assert compute_edge_status(0,  +2.0, 100.0) == "accumulating"
        assert compute_edge_status(1,  +2.0, 100.0) == "accumulating"
        assert compute_edge_status(29, +2.0, 100.0) == "accumulating"
        assert compute_edge_status(29, -1.0,   0.0) == "accumulating"

    def test_exactly_at_min_samples_no_longer_accumulating(self):
        status = compute_edge_status(MIN_SAMPLES_FOR_STATUS, +0.8, 60.0)
        assert status != "accumulating"

    # ------------------------------------------------------------------
    # Tier boundaries at 30+ samples
    # ------------------------------------------------------------------
    def test_negative_clv_is_bad(self):
        assert compute_edge_status(30, -0.1, 45.0) == "bad"
        assert compute_edge_status(50, -2.0, 20.0) == "bad"
        assert compute_edge_status(30, -0.01, 49.0) == "bad"

    def test_zero_to_half_is_inconclusive(self):
        assert compute_edge_status(30, 0.0,  55.0) == "inconclusive"
        assert compute_edge_status(30, 0.3,  60.0) == "inconclusive"
        assert compute_edge_status(30, 0.49, 55.0) == "inconclusive"

    def test_half_to_one_is_promising(self):
        assert compute_edge_status(30, 0.5,  55.0) == "promising"
        assert compute_edge_status(50, 0.75, 65.0) == "promising"
        assert compute_edge_status(30, 0.99, 55.0) == "promising"

    def test_one_or_above_is_strong(self):
        assert compute_edge_status(30, 1.0,  60.0) == "strong"
        assert compute_edge_status(50, 1.5,  70.0) == "strong"
        assert compute_edge_status(100, 2.0, 80.0) == "strong"

    # ------------------------------------------------------------------
    # '?' suffix when avg_clv >= 0 but pct_pos_clv <= 50 (secondary flag)
    # ------------------------------------------------------------------
    def test_question_suffix_when_pct_pos_at_or_below_50(self):
        assert compute_edge_status(30, 0.3,  50.0) == "inconclusive?"
        assert compute_edge_status(30, 0.3,  40.0) == "inconclusive?"
        assert compute_edge_status(30, 0.7,  50.0) == "promising?"
        assert compute_edge_status(30, 1.2,  50.0) == "strong?"

    def test_no_suffix_when_pct_pos_above_50(self):
        assert compute_edge_status(30, 0.3,  51.0) == "inconclusive"
        assert compute_edge_status(30, 0.7,  51.0) == "promising"
        assert compute_edge_status(30, 1.2,  51.0) == "strong"

    def test_bad_never_gets_question_suffix(self):
        # bad is determined solely by avg_clv < 0; pct_pos_clv is irrelevant
        assert compute_edge_status(30, -0.5, 40.0) == "bad"
        assert compute_edge_status(30, -0.5, 60.0) == "bad"

    # ------------------------------------------------------------------
    # Boundary values
    # ------------------------------------------------------------------
    def test_exact_boundary_zero_clv(self):
        assert compute_edge_status(30, 0.0, 55.0) == "inconclusive"

    def test_exact_boundary_half_point(self):
        assert compute_edge_status(30, 0.5, 55.0) == "promising"

    def test_exact_boundary_one_point(self):
        assert compute_edge_status(30, 1.0, 55.0) == "strong"
