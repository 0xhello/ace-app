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

## Pixl Decision Pass — 2026-06-06

### Approved / clarified decisions

#### 1. Ops rebuilt around canonical tracked picks/results

Decision: **Approved.**

Ops should not keep mixing candidates, raw signals, approved picks, backtests, and diagnostics in one default surface. It should be rebuilt around a clean pick/result lifecycle.

#### 2. Soccer candidates in Research, not Results

Decision: **Approved with clarification.**

This does **not** contradict canonical tracked results. The distinction is:

- **Research**: model candidates, candidate grading, backtests, validation, learning material.
- **Results**: picks that ACE or Pixl intentionally tracked as paper picks.

Soccer model candidates still matter and should not be discarded. They are useful for learning and model validation. They should just not be presented as actual tracked picks unless they were intentionally promoted into tracking.

#### 3. `soccer_approved_picks` / tracked-pick source of truth

Decision: **Approve direction, modify naming/meaning.**

Pixl wants a workflow where:

- the model can produce picks without relying on Pixl;
- Pixl can also manually approve/add picks he personally likes;
- both can be paper-tracked;
- later ACE can compare Pixl/manual picks vs model picks to find edge, disagreement, and room for improvement.

Therefore the source of truth should not mean “only model-approved soccer picks.” It should mean a canonical **paper-tracked pick ledger** that supports multiple origins:

- `model_auto`
- `model_approved`
- `pixl_manual`
- `operator_manual`

Current `soccer_approved_picks` can either evolve into this ledger for soccer or be replaced/normalized behind a unified cross-sport tracked-picks read model.

#### 4. MLB empty state

Decision: **Approved.**

MLB should show an honest empty state until `mlb_signals` or the future tracked-pick ledger has rows. Do not imply MLB results disappeared.

#### 5. NBA `signal_log`

Decision: **Tentatively approved as current/early tracked signal history, not necessarily “legacy.”**

Pixl does not want useful data dismissed as legacy just because the architecture is changing. Treat NBA `signal_log` as existing tracked signal history unless/until we discover it is polluted, invalid, or no longer comparable.

#### 6. Top-level nav

Decision: **Approved direction.**

Use a professional app structure that prevents everything from being jumbled:

- Today
- Results
- Research
- Diagnostics

Avoid turning Overview into a junk drawer.

#### 7. Model confidence workstream

Decision: **Approved.**

Model confidence is not cosmetic UI polish. It is a model/data perfection workstream. UI can be packaged beautifully later, but the underlying data output has to become trustworthy first.

### Open-question answers

#### Q1. Should tracked pick mean paper-tracked only, real-bet only, or both?

Decision: **Paper-tracked only for now.**

Reason: avoid financial confusion/losses while ACE learns how to generate, track, and grade picks consistently across sports.

Future real-money tracking can be added later with a separate field/mode.

#### Q2. Should manual picks be allowed?

Decision: **Yes, manual Pixl picks should be allowed.**

Purpose:

- compare Pixl’s own research/edge vs model picks;
- track disagreement between human and model;
- allow Pixl to display a manually selected pick on the consumer-facing board when appropriate.

Manual picks must still be clearly labeled by origin in the data model.

#### Q3. Should old NBA signal history remain visible?

Decision: **Yes, keep it if useful.**

Do not call it legacy by default. Ask: can we learn from this data? If yes, preserve and label it accurately. Only archive or relabel as legacy if we confirm the model/process has materially changed enough that old rows are not comparable.

#### Q4. Should soccer graded candidate history be shown as backtest/validation or hidden?

Decision: **Keep it as research/validation data.**

Do not hide it just because it is not tracked-pick data. It may be exactly the learning data ACE needs. But label it correctly so it does not masquerade as actual paper-tracked picks.

#### Q5. Should Diagnostics be visible to all admins?

Decision: **Visible to all admins for now.**

Private/internal mode can be added later if needed.

## Updated Product Direction

The system should support two parallel but clearly separated lanes:

### Lane A — Paper-tracked picks

This is the operational truth layer.

- model auto picks
- model approved picks
- Pixl manual picks
- open/graded status
- paper P&L
- CLV
- model/human comparison

### Lane B — Research/validation

This is the learning layer.

- soccer candidates
- candidate grading
- backtests
- edge buckets
- calibration
- model confidence work
- stale/diagnostic warnings

Both lanes matter. The mistake is mixing them in the same table as if they mean the same thing.

## Additional questions before implementation

1. Should model-generated picks be allowed to enter paper tracking automatically when they clear strict rules, or should every pick require approval at first?
2. Should Pixl manual picks appear on the consumer-facing board immediately, or only after a separate “publish/display” toggle?
3. Should the paper-tracked ledger support all sports from day one, even if MLB/Soccer initially have empty states?
4. Should candidate rows ever be bulk-promoted into paper-tracked history retroactively, or should paper tracking only start prospectively from implementation date?
5. Should we create a new canonical table such as `tracked_picks`, or keep sport-specific tables and normalize only in API/read models first?

## Pixl Decision Pass 2 — 2026-06-06

### Model picks entering paper tracking

Decision: **Model picks should enter paper tracking automatically.**

Reason: requiring Pixl to approve every model pick is too much manual overhead. ACE should learn from its own paper-tracked picks and improve based on performance.

Guardrail: auto-paper-tracked does not mean real-money execution. It means ACE records the pick before the game, grades it, tracks CLV/P&L, and uses the result for model improvement.

### Consumer-facing display of manual picks

Decision: **Manual Pixl/operator picks can appear in the consumer-facing Signal Feed, but should not be labeled as “Pixl picks.”**

Product framing should be neutral/professional, e.g.:

- ACE tracked pick
- Featured signal
- Board signal
- Research desk pick

Need a data field for origin internally, but public labels should be polished ACE product copy.

### Existing three-sport graded data

Decision: **Investigate before trusting.**

Pixl remembers/expected graded picks across NBA, MLB, and Soccer, but only NBA currently appears as real tracked signal history in the current Ops API. Soccer has graded candidate/research rows, MLB tracking table is empty locally.

Task: audit whether prior MLB/Soccer graded rows exist elsewhere, whether they were legitimate prospective picks, backfills, candidates, or artifacts.

### Historical negative ROI / model improvement

Decision: **Investigate and learn, not hide.**

If ROI was negative, that is useful. The product should be honest and the model should improve from it. ACE needs analysis of why negative ROI happened:

- stale lines?
- bad edge calculation?
- poor market selection?
- overfit model?
- uncalibrated confidence?
- book/market availability mismatch?
- candidates generated after-the-fact or from contaminated data?
- insufficient CLV?

Bob should take professional responsibility here: investigate deeply and recommend what is best for ACE/product/business, not just ask Pixl to choose every technical detail.

### Backend foundation / DB migration vs API read model

Decision: **Build the foundation correctly for a real product.**

Plain-English translation:

- **DB migration** = changing/adding database tables so ACE has a clean permanent source of truth, e.g. a real `tracked_picks` table.
- **API/read model** = leaving old tables in place and writing code that reads/normalizes them into a cleaner shape for the UI.

Recommendation after Pixl clarification:

- For investor/customer readiness, ACE needs a proper canonical backend foundation, not just UI normalization.
- Use a new canonical tracked-pick ledger/table, with migration/backfill scripts, rather than relying forever on messy sport-specific tables.
- Existing data should be audited and imported/classified carefully, not blindly dumped into the new table.

Updated direction:

1. Audit existing NBA/MLB/Soccer data thoroughly.
2. Classify each dataset: tracked pick, candidate, backtest, artifact, unusable.
3. Design canonical `tracked_picks` ledger.
4. Migrate/import only trustworthy historical tracked data.
5. Keep research/candidate history separate but linked where useful.
6. Build Today/Results/Research/Diagnostics off the new foundation.


## Production/Local Data Divergence Finding — 2026-06-06

Pixl provided screenshot evidence showing MLB Ops record `27–30`, `57 graded`, `64 signals`, `6 open`, ROI `-9.6%` on the live app.

Authenticated production check confirmed the screenshot is real and current on live ACE:

### Production `/api/ops/overview`

- Soccer: `18` signals, `18` graded, `7W / 11L`, win rate `38.9%`, ROI `-25.8%`
- MLB: `64` signals, `6` open, `57` graded, `27W / 30L`, win rate `47.4%`, ROI `-9.6%`
- NBA: `47` signals, `25` graded, `11W / 14L`, win rate `44.0%`, ROI `-16.0%`

### Local DB comparison

Local `ml/nba_spread/data/mlb_signal_log.db` exists but `mlb_signals` has `0` rows.

Local soccer DB path is different: soccer signal rows are in production but local `wc_signal_log.db` currently has:

- `soccer_signals`: `0`
- `soccer_approved_picks`: `0`
- `soccer_model_candidates`: `606`
- `soccer_prop_cards`: `418`
- `soccer_player_prop_results`: `73`

### Updated conclusion

The MLB/Soccer tracked signal history was not deleted by the local Ops cleanup. It exists on production/live DB state but not in the local DB snapshot.

Therefore, migration readiness now requires a **production data export/backup step** before any canonical ledger migration.

### Updated migration requirement

Do not build/import the canonical `tracked_picks` ledger from local data alone.

Required sequence:

1. Export/backup production SQLite DBs or relevant signal tables read-only.
2. Store a timestamped local audit snapshot.
3. Compare prod vs local table counts and schemas.
4. Classify production rows:
   - true prospective signal/tracked pick
   - model candidate/research item
   - manual/operator pick
   - artifact/backfill/unusable
5. Design canonical `tracked_picks` schema.
6. Import only classified/trustworthy rows.

### Product note

The live app is currently showing real tracked signal history across all three sports, but the data is negative ROI across the board:

- NBA: `-16.0%`
- MLB: `-9.6%`
- Soccer: `-25.8%`

This should not be hidden. It should drive model debugging: edge thresholds, market selection, CLV behavior, stale line capture, book quality, sample size, and confidence calibration.
