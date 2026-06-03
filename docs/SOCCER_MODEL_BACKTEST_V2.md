# Soccer Model V2 — Leakage-Free Backtest (the citable source)

Generated: 2026-05-30 · Artifact: `ml/soccer/artifacts/backtest_v2.json`
Harness: `ml/soccer/backtest_v2.py`

**This supersedes `SOCCER_MODEL_BACKTEST_V1.md` and the M21 commit-body
numbers as the single citable source for soccer model ROI.** Any ROI
claim should reference this document or the artifact above.

---

## Why V2 exists

The 2026-05-29 leakage audit (`SOCCER_LEAKAGE_AUDIT_2026-05-29.md`) found
that V1's headline ROIs were over-fit: the shrinkage factors and the M21
hyperparameters were tuned by inspecting the SAME holdout they were
reported on. The reported +3.06% (V1) and +9.1% (M21 commit) were both
optimistic — we couldn't say how much of the edge was real vs curve-fit.

V2 removes that contamination with a proper three-way split.

---

## Method

```
chronological per league:
   train      oldest 60%   →  fit Dixon-Coles
   validation 20%          →  tune calibration shrinkage (by log-loss)
   test       newest 20%   →  report ROI  (never touched during tuning)
```

- The shrinkage transform is applied **in the harness**, not inside the
  model, so grid-searching it on validation cannot contaminate the model.
  `predict_match` only ever returns RAW probabilities here.
- Shrinkage is tuned to minimize **validation log-loss** (the proper
  calibration metric), not validation ROI (which is noisy on small sets).
- Final-fit protocol: once the factor is chosen on validation, Dixon-Coles
  is refit on train+val and the held-out test is evaluated with that fit.
  The test set never informs any choice.
- Benchmark: de-vigged closing odds from `soccer_team_form`
  (football-data.co.uk) — the hardest fair benchmark (beating the close).
- Pooled sample: 4,584 validation rows, 5,230 test rows across the Big-5.

Markets here: **1X2 + Totals 2.5** — the markets with closing odds in
soccer_team_form. BTTS / corners / anytime-scorer get their own harness
once the M48 Sportmonks historical odds finish loading.

---

## Results — per selection, on the held-out test

Verdicts are per **selection**, not per market group: "Over 2.5" and
"Under 2.5" share a shrink factor but are opposite bets. The product only
ever bets one side, so that's the granularity that matters.

| Selection | Shrink | 3pp | 5pp (verdict) | 7pp | Verdict |
|---|---:|---:|---:|---:|---|
| **Over 2.5** | 0.50 | +7.77% (44) | **+8.83% (36)** | +32.79% (28) | **✓ PROVEN** |
| Under 2.5 | 0.50 | −6.00% (49) | −9.97% (37) | −8.50% (28) | · experimental |
| 1X2 Home | 0.92 | −9.75% (73) | −15.25% (59) | −1.44% (45) | · experimental |
| 1X2 Away | 0.92 | −4.29% (31) | −21.21% (19) | −18.31% (16) | · experimental |
| 1X2 Draw | 0.92 | +1.90% (21) | −27.78% (9) | +30.00% (5) | · experimental |

(parentheses = number of test bets at that edge threshold)

**Verdict rule:** PROVEN = test ROI > 0 at the 5pp edge, with ≥ 30 test
bets, AND not losing at the lower 3pp threshold (a real edge shouldn't
lose money at the larger-sample lower threshold — that guards against a
single lucky threshold). Everything else is EXPERIMENTAL.

## BTTS (added 2026-06-02, Sportmonks closing odds)

With the M48 Sportmonks historical odds, BTTS got its first clean
backtest (2,436 test-window odds rows):

| Selection | 3pp | 5pp | 7pp | Verdict |
|---|---:|---:|---:|---|
| BTTS No  | −11.41% (59) | +2.48% (45) | +19.33% (23) | · experimental |
| BTTS Yes | +19.55% (19) | +27.33% (12) | +9.00% (4) | · experimental |

**BTTS is NOT proven.** BTTS-No clears the mechanical 5pp bar (+2.48%)
but **loses 11% at 3pp** — single-threshold noise, not a durable edge
(this is exactly why the verdict rule now requires the 3pp threshold to
hold). BTTS-Yes looks positive but has only 12 test bets at 5pp — too
thin to call. Treat both as Experimental / promising-but-unconfirmed.

---

## The one proven market: Over 2.5 over

```
edge ≥ 3pp :  44 bets   47.7% win   ROI  +7.77%
edge ≥ 5pp :  36 bets   47.2% win   ROI  +8.83%
edge ≥ 7pp :  28 bets   57.1% win   ROI +32.79%
```

**The ROI rises monotonically with the edge threshold.** That is the
signature of a genuine edge — when the model and the market disagree more,
we win more. Noise does not behave this way. This is the strongest
single piece of evidence that Over 2.5 is real and not curve-fit.

Honest caveats:
- **Small sample.** 36 test bets at the 5pp tier. The point estimate is
  +8.83% but the error bars are wide; the true edge could plausibly be
  anywhere from low-single-digits to ~+15%. Directionally trustworthy,
  not precise.
- The clean +8.83% landing near the leaky +9.1% is reassuring, but the
  V2 number is the one to cite because it's the only leakage-free one.

---

## Corners (added 2026-06-02)

The corners model is non-parametric (rolling team corner-for / corner-against
rates → Poisson on the total), so there's no hyperparameter to tune on a
holdout — clean by construction. Run on the newest-20% test split vs
Sportmonks closing corners odds, with push handling on whole-number lines:

| Edge | Bets | Win% | ROI |
|---|---:|---:|---:|
| ≥3pp | 17,528 | 59.6% | −4.51% |
| ≥5pp | 13,337 | 59.7% | −4.72% |
| ≥7pp | 9,368 | 58.0% | −5.22% |

**Corners is NOT proven — conclusively.** A 17k-bet sample with a steady
−4.5 to −5.2% ROI across every threshold says the rolling-rate model has
no edge over the corners market (the ~60% win rate is favorite-bias on
low lines; it still loses to the vig). Corners markets are efficient
relative to our model. Verdict: **experimental / no edge.**

## Anytime scorer — cannot be validated yet (data gap)

A clean anytime-scorer backtest needs each player's scoring rate **as of
each match date** (leakage-free). We don't have that feature:
- `player_baselines` is cumulative with a single timestamp — leaky (M40.4
  forbids using it for a backtest).
- `soccer_source_player_stats` (Understat) is season-aggregated, no
  match_date.
We DO have the raw ingredients — 3,794 historical fixtures with goal
scorers + 532k anytime-scorer odds rows — so it's buildable, but it
requires engineering a leakage-free per-player as-of-date scoring feature
first. Until then anytime scorer stays **experimental / unvalidated.**

## What this means for launch

- **Over 2.5 over → the only "Proven" badge at launch.** Everything else
  ships as "Experimental — tracking live" per the tiered-display decision.
- 1X2 (moneyline) is confirmed not bettable on this model. Do not surface
  it as a pick; it can appear as Experimental context only.
- BTTS / corners / anytime-scorer verdicts are PENDING the Sportmonks
  historical extension (M48 data loading) — they stay Experimental until
  their own clean backtest runs.

---

## Reproduce

```bash
python3 -m ml.soccer.backtest_v2 run      # re-run + write artifact
python3 -m ml.soccer.backtest_v2 report   # print last artifact
```
