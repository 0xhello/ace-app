# Soccer Pipeline Leakage Audit — 2026-05-29

Triggered by the user's challenge of the "+9.1% ROI on 198 Big-5 matches"
claim. The audit re-examined every feature path in the soccer model and
backtest pipeline for temporal/target/lookback leakage.

## TL;DR

The **temporal cutoff machinery is solid** — every adjustment honors
`before_date` and the underlying tables (Understat per-match stats,
soccer_team_form, lineup snapshots) are correctly per-match dated.

But the **calibration layer is circular**: the shrinkage factors and
the M21 hyperparameters were both tuned by inspecting the holdout
backtest, then re-evaluated on the same holdout. That's a form of
**concept-level leakage** — reported metrics are over-fit to the test
set even though no individual feature query violates the date cutoff.

**Operational impact:** the +3.06% (V1 doc) and +9.1% (M21 commit body)
numbers are both upward-biased. The true out-of-sample ROI is somewhere
lower. We cannot quantify how much lower without a clean train /
validation / test split — that's the M40.2 follow-up.

---

## Audit method

For each file in the prediction pipeline, traced every SQL query and
data lookup to confirm it either (a) accepts and honors a
`before_date` / `train_before` argument, or (b) reads from a source
that is statically dated.

Files audited:
- `ml/soccer/backtest.py`
- `ml/soccer/calibration.py`
- `ml/soccer/model.py` (predict_match + all adjustments)
- `ml/soccer/candidates.py` (live scan + backfill paths)
- `ml/soccer/understat_cache.py`
- `ml/soccer/sportmonks_fixture.py` (M38, shipped today)
- `ml/soccer/predictions_crosscheck.py` (M39, shipped today)

Underlying tables sanity-checked for per-row dating:
- `soccer_source_team_match_stats` (Understat) — 3,504 rows, 1,044 dates → per-match ✓
- `soccer_team_form` — 10,450 rows, 545 dates → per-match ✓
- `player_baselines` — 1,738 rows, ALL `computed_at` = 2026-05-22 → ⚠ cumulative
- `soccer_player_feature_snapshot` (lineups) — date-gated via `updated_at`
- `soccer_sportmonks_fixture_cache` (M38) — today only; historical backtests no-op

---

## Findings

### ✓ Clean paths (verified)

1. **`backtest.py`** — passes `train_before=split_date` to fit and
   `before_date=m["match_date"]` to predict. Holdout never contributes to fit.
2. **`fit_dixon_coles`** — SQL `WHERE match_date < ?` in `model.py:232,242`.
3. **`predict_match`** — threads `before_date` through every adjustment
   (model.py:1129+). Verified in code.
4. **`_xg_prior_adjustment` (M9)** — `match_date < ?` on team lookback
   AND on the league baseline. Both gated. Simulated lookup against
   Liverpool on 2024-05-19 correctly excluded all 38 of their
   2024-25 rows.
5. **`_understat_team_name`** — `match_date < ?` on the team-name search.
6. **`_league_sot_conversion`** — `match_date < ?` (the V1 doc's
   "remaining SoT leakage" fix; verified present).
7. **`_team_sot_adjustment`** — `match_date < ?`.
8. **`_lineup_availability_adjustment` (M7)** — `updated_at < ?` on
   the snapshot. Docstring explicitly explains the leakage rationale.
9. **`_lineup_defensive_availability_adjustment` (M8)** — same gate.
10. **`_ref_card_adjustment`** — `before_date` honored.
11. **Closing odds** — `close_home_odds`, `close_over_odds` etc. exist
    in `soccer_team_form` but are **never read as features**. Only used
    as the grading line in `backtest.py::_evaluate_match` and
    `candidates.py::backfill_from_form`.
12. **`candidates.py::backfill_from_form`** — passes
    `before_date=m["match_date"]` (this is the function that generated
    the v1_pre_m21 backfill picks M37.1 just tagged).
13. **`candidates.py::scan` (live)** — uses `before_date=None`, correct
    for live prediction.
14. **M38 `sportmonks_fixture.py`** — adds no new historical data.
    Cache is empty for any past date, so the M38 lineup-aware path
    falls back to the legacy heuristic in backtests. Zero leakage; also
    means M38 can't be measured by the current backtest.
15. **M39 `predictions_crosscheck.py`** — pure dict lookup, no DB
    queries. Sportmonks predictions are pre-match info, used as a
    cross-check signal, not as a model training feature.

### ❌ Leakage found

#### Finding #1 — Shrinkage factors tuned on the holdout (circular)

**Location:** `ml/soccer/model.py:1093-1097`

```python
# Tuned by re-running the holdout backtest; values around 0.65-0.80 are
# typical for under-featured DC models per literature (Karlis & Ntzoufras 2003).
SHRINKAGE_FACTOR_1X2    = 0.72
SHRINKAGE_FACTOR_TOTALS = 0.80
SHRINKAGE_FACTOR_BTTS   = 0.85
```

The comment literally says the factors were chosen by re-running the
holdout backtest. So the reported holdout ROI reflects a model whose
calibration layer was tuned **on the same data it's measured against**.

This is concept-level leakage — no individual SQL query violates the
date cutoff, but the hyperparameter selection optimizes for the test
set. Classic over-fitting via researcher choice.

**Impact:** the V1 doc's +3.06% ROI on Over 2.5 (the more rigorous
number) is upward-biased. True out-of-sample is lower. We can't
quantify the gap without a clean validation split.

**Severity:** Moderate. Shrinkage is one hyperparameter knob; tuning
it doesn't drastically swing ROI. But it's still test-set leakage.

#### Finding #2 — M21 hyperparameters tuned on the prior backtest, then "validated" on the same data

**Location:** M21 commit body (`916fb6b`) — home gamma default 1.30,
M9 delta damp 0.5.

**Process that produced the +9.1% number:**
1. M20 backtest (May 23) showed +5pp overs bias.
2. M21 picked `gamma=1.30` (the typical DC fit) and `damp=0.5`
   specifically to neutralize that bias.
3. M21 re-ran the backtest on the **same 420 Big-5 matches** with the
   new constants → got +9.1% on Over 2.5 (198 bets at ≥5pp).
4. Commit body presented this as "totals over is now genuinely
   profitable."

But the re-backtest is not independent validation. The constants were
chosen specifically to make this number good. **Same circular pattern
as Finding #1.**

**Impact:** the +9.1% number is the most-biased estimate. The V1 doc
(+3.06%) is closer to a true read because it used the full 1,044
holdout, not a 198-bet subset cherry-picked by the model's edge filter
after constants were tuned on the underlying data.

**Severity:** Moderate. Same mechanism as #1, stacked.

### ⚠ Latent risk (not currently exploited)

#### Risk #3 — `player_baselines` is cumulative with a single timestamp

**Location:** `player_baselines` table, 1,738 rows, all `computed_at`
= 2026-05-22.

Each row contains a player's full-career aggregate stats (`total_goals`,
`total_shots`, `total_minutes`). There is no per-match dating — just
one timestamp marking when the row was computed.

**Current impact: ZERO.** `predict_match` (the game-level model) does
not read `player_baselines`. The table is only used by:
- WC squad goalscorer priors (`ml/world_cup/players.py`)
- Topscorer integration (`ml/world_cup/...`)

Neither path feeds into the soccer backtest we report against.

**Future impact: HIGH for M40 (player-prop backtest).** When we build
the player-prop backtest harness post-launch, we cannot use
`player_baselines` as the per-match feature without leaking the
player's future stats into the prediction. We'd need to either:
- Compute baselines as-of each historical match date (expensive but
  clean)
- Use per-match Understat rows from `soccer_source_player_stats` with
  `match_date < before_date` filtering (cheaper and clean)

**Tracked:** M40 follow-up. The harness must use the per-match path.

#### Risk #4 — M38 lineup cache is forward-only

`soccer_sportmonks_fixture_cache` only contains fixtures from when M38
shipped (today). Historical backtests against fixtures before today
will hit an empty cache and fall back to the legacy heuristic
`_assumed_minutes`. **No leakage**, but it means the M38 lineup
benefit cannot be measured retroactively. We either:
- Skip M38 entirely in M40 (use legacy heuristic for backtest) — easy
- Backfill the cache via Sportmonks historical fixture endpoints —
  costs ~30 credits per backtest fixture × thousands of fixtures =
  expensive. Probably not worth it.

**Tracked:** M40 design decision.

---

## What this means for the picks I gave you for the UCL final

The corrected framing already in place stands:

> **Over 2.5 @ +102 (BetRivers)** — best market type we have. Two
> backtests show positive ROI; both are partially over-fit due to the
> circular calibration noted above. Real out-of-sample ROI is some
> number lower than +3.06%, but still likely positive given the
> independent Sportmonks 60% agreement. Size accordingly (0.5u not 1u).

No claim about the model being a clean +9.1% machine survives this audit.

---

## Action items

| ID | Action | Severity | When |
|---|---|---|---|
| M40.2 | Add a `validation` split to backtest.py — proper 60/20/20. Tune shrinkage on validation only, report on held-out test. | Moderate | Post-launch |
| M40.3 | Rename `SOCCER_MODEL_BACKTEST_V1.md` → V1 + leave intact; produce V2 doc with the clean 3-way split. Cite V2 as the only valid ROI source going forward. | Moderate | Post-launch |
| M40.4 | M40 (player-prop backtest harness) MUST use per-match `soccer_source_player_stats` not `player_baselines` for player features. Document the rationale in the harness code. | High when M40 starts | Post-launch |
| M40.5 | If we extend the M21 fixes (or any other constants tuned on backtest output), document explicitly that those constants need re-validation on the V2 split. | Process | Ongoing |

---

## Process change

Per the memory-file update earlier today: **any ROI / win-rate / edge
claim must cite the source artifact in the same response**. That stops
the +9.1% pattern from recurring. This audit doc is itself a citable
source — future claims should reference it when discussing leakage.

The deeper lesson: even with strict `before_date` SQL gates everywhere,
**you can still leak via researcher-degree-of-freedom** when
hyperparameters are picked by looking at the test set. That's why
proper validation splits exist. We don't have one. M40.2 fixes it.
