# ACE Ops Rebuild Decision Sheet — 2026-06-05

Purpose: organize the Ops reset before more implementation. This is a decision sheet for Pixl approval, not a code spec yet.

## Core Problem

Ops currently mixes several different concepts as if they are the same thing:

- model candidates
- signals
- approved picks
- tracked/paper picks
- graded results
- backtests
- diagnostics
- manual worker/admin controls

That makes ACE look less trustworthy than it is. A bettor/operator cannot quickly answer:

1. What are we tracking now?
2. What actually happened?
3. Is the model improving?
4. What is research vs an actual pick?
5. Is the system healthy?

## Current Data Reality

### NBA

- Source: `signal_log`
- Current local data: 19 signals, 13 graded, 5W–8L
- This is the only sport currently appearing as tracked/graded in Ops Overview.
- Problem: labels are technical (`soft_book_divergence/HOME`) and do not read like clean betting records.

### MLB

- Source expected by Ops: `mlb_signals`
- Current local data: 0 rows
- Product truth: no tracked MLB pick history exists in that table yet.
- Required UI behavior: say “No tracked MLB picks yet,” not imply missing/failed results.

### Soccer

- `soccer_signals`: 0 rows
- `soccer_approved_picks`: 0 rows
- `soccer_model_candidates`: 606 rows total, including 387 graded and 219 candidates
- Product truth: soccer has research/candidate/backtest-style data, but no approved/tracked pick record yet.
- Current UI risk: candidate rows can look like actual picks.

## Product Principle

Ops should prove ACE is disciplined.

Default Ops should not be a model lab. It should show clean operational truth:

- what ACE is tracking
- what happened
- whether the process is improving
- whether data is fresh enough to trust

Research and diagnostics are useful, but they need their own places.

## Canonical Lifecycle Proposal

Everything should eventually map into this lifecycle:

```text
candidate → approved/tracked pick → open → graded → performance/history
```

Definitions:

- **Candidate**: model idea/research item. Not a pick.
- **Approved/tracked pick**: intentionally selected for tracking/paper betting/real action.
- **Open**: game has not resolved yet.
- **Graded**: result is settled with win/loss/push/void.
- **Performance/history**: aggregate record, ROI, CLV, calibration, model version.

## Proposed Product Surfaces

### 1. Today

Question: what matters now?

Should show:

- active/open tracked picks
- upcoming tracked picks
- sport/game/market/side/line/odds/book
- game time in ET
- stake or paper stake if applicable
- reason snapshot
- status: open / awaiting grade / no action

Should not show:

- raw model queues
- stale candidates
- API quota
- manual sync buttons
- backtest rows

Decision:

- [ ] Approve
- [ ] Reject
- [ ] Modify

Notes:

-

### 2. Results

Question: what happened?

Should show:

- graded tracked picks
- W/L/push/void
- P&L / ROI
- CLV where available
- filters by sport, market, model version, date range
- empty states when a sport has no tracked picks yet

Should not mix in:

- unapproved candidates
- backfill/backtest candidates unless explicitly labeled as research validation

Decision:

- [ ] Approve
- [ ] Reject
- [ ] Modify

Notes:

-

### 3. Research

Question: what is the model finding or learning?

Should show:

- soccer candidates
- candidate grading/backtest history
- edge buckets
- model confidence/calibration work
- market-specific experiments
- sample-size warnings
- model version comparison

This is where soccer’s 606 candidate rows belong.

Decision:

- [ ] Approve
- [ ] Reject
- [ ] Modify

Notes:

-

### 4. Diagnostics

Question: is the system healthy and are workers running?

Should show:

- worker status
- data freshness
- API quota
- sync/refresh controls
- grading controls
- DB/table counts
- errors/log snippets
- admin-only tools

Decision:

- [ ] Approve
- [ ] Reject
- [ ] Modify

Notes:

-

## Required Backend / Data Work

### A. Unified `TrackedPick` Read Model

Create a normalized shape that all sports map into.

Suggested fields:

```ts
type TrackedPick = {
  id: string;
  sport: "nba" | "mlb" | "soccer" | string;
  source: "manual" | "model" | "candidate_approval" | "legacy_signal";
  lifecycle: "candidate" | "tracked" | "open" | "graded" | "void";
  gameId: string;
  gameDate: string;
  commenceTime: string | null;
  matchup: string;
  market: string;
  side: string;
  line: number | null;
  odds: number | null;
  book: string | null;
  stakeUnits: number | null;
  modelVersion: string | null;
  confidenceModelVersion: string | null;
  signalStrength: number | null;
  modelConfidence: number | null;
  edgePp: number | null;
  clvPp: number | null;
  result: "win" | "loss" | "push" | "void" | null;
  pnlUnits: number | null;
  openedAt: string | null;
  gradedAt: string | null;
  reason: string | null;
};
```

Decision:

- [ ] Approve
- [ ] Reject
- [ ] Modify

Notes:

-

### B. New API Routes

Recommended:

- `/api/ops/today` — open/upcoming tracked picks
- `/api/ops/results` — graded tracked picks and performance
- `/api/ops/research` — candidates/backtests/calibration
- `/api/ops/diagnostics` — worker/admin/system health

Decision:

- [ ] Approve
- [ ] Reject
- [ ] Modify

Notes:

-

### C. Data Classification Rules

Recommended mapping:

- NBA `signal_log` → legacy tracked signals/results
- MLB `mlb_signals` → tracked MLB signals when populated; empty state until then
- Soccer `soccer_approved_picks` → true soccer tracked picks/results
- Soccer `soccer_model_candidates` → Research, not Results
- Soccer `soccer_signals` → legacy/unused unless intentionally revived

Decision:

- [ ] Approve
- [ ] Reject
- [ ] Modify

Notes:

-

## Model Confidence Workstream

Important distinction:

- **Signal strength**: current price-discrepancy heuristic.
- **Model confidence**: calibrated probability/edge confidence from a validated model.
- **Statistical confidence**: sample-size/interval confidence in performance views.

Plan:

1. Audit every current `confidence`, `confidence_tier`, and `pick_confidence` field.
2. Rename heuristic confidence to signal strength where appropriate.
3. Build model confidence only after calibration exists.
4. Track calibration by bucket: predicted confidence vs realized win rate, CLV, sport, market, and sample size.

Decision:

- [ ] Approve
- [ ] Reject
- [ ] Modify

Notes:

-

## UX Direction

Recommended top-level Ops navigation:

```text
Today | Results | Research | Diagnostics
```

Alternative:

```text
Overview | Today | Results | Research | Diagnostics
```

Recommendation: use **Today | Results | Research | Diagnostics**. “Overview” usually becomes a junk drawer.

Decision:

- [ ] Use Today / Results / Research / Diagnostics
- [ ] Keep Overview
- [ ] Other

Notes:

-

## What I Recommend We Build First

### Phase 1 — Truth Layer

- Build normalized `TrackedPick` mapper/read model.
- Add `/api/ops/results` and `/api/ops/today`.
- Return honest empty states for MLB and soccer approved picks.
- Keep current UI mostly intact until data truth is clear.

Decision:

- [ ] Approve
- [ ] Reject
- [ ] Modify

### Phase 2 — Ops UI Reset

- Replace current Ops Overview with Today/Results default surface.
- Move soccer candidates/backtests into Research.
- Move quota/manual sync/admin buttons into Diagnostics.

Decision:

- [ ] Approve
- [ ] Reject
- [ ] Modify

### Phase 3 — Model Confidence

- Build confidence calibration views.
- Stop using unvalidated confidence as user-facing conviction.
- Promote model confidence only once validated.

Decision:

- [ ] Approve
- [ ] Reject
- [ ] Modify

## Strong Recommendation

Do **not** keep patching the current Ops page section-by-section.

The current page is a prototype cockpit. The next good step is to build a truthful data layer first, then rebuild the UI around Today, Results, Research, and Diagnostics.

## Approval Checklist

Pixl decisions needed:

- [ ] Confirm Ops should be rebuilt around canonical tracked picks/results.
- [ ] Confirm soccer model candidates belong in Research, not Results.
- [ ] Confirm `soccer_approved_picks` should become the source of truth for actual soccer picks.
- [ ] Confirm MLB should show honest empty state until `mlb_signals` has tracked rows.
- [ ] Confirm NBA `signal_log` can be treated as legacy tracked signal history.
- [ ] Confirm top-level nav: Today / Results / Research / Diagnostics.
- [ ] Confirm model confidence is a separate future workstream, not current UI polish.

## Open Questions

1. Should “tracked pick” mean paper-tracked only, real-bet only, or both with a field?
2. Should manual picks be allowed, or only model-approved picks?
3. Should old NBA signal history remain visible or be archived as legacy?
4. Should soccer graded candidate history be shown as backtest/validation, or hidden until we trust it?
5. Should Diagnostics be visible to all admins or only a private/local/internal mode?
