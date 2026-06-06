# ACE Confidence Calibration Model — 2026-06-06

## Purpose

Make Low / Medium / High confidence real by tying tiers to observed paper-tracked outcomes instead of static UI labels.

## Current model

Module: `ml/ops/confidence_calibration.py`

Command:

```bash
python3 -m ml.ops.confidence_calibration
```

Inputs:
- Canonical tracked outcomes from `ml/nba_spread/data/tracked_picks.db`
- NBA model prediction history from `ml/nba_spread/data/signal_log.db::predictions`

Output:
- Local generated artifact: `ml/ops/artifacts/confidence_calibration.json`
- Artifact is intentionally ignored by git because it is generated from local/prod DB state.

## Tier score

The score is absolute model/market edge in probability points:

- `0.03` = 3 percentage points
- `0.07` = 7 percentage points

Priority:
1. `abs(model_prob - implied_prob)` when available
2. `abs(edge_pp)`
3. `abs(signal_strength)`
4. NBA `abs(pick_confidence - 0.5)` from model prediction history

## Current thresholds

- Low: `< 3pp`
- Medium: `3pp–7pp`
- High: `>= 7pp`

## Current sample snapshot

Generated locally on 2026-06-06:

- Total graded calibration rows: 125
- Overall hit rate: 47.2%
- Maturity: provisional

Buckets:

- Low: 11 samples, 36.4% raw hit rate
- Medium: 94 samples, 46.8% raw hit rate
- High: 20 samples, 55.0% raw hit rate

Interpretation: tiers are now empirical and directionally ordered, but low/high samples are still too small for validated confidence. Use shrunk hit rates and maturity flags until the sample reaches the validation threshold.

## Validation rule

The artifact marks:

- `insufficient_sample` below 50 samples
- `provisional` at 50+ samples
- `validated` at 250+ samples

## Wiring

Canonical tracked picks now assign `confidence_tier` using the calibrated low/medium/high thresholds when edge data exists and stamp `confidence_model_version` with the calibration model version.

Legacy sport source tables may still use A/B/C internally; the canonical tracked ledger is where calibrated ACE confidence should live.
