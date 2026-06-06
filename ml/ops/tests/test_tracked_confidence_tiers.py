from ml.ops.tracked_picks import calibrated_tier


def test_tracked_picks_use_calibrated_low_medium_high_tiers():
    assert calibrated_tier(0.01, "C") == "low"
    assert calibrated_tier(0.04, "C") == "medium"
    assert calibrated_tier(0.08, "A") == "high"


def test_tracked_picks_preserve_fallback_when_score_missing():
    assert calibrated_tier(None, "C") == "C"
