from ml.ops.confidence_calibration import (
    CalibrationPick,
    build_calibration,
    confidence_tier_for_score,
)


def test_confidence_tier_for_score_uses_edge_thresholds():
    assert confidence_tier_for_score(0.01) == "low"
    assert confidence_tier_for_score(0.03) == "medium"
    assert confidence_tier_for_score(0.049) == "medium"
    assert confidence_tier_for_score(0.069) == "medium"
    assert confidence_tier_for_score(0.07) == "high"
    assert confidence_tier_for_score(-0.08) == "high"


def test_build_calibration_shrinks_small_buckets_and_reports_maturity():
    picks = [
        CalibrationPick("mlb", "h2h", "edge_pp", 0.02, True, 0.01, "win"),
        CalibrationPick("mlb", "h2h", "edge_pp", 0.02, False, -0.01, "loss"),
        CalibrationPick("mlb", "h2h", "edge_pp", 0.04, True, 0.02, "win"),
        CalibrationPick("soccer", "totals", "model_edge", 0.08, True, None, "win"),
    ]

    artifact = build_calibration(picks)

    assert artifact["model_version"].startswith("ace_confidence_calibration_v")
    assert artifact["sample"]["n"] == 4
    assert artifact["sample"]["wins"] == 3
    assert artifact["sample"]["maturity"] == "insufficient_sample"

    buckets = {b["tier"]: b for b in artifact["buckets"]}
    assert buckets["low"]["n"] == 2
    assert buckets["medium"]["n"] == 1
    assert buckets["high"]["n"] == 1
    assert buckets["high"]["raw_hit_rate"] == 1.0
    assert buckets["high"]["shrunk_hit_rate"] < 1.0
    assert buckets["high"]["maturity"] == "insufficient_sample"

    assert artifact["sports"]["mlb"]["n"] == 3
    assert artifact["sports"]["soccer"]["n"] == 1
    assert artifact["warnings"]
