# Tracked Picks Ledger Review — 2026-06-06

Purpose: give Pixl a plain-English approval sheet for what becomes canonical Ops Results/Today before wiring the UI.

Source used: local canonical `tracked_picks` dry-run/apply generated from exported production signal DBs.

No production mutation has been performed.

## High-Level Result

The proposed canonical ledger contains:

- **109 total rows**
- **100 graded results**
- **8 open picks**
- **1 void/push-style row**

By sport:

| Sport | Canonical Rows | Graded | Open | Void | Record | Paper P&L |
|---|---:|---:|---:|---:|---:|---:|
| MLB | 64 | 57 | 6 | 1 | 27W-30L | -5.45u |
| NBA | 25 | 25 | 0 | 0 | 11W-14L | -4.00u |
| Soccer | 20 | 18 | 2 | 0 | 7W-11L | -4.64u |

This matches the production Ops numbers Pixl saw, with the addition that the two open soccer approved picks are now visible as open ledger rows.

## What Would Become Results

These rows would appear in the **Results** surface.

### MLB Results

Import source:

```text
mlb_signal_log.db → mlb_signals
```

Included:

- 57 graded MLB signals
- record: **27W-30L**
- paper P&L: **-5.45 units**
- average CLV where present: **+4.23pp**

Markets included:

- h2h
- run line
- totals

Recommendation: **include in Results as historical model signal history.**

Reason: these rows appear to be prospective production signals, not backfills. They have detection times, odds, book, edge, status, and grading.

### NBA Results

Import source:

```text
signal_log.db → signal_log
```

Included:

- 25 graded NBA signals
- record: **11W-14L**
- paper P&L: **-4.00 units**

Excluded by default:

- 20 `proxy_captured` rows
- 2 `no_action` rows

Recommendation: **include only graded NBA rows in Results for now.**

Reason: `covered` is relative to the bet side, so graded W/L mapping is reliable. `proxy_captured` and `no_action` are not clearly tracked picks and should not be shown as Results until we define their meaning.

### Soccer Signal Results

Import source:

```text
wc_signal_log.db → soccer_signals
```

Included:

- 18 graded soccer signals
- record: **7W-11L**
- paper P&L: **-4.64 units**
- average CLV where present: **+2.37pp**

Recommendation: **include in Results as historical soccer signal history.**

Reason: these are actual `soccer_signals`, distinct from candidate/backfill data.

## What Would Become Today / Open Picks

These rows would appear in **Today/Open Picks** until graded or voided.

### MLB Open Picks

6 open MLB rows:

1. Washington Nationals @ Arizona Diamondbacks — totals under 9, BetRivers -108
2. Washington Nationals @ Arizona Diamondbacks — h2h home, BetRivers -122
3. San Francisco Giants @ Chicago Cubs — totals under 10.5, William Hill +105
4. San Francisco Giants @ Chicago Cubs — run line away -1.5, William Hill -115
5. San Francisco Giants @ Chicago Cubs — h2h home, BetRivers -162
6. Cleveland Guardians @ Texas Rangers — totals over 7.5, BetRivers +104

Recommendation: **include as open/awaiting-grade rows, but flag them as needing grade if game time is already past.**

### Soccer Approved Open Picks

2 open soccer approved picks:

1. PSG vs Arsenal · UCL Final — Over 2.5 goals, BetRivers +120
2. PSG vs Arsenal · UCL Final — Both teams to score yes, BetMGM -118

Recommendation: **include in Today/Open only after reconciliation, or show in Diagnostics as “awaiting grade” until fixed.**

Reason: the game date is already past. These should not remain “open” in a polished product. They need to be graded or explicitly voided.

## What Would Be Void / Non-Result

### MLB Push/Void Row

1 row:

- Washington Nationals @ Atlanta Braves — totals under
- source result detail: `push`
- canonical lifecycle: `void`

Recommendation: **keep but exclude from W/L record.**

Depending on product preference, this can display as Push instead of Void. Internally, it should not affect ROI except stake returned.

## What Stays Out of Results

### Soccer Model Candidates

Source:

```text
wc_signal_log.db → soccer_model_candidates
```

Production snapshot:

- 219 rows
- all graded
- record: 98W-121L
- win rate: 44.7%

Recommendation: **do not include in Results. Keep in Research.**

Reason: candidate rows appear to be backfilled/research validation. Their `game_date` predates `detected_at`/`created_at`, so they should not be represented as prospective tracked picks.

Product label:

```text
Research validation
```

Do not label as:

```text
Tracked picks
Actual picks
Betting results
```

### NBA Proxy / No-Action Rows

Excluded:

- 20 `proxy_captured`
- 2 `no_action`

Recommendation: **keep out of Results until semantics are confirmed.**

Potential placement:

- Research if useful for model behavior
- Diagnostics if mostly operational artifacts

### Soccer Prop Cards / Player Prop Results

Production has prop-card/player-prop tables, but these are not yet part of canonical tracked game picks.

Recommendation: **keep in Research/Diagnostics until productized.**

## Decision Points for Pixl

### Decision 1 — Results Inclusion

Approve that default Results includes:

- MLB `mlb_signals` graded rows
- NBA `signal_log` graded rows only
- Soccer `soccer_signals` graded rows

Recommended answer: **yes**

Pixl decision:

- [ ] Yes
- [ ] No
- [ ] Modify

### Decision 2 — Soccer Candidates

Approve that soccer model candidates stay in Research, not Results.

Recommended answer: **yes**

Pixl decision:

- [ ] Yes
- [ ] No
- [ ] Modify

### Decision 3 — NBA Proxy Captured Rows

Approve excluding NBA `proxy_captured` rows from Results until we understand them.

Recommended answer: **yes**

Pixl decision:

- [ ] Yes
- [ ] No
- [ ] Modify

### Decision 4 — Open Soccer Approved Picks

The 2 UCL Final soccer approved picks are stale-open.

Options:

A. Grade them now if final result and market resolution are clear.
B. Mark them as needing manual review in Diagnostics.
C. Void them because they are part of a leakage-aware experimental workflow.

Recommended answer: **B first, then grade/void after review.**

Pixl decision:

- [ ] A — grade now
- [ ] B — manual review first
- [ ] C — void
- [ ] Other

### Decision 5 — Push/Void Display

For pushed bets, public Results should probably say `Push`, not `Void`.

Recommended answer: **display Push, store as neutral result.**

Pixl decision:

- [ ] Yes
- [ ] No
- [ ] Modify

## My Recommendation

Approve this ledger split:

### Results

- 57 MLB graded signal rows
- 25 NBA graded signal rows
- 18 Soccer graded signal rows
- 1 MLB push/neutral row separately from W/L

### Today / Open

- 6 MLB open rows, flagged for grading if stale
- 2 Soccer approved rows, flagged as stale awaiting review

### Research

- 219 Soccer candidates
- NBA proxy/no-action rows
- Soccer props until productized
- Edge buckets, calibration, candidate backtests

### Diagnostics

- import run state
- raw table counts
- worker jobs
- quota
- stale/ungraded checks
- manual grading/sync controls

This is the cleanest professional product direction because it preserves production history, avoids pretending research rows were actual picks, and gives ACE one source of truth for paper-tracked performance.
