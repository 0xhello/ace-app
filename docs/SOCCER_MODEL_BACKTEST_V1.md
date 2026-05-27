# Soccer Model V1 — Leakage-Free Backtest Report

Generated: 2026-05-22

**Bottom line:** V1 has modest predictive signal, but it is **not ready for Phase 4 integration as a betting engine**. After fixing the totals-line bug and remaining SoT baseline leakage, the model beats a constant empirical baseline only slightly and remains negative ROI against historical closing odds.

---

## Methodology

- **Leagues:** Premier League, La Liga, Bundesliga, Serie A, Ligue 1
- **Dataset:** 5,225 unique Big-5 fixtures across the local football-data.co.uk backfill
- **Split:** chronological per league — oldest 80% train, newest 20% holdout
- **Holdout:** 1,044 fixtures
- **Predictions evaluated:** 5,220 market-side rows
  - 1X2: home / draw / away
  - Totals: over 2.5 / under 2.5
- **Training cutoff:** Dixon-Coles fit uses only rows strictly before each league split date
- **Adjustment cutoff:** SoT team lookbacks, referee card baselines, and league SoT conversion all use only rows strictly before the match being predicted
- **Benchmark:** de-vigged historical closing odds from football-data/Pinnacle where available

Note: this report evaluates against closing prices. That is intentionally strict, but it is not the same as measuring pre-move subscriber prices.

---

## Headline metrics

| Metric | Model | Constant baseline | Read |
| --- | ---: | ---: | --- |
| Log-loss | **0.6432** | 0.6523 | Small positive signal |
| Brier score | **0.2257** | — | Needs market-specific comparison next |
| ROI @ ≥3pp edge | **-4.97%** | 0% flat | Not profitable |
| ROI @ ≥5pp edge | **-7.21%** | 0% flat | Not profitable |
| ROI @ ≥7pp edge | **-6.49%** | 0% flat | Not profitable |
| ROI @ ≥10pp edge | **-5.99%** | 0% flat | Not profitable |

**Read:** the model has information, but not enough calibration/price discipline to beat close. It should not be wired into the live signal pipeline yet.

---

## Calibration

| Probability bucket | N | Avg predicted | Actual | Miss |
| --- | ---: | ---: | ---: | ---: |
| 0-10% | 127 | 7.01% | 11.81% | +4.80pp |
| 10-20% | 537 | 15.86% | 21.04% | +5.18pp |
| 20-30% | 1,188 | 25.12% | 28.20% | +3.08pp |
| 30-40% | 895 | 34.92% | 39.33% | +4.41pp |
| 40-50% | 856 | 45.00% | 45.56% | +0.56pp |
| 50-60% | 805 | 54.95% | 52.42% | -2.53pp |
| 60-70% | 537 | 64.33% | 54.00% | -10.32pp |
| 70-80% | 213 | 73.88% | 60.09% | -13.78pp |
| 80-90% | 53 | 83.91% | 69.81% | -14.10pp |
| 90-100% | 9 | 91.62% | 66.67% | -24.95pp |

**Main calibration flaw:** V1 is overconfident on high-probability sides. That is exactly the profile that creates fake “edge” and negative ROI.

---

## ROI by edge threshold

Flat 1-unit stake on every model edge versus de-vigged close.

| Edge threshold | Bets | Win rate | Return | ROI |
| --- | ---: | ---: | ---: | ---: |
| ≥3pp | 1,824 | 40.52% | -90.61u | -4.97% |
| ≥5pp | 1,473 | 39.78% | -106.13u | -7.21% |
| ≥7pp | 1,148 | 40.33% | -74.45u | -6.49% |
| ≥10pp | 794 | 40.43% | -47.60u | -5.99% |

**Read:** higher edge buckets are not monotonic enough. The model’s biggest edges are often overconfidence, not true mispricing.

---

## Market breakdown

| Market | N | Avg model prob | Actual rate | Log-loss | ROI @ ≥5pp |
| --- | ---: | ---: | ---: | ---: | ---: |
| Home win | 1,044 | 47.23% | 42.05% | 0.6475 | -12.78% |
| Draw | 1,044 | 24.24% | 26.25% | 0.5815 | -14.50% |
| Away win | 1,044 | 28.53% | 31.70% | 0.5746 | +0.06% |
| Over 2.5 | 1,044 | 48.30% | 53.74% | 0.7062 | +3.06% |
| Under 2.5 | 1,044 | 51.70% | 46.26% | 0.7062 | -7.63% |

**Interesting pocket:** over 2.5 edges are mildly positive in this holdout (+3.06% at ≥5pp), while unders and home favorites are dragging the model down. Treat that as a research lead, not a production signal yet.

---

## Per-league summary

| League | Predictions | Log-loss | Baseline | ROI @ ≥5pp |
| --- | ---: | ---: | ---: | ---: |
| Premier League | 1,130 | 0.6608 | 0.6558 | -5.98% |
| La Liga | 1,130 | 0.6394 | 0.6413 | -4.58% |
| Bundesliga | 915 | 0.6189 | 0.6380 | -17.68% |
| Serie A | 1,130 | 0.6398 | 0.6522 | +1.64% |
| Ligue 1 | 915 | 0.6545 | 0.6503 | -13.17% |

**Read:** Serie A is the only league with positive ROI at the 5pp threshold. Bundesliga has useful log-loss improvement but terrible ROI, which reinforces the calibration/price-selection problem.

---

## Audit fixes made after Claude cutoff

1. **Fixed totals evaluation.** Previous code wrote `AvgC>2.5` — an odds column — into `close_ou_line`, causing almost every totals market to be skipped. Now football-data 2.5 totals are explicitly stored/evaluated as line 2.5 when over/under odds exist.
2. **Fixed remaining SoT leakage.** League-wide SoT conversion now accepts `before_date`, so backtests do not use future holdout rows in the league conversion baseline.
3. **Added market breakdown to the artifact.** The report now proves totals were actually evaluated: 1,044 rows each for over and under.

---

## Recommendation

**Do not move to Phase 4 yet.**

Phase 3 Day 5 should be marked as: **completed, rejected for integration, iterate model.**

Next model-improvement pass should target:

1. **Probability shrinkage / calibration layer** — reduce overconfidence above 60%.
2. **Market-specific gates** — do not treat 1X2 and totals as interchangeable; totals may be the stronger first wedge.
3. **Opening/pre-move price capture** — close is useful for audit, but the product needs to know whether it beats subscriber-available prices.
4. **Elo integration cleanup** — current code computes Elo for rankings/sanity, but prediction probabilities are still Dixon-Coles + SoT/ref adjustments. Either integrate Elo or adjust docs to stop calling it a two-stage predictive blend.

**Path forward:** spend one short Phase 3B pass on calibration + market gating, then rerun this same backtest. Only move to Phase 4 if ROI improves and edge buckets become more monotonic.
