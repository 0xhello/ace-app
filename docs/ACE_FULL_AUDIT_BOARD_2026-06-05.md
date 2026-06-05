# ACE Full Audit Board — 2026-06-05

Purpose: slow, exhaustive reality check of ACE before more feature work. This is not a quick bug-fix list. Every screen, label, metric, data source, button, and workflow should earn its place.

## Ground Rules

- Audit first, fix second. Do not hide problems by patching symptoms before we understand source-of-truth.
- One source of truth per concept: confidence, tier, edge, game time, odds, sport terminology, pick status.
- Every user-facing metric needs a plain-English answer to: what is it, where does it come from, when was it updated, and what should Pixl do with it?
- No cross-sport copy leaks: baseball has runs, soccer has goals, basketball has points, etc.
- Ops pages must explain their job or be removed/hidden until they do.
- Local commits by default; batch push/deploy intentionally.

## Immediate User-Reported Issues

| ID | Area | Symptom | Initial severity | Status | Notes |
|---|---|---|---:|---|---|
| AUD-001 | Signal Feed → BetSlip | Signal feed shows 95 confidence, betslip shows Medium/Low for same pick | P0 | Open | Trace confidence/tier mapping end-to-end. |
| AUD-002 | Game Row | Game time lacks timezone label | P1 | Open | Probably should display ET for sports schedule context, but verify source. |
| AUD-003 | Game View | Cubs game time displayed as 6:21pm ET; expected 2:21pm ET | P0 | Open | Need source/API/raw timestamp/timezone trace. |
| AUD-004 | Game View copy | Baseball total says “goals” | P1 | Open | Cross-sport language leak. Audit all copy templates. |
| AUD-005 | Ops Overview | Too many unexplained numbers; unclear meaning/action | P0 | Open | Define job of page or simplify drastically. |
| AUD-006 | Soccer Ops | Old picks/friendlies/buttons/status unclear | P0 | Open | Separate data storage, model ops, pick review, and experiments. |
| AUD-007 | Basketball Ops | Unknown if working/what works | P0 | Open | Verify data freshness, routes, model artifacts, UI claims. |
| AUD-008 | Baseball Ops | Unknown if real | P0 | Open | Verify sources, generated picks, market data, grading/status. |

## Audit Map

### 1. Product/UI Inventory

- [ ] Dashboard home
- [ ] Signal feed / top AI picks
- [ ] Bet slip
- [ ] Game rows/cards
- [ ] Game detail view
- [ ] Tracked games
- [ ] Alerts
- [ ] Performance page
- [ ] Settings
- [ ] Ops overview
- [ ] Ops soccer
- [ ] Ops basketball/NBA
- [ ] Ops baseball/MLB
- [ ] Ops NFL / placeholder tabs
- [ ] Ask ACE

For each page/component:
- What is this page for?
- What should Pixl do after reading it?
- Which data is real vs placeholder/mock/stale?
- Which labels are confusing, duplicated, or wrong?
- Which buttons mutate data? Which are safe? Which should be hidden?

### 2. Data + Source-of-Truth Inventory

- [ ] Games API and schedule timestamps
- [ ] Odds API / market data inputs
- [ ] Pick generation APIs
- [ ] Confidence / tier / edge mapping
- [ ] Bet review / approval / grading APIs
- [ ] Soccer model artifacts and cached data
- [ ] NBA model artifacts and cached data
- [ ] MLB ops/pipeline artifacts
- [ ] Database tables/files that persist picks, signals, grades, games, odds

For each source:
- Owner/source
- Freshness
- Schema
- Consumer screens
- Known failure modes
- Whether we should persist it in ACE database

### 3. Copy + Sports-Language Audit

- [ ] Baseball terminology: runs, moneyline, run line, total
- [ ] Soccer terminology: goals, 1X2, handicap, BTTS, friendlies context
- [ ] Basketball terminology: points, spread, total
- [ ] Generic betting terms: confidence, edge, book line, model fair line
- [ ] Remove duplicated/repeated conclusions across modules

### 4. Ops Page Reality Check

Each Ops tab gets one of these outcomes:

- **Keep & clarify** — useful, real, actionable.
- **Move to diagnostics** — useful only for debugging/internal state.
- **Hide behind advanced/dev** — not for daily use.
- **Delete/retire** — stale or confusing.
- **Rebuild later** — concept valid, implementation currently bad.

### 5. Fix Queue Format

| ID | Finding | Root cause | Decision | Owner | Status |
|---|---|---|---|---|---|
| TBD |  |  |  | Bob | Not started |

## Open Questions for Pixl

1. Should the audit target **local ACE only first**, or compare local vs production from the start?
2. For game times, should ACE standardize all schedule displays to **ET**, with explicit labels everywhere?
3. Should Ops be designed mainly for **Pixl daily decision-making**, **developer diagnostics**, or split into two separate modes/pages?
4. Should stale picks from prior weeks be visible anywhere by default, or only in historical/performance views?

## Pixl Alignment — 2026-06-05 05:46 PT

### Environment / Local vs Production

Pixl is unsure whether local and production have drifted. Treat this as a core audit item, not an assumption.

Decision:
- Do **not** make production changes during the audit.
- Use local as the inspection/design workspace.
- Compare local vs production intentionally to understand drift, but protect production as the source users see.
- Any production deploy must be a separate explicit decision after audit findings and local verification.

Production quality bar:
- No hardcoded user-facing fake data.
- No fallback data that silently pretends to be real.
- If data is missing/stale/unavailable, the UI must say so clearly.
- Real state/data must remain clean and flawless for users.

### Timezone

Decision:
- Standardize game-time display to **ET everywhere**, with explicit `ET` label.
- Audit raw timestamp/source conversions before changing display logic.

### Ops Purpose Reset

Background:
- Ops began as a way for Pixl to visually see what Bob/Claude Code were building and verify activity when the product was mostly one NBA spread-tracking model.
- Now ACE has multiple sports and the current Ops surface is overwhelming.

Decision:
- Ops should now be about **picks and results only** for Pixl.
- Developer/model/code/data diagnostics should move out of Pixl’s default Ops view.
- Bob/Claude can keep processing, storing, and auditing diagnostics behind the scenes, but the user-facing Ops page should be simple and decision-oriented.

Proposed split:
- **Ops / Results**: current picks, recent picks, grades/results, basic performance.
- **Diagnostics / Admin**: data freshness, pipelines, artifacts, probes, debug buttons, source checks.

### Stale Picks

Decision:
- Hide stale/old picks from default views.
- Show only recent/contextually relevant picks by default.
- Keep older picks stored and easy to find in history/performance, but do not clutter daily surfaces.

## Uncertainty Protocol

Pixl explicitly wants uncertainty surfaced instead of guessed through, especially because Claude Code authored parts of the code and intent may not be obvious.

When Bob finds something unclear:
- Add it to an **Unclear / Ask Pixl** list instead of silently deciding.
- Include: file/page, what is unclear, likely interpretations, risk if changed, and a recommended question.
- Do not delete, rewrite, or hide unclear functionality until intent is understood, unless it is clearly broken and safely reversible.

### Unclear / Ask Pixl Queue

| ID | Area | What is unclear | Risk if guessed | Question for Pixl | Status |
|---|---|---|---|---|---|
| TBD |  |  |  |  | Open |

## Findings Log — Initial Pass

| ID | Area | Finding | Root cause / evidence | Proposed disposition | Status |
|---|---|---|---|---|---|
| FIND-001 | Signal Feed → BetSlip | Confidence shown in the Signal Feed can diverge from BetSlip confidence for the exact same selected pick. | `TopAIPicks` passes only `{id, gameId, matchup, market, label, odds}` into `onAddLeg`; it does **not** pass `pick.confidence`. `BetSlip.confidenceForLeg()` then looks up `intelMap[leg.gameId].confidence`, i.e. game-level confidence, not pick/market confidence; if missing it falls back to `low / 50`. | Fix by adding a single confidence source-of-truth to `SlipLeg` or mapping selected leg back to pick/market confidence. Do not let BetSlip silently downgrade a selected 95 pick. | Confirmed |
| FIND-002 | Game Row time | Game row time is browser-local and unlabeled. | `GameRow.formatUpcomingStart()` uses `game.toLocaleTimeString([], ...)` without `timeZone`, and secondary uses `timeUntilGame()` with local Date math. No `ET` label. | Standardize formatting helper to ET with explicit label; use same helper everywhere. | Confirmed |
| FIND-003 | Game View time | Game detail view appends `ET` but formats in the runtime timezone, not ET. This can be very wrong on production if server renders in UTC. | `kickoff()` in `src/app/dashboard/game/[gameId]/page.tsx` calls `new Intl.DateTimeFormat("en-US", {...}).format(new Date(iso)) + " ET"` without `timeZone: "America/New_York"`. | Fix with shared ET formatter. This likely explains the Cubs mismatch. Need verify raw Cubs ISO before finalizing exact offset. | Confirmed / needs raw-game verification |
| FIND-004 | Game View copy | Shared market read says “On goals...” for any sport using totals, including baseball. | `src/lib/market-read.ts` is generic over `Game` but hardcodes soccer language: `goalsLean`, `No goals line`, `On goals`. | Split terminology by sport: baseball runs, basketball/NFL points, hockey goals, soccer goals. | Confirmed |
| FIND-005 | Local fallback data | Local dashboard can silently replace empty real odds with mock games. | `GamesFeed.tsx`: if `games.length === 0 && IS_DEV`, uses `getMockGames()`. This is okay for local design, dangerous if copied into production-like flows or visually mistaken as real. | Keep only if clearly marked local/dev and impossible in prod; audit UI labels so local mock data can’t be mistaken for real production state. | Needs decision |
| FIND-006 | Ask ACE fallback | Ask ACE returns demo answers when API key/fetch fails. | `/api/ask-ace/route.ts` uses `demoResponse()` and returns `{ demo: true }`; UI shows a small demo badge, but user could still treat answer as live analysis. | For production quality, prefer explicit unavailable state over fake analysis. | Needs decision |
| FIND-007 | Ops mutating actions | Ops contains many manual triggers/buttons: NBA fetch/grade/log bet, soccer approve/sync/grade/refresh, WC squad sync, etc. | Initial grep found numerous `POST`/sync/approve/grade buttons across `NBAOpsTab`, `SoccerOpsTab`, `SuggestedPicksPanel`, `PlayerPriorsPanel`, `FriendliesPanel`. | Move diagnostics/manual jobs out of default Ops. Keep only picks/results for Pixl. Mutating controls should be admin/diagnostics with clear consequences. | Confirmed direction |

### Verification Notes — Cubs Time / Copy

- Local `/api/board` raw Cubs game: `San Francisco Giants @ Chicago Cubs`, `commence_time = 2026-06-05T18:21:00Z`.
- Correct ET conversion: **2:21 PM ET** on 2026-06-05.
- Local rendered game detail currently shows `Fri, Jun 5, 11:21 AM ET` because the server process is using Pacific time but appending `ET`.
- Pixl saw `6:21 PM ET` likely on production because Railway/server runtime is UTC and the same formatter appended `ET` to UTC time.
- Same rendered Cubs page contains `On goals`, confirming the cross-sport copy leak on baseball totals.

## Sub-Audit Merge — UI / Data / Ops Initial Results

### UI Audit Additions

| ID | Area | Finding | Disposition | Status |
|---|---|---|---|---|
| FIND-008 | Tracked games | `src/app/dashboard/tracked/page.tsx` also uses local `toLocaleTimeString()` for `commence_time`. | Include in shared ET formatter fix. | Confirmed |
| FIND-009 | Homepage | Homepage contains hardcoded WC 2026/time/beta marketing copy and emojis. | Audit separately for launch truth/brand consistency; not urgent for betting logic but risky if stale. | Open |
| FIND-010 | Alerts | Alerts page has destructive/mutating delete action. | Ensure deletion UX is clear and recoverable/confirmed if needed. | Open |

### Data / Source-of-Truth Audit Additions

| ID | Area | Finding | Disposition | Status |
|---|---|---|---|---|
| FIND-011 | Soccer picks/results | Soccer picks/results are DB-backed through tables including `soccer_model_candidates`, `soccer_prop_cards`, and approved-pick tracking. | Keep the data, redesign the presentation. | Confirmed |
| FIND-012 | Soccer stake sizing | Approved soccer picks use quarter-Kelly with leakage-aware caps because prior soccer model validation had overfit/leakage caveats. | Good risk hygiene, but detailed explanation belongs in diagnostics/admin; user-facing view should show simple stake/exposure with tooltip if needed. | Confirmed |
| FIND-013 | Soccer recent picks | Soccer “recent” can mix graded model candidates and graded prop cards into one payload. | Likely split by pick type or summarize; avoid feeling like random old data. | Open |
| FIND-014 | Date handling | Some soccer/date code derives date via `commence_time[:10]`, which is UTC-date, not necessarily ET-date. | Include in timezone audit; use ET date helper consistently. | Confirmed |

### Ops Audit Additions

Default Ops should become **picks/results + light health summary**. Anything that changes data, spends API credits, runs jobs, exposes raw candidate/model internals, or manages users should move to Diagnostics/Admin.

#### Keep for Pixl default Ops / Results

- Cross-sport summary: current picks, recent results, record, ROI.
- NBA: paper bankroll, paper bet history, live watch, today/open signals, my bets.
- MLB: record, ROI, open signals, today slate, CLV summary.
- Soccer: record, ROI, open plays, approved picks / ticket, exposure warning, CLV/P&L per approved pick, high-level availability only if directly relevant to a pick.

#### Move to Diagnostics/Admin

- Overview: performance over time, edge buckets, comparison workbench, quota strip if not needed daily.
- NBA: worker/status strip, alerts, edge validation, model performance, live divergences, picks log, model intelligence, pipeline health, manual job triggers.
- MLB: worker status, manual scan/grade, by-market/by-book, stale signals, activity stream, schema footer.
- Soccer: error banners, raw suggested picks, friendlies panel, full match intelligence grid, candidate queues, raw actual picks, prop cards, worker status, manual job row, detailed KPI strip, football analysis panel, market probe, player priors, stale/activity panels.
- Users: entire tab should become Admin, not default Ops.

#### Retire / Hide Candidates

- NFL placeholder if reducing clutter now.
- Soccer SuggestedPicksPanel until it has a live source and no empty hardcoded `TODAYS_PICKS` behavior.
- Soccer ActualPicksPanel old raw view if ApprovedPicksDashboard is the cleaner source.
- `/api/ops/refresh-game-intel` if confirmed legacy/stubby.

#### Mutating / Credit-Spending Controls Found

- NBA: `Log Bet` → `POST /api/ops/execution`; `Run picks now` / `Grade now` → `POST /api/ops/pipeline`.
- MLB: `Scan odds` / `Grade signals` → `POST /api/ops/mlb`.
- Soccer: approve/watch/reject/status updates, approved-pick creation, friendly sync, squad sync, market probe, scan odds, run model, grade signals, grade candidates, grade props, live pipeline, prop card build/price, Sportmonks inventory.
- Users: invite generation.
- Several `GET` routes still trigger work/syncs; treat as mutating despite GET semantics.

### Ask Pixl Queue Additions

| ID | Area | What is unclear | Risk if guessed | Question for Pixl | Status |
|---|---|---|---|---|---|
| ASK-001 | Local mock games | Local dev mock fallback makes design easier but can visually look real. | Could accidentally trust fake local board state. | Keep local mock fallback if clearly labeled “local demo data,” or remove it entirely and show unavailable state when odds fail? | Open |
| ASK-002 | Ask ACE demo fallback | Ask ACE currently returns demo-style analysis when AI/API fails. | Users may treat fake answer as real betting intelligence. | Should production Ask ACE show “temporarily unavailable” instead of any demo/fallback answer? | Open |
| ASK-003 | Ops Users tab | User/invite admin exists inside Ops. | Default Ops remains cluttered and mixes product ops with account admin. | Move Users to separate Admin area? | Open |
| ASK-004 | Soccer power tools | MarketProbe, PlayerPriors, Friendlies can be useful but are code/data-heavy. | Pixl default surface stays overwhelming. | Should all soccer power tools move to Diagnostics/Admin by default? | Open |
| ASK-005 | Match Intelligence grid | Soccer grid includes markets marked no-bet/losing. | Human may misread rejected markets as suggestions. | Hide no-bet/losing markets from default view and keep only approved/current picks? | Open |

## Small Details Sweep — Before Confirmation

| ID | Area | Detail | Why it matters | Status |
|---|---|---|---|---|
| FIND-015 | Dashboard filters | `TODAY` filter uses `new Date(g.commence_time).toDateString()` in browser-local timezone. | A game near midnight UTC/ET can appear under the wrong day for users. Use ET date. | Confirmed |
| FIND-016 | Board update labels | Dashboard header uses local `toLocaleTimeString()` for `Updated` / `Polled`. | Less severe than game time, but inconsistent with ET standard. Needs label or local wording. | Open |
| FIND-017 | Compact live/upcoming rows | Dashboard compact grouped rows also use local `toLocaleTimeString()` with no ET label. | Same timezone inconsistency as main game rows. | Confirmed |
| FIND-018 | ModelPerformanceCard / shared Ops primitives | Several diagnostic refreshed-at labels use local time without saying local/ET. | Fine inside diagnostics if labeled, but should not leak into user-facing Ops as ambiguous time. | Open |
| FIND-019 | FriendliesPanel | Friendlies uses `Intl.DateTimeFormat(undefined, ...)` which means viewer-local time. | If friendlies stay visible, they need the same ET convention or explicit local label. | Open |
| FIND-020 | API semantics | Multiple GET routes trigger sync/grade/refresh work. | Risky for accidental runs/crawlers/caches; should be POST or protected diagnostics-only. | Confirmed |
| FIND-021 | Signal system legacy | `src/lib/signals.ts` still describes a deterministic mock signal system; `src/lib/confidence.ts` says it replaced hash-based mock. | Need verify whether legacy mock signals still feed anything user-facing. | Needs trace |
| FIND-022 | SignalBadge demo marker | `SignalBadge` can render `· demo` for demo signals. | Good that it labels demo, but production should probably not show demo signals at all. | Open |
| FIND-023 | Game detail mock fallback | Game detail imports `getMockGames()` and uses it in dev if real games fail. | Same mock-data concern as dashboard, but on detail pages too. | Needs decision with ASK-001 |
| FIND-024 | Maintenance copy | Empty real games in dashboard shows “servers are under maintenance,” even if the real problem is odds API outage/credit/config. | User-facing error reason may be inaccurate. Should show honest data-unavailable state. | Open |
| FIND-025 | Homepage hardcoded launch/WC copy | Homepage has fixed WC 2026 dates/times and emoji sports markers. | Can go stale or violate design-system polish; separate marketing audit needed. | Open |
| FIND-026 | NBA fallback wording | NBA Ops has “Pinnacle vs fallback” / “fallback confidence threshold only.” | Internally meaningful, but confusing in default Ops. Move diagnostics. | Confirmed direction |
| FIND-027 | Soccer no-bet caveat copy | Soccer text says full opinion includes unvalidated/no-bet markets and points to Diagnostics. | Good honesty, but default page should not make Pixl parse losing/no-bet markets. | Confirmed direction |
| FIND-028 | CLV/ROI/Kelly vocabulary | Default Ops uses CLV, ROI, Kelly, edge, stale, fallback heavily. | For Pixl default Ops, keep ROI maybe, explain CLV simply, hide Kelly/fallback/stale diagnostics unless needed. | Open |

## Confirmed Fix Batch — Pixl 2026-06-05 06:08 PT

Pixl confirmed the first fix batch, with one exception:

- Fix now: ET/date consistency, confidence source-of-truth, sport-specific copy, production-safe demo/mock/fallback behavior, Ops declutter/default simplification, GET-trigger/job-route risk where safely addressable.
- Do **not** fix homepage hardcoded WC/time/beta copy yet.
- Homepage should be audited last. Bob should elaborate on those findings later and remind Pixl before starting the homepage pass.

### Reminder / Later Pass

Homepage-last TODO:
- Explain hardcoded WC 2026/time/beta copy risks.
- Audit homepage launch truth, dates, invite/beta wording, sports markers, and brand/design polish after product/dashboard/Ops cleanup is stable.

## Fix Batch 1 Implementation — 2026-06-05

Status: implemented locally; `npm run build` passed.

### Fixed

- ET formatting helper added: `src/lib/time-format.ts`.
- Dashboard/game row/tracked/game detail times now use explicit ET formatting for user-facing game times.
- Dashboard `Today` filter now compares ET date keys instead of browser-local dates.
- Cubs verification: raw `2026-06-05T18:21:00Z` renders as `Fri, Jun 5, 2:21 PM ET`.
- BetSlip confidence now preserves selected pick confidence from Signal Feed instead of silently falling back to game-level confidence/low.
- Market read total language is sport-aware:
  - MLB/baseball: runs
  - NBA/NCAAB/NFL: points
  - NHL/soccer: goals
- Ask ACE no longer returns demo betting reads when AI/API is unavailable; it returns an honest unavailable response.
- Dashboard/game detail silent dev mock-game fallback removed from user-facing flows.
- Empty board copy changed from generic maintenance to honest real-data-unavailable messaging.
- Ops tab bar default decluttered: removed Users/Admin and NFL placeholder from default Ops navigation; files remain for later Admin/Diagnostics split.

### Verified

- `npm run build` passed.
- Local runtime spot check after clean dev-server restart:
  - `/api/board` returned 45 games.
  - Cubs page includes `2:21 PM ET`.
  - Cubs page no longer includes `11:21 AM ET` or `6:21 PM ET`.
  - Cubs page uses `On runs`, not `On goals`.
  - `/api/ask-ace` without live AI service returns HTTP 503 with honest unavailable response.

### Still Open / Next Batch

- Full Ops Results vs Diagnostics split: move mutating job buttons, raw model internals, API-credit tools, admin Users, stale/activity panels, and lab vocabulary out of Pixl default Ops.
- GET routes that trigger work should be converted/protected in Diagnostics/Admin where safely addressable.
- Legacy mock signal code trace: verify whether old deterministic/demo signals still feed any production user-facing UI.
- Homepage copy audit remains saved for last by Pixl decision.

## Model Confidence Workstream — Added 2026-06-05

Pixl clarified that merely carrying Signal Feed confidence into BetSlip is not enough. The current Signal Feed score should be treated as **signal strength / price-discrepancy strength**, not proof that ACE has a calibrated model-confidence system.

Task list:
- Audit every source of `confidence`, `confidence_tier`, `pick_confidence`, and recommendation confidence across dashboard, Ops, tracked bets, model artifacts, and APIs.
- Separate terminology:
  - **Signal strength** = price discrepancy / market-data heuristic.
  - **Model confidence** = calibrated probability/edge confidence from an actual validated model.
  - **Confidence interval / sample confidence** = statistical uncertainty in Ops/performance views.
- Build/validate actual model confidence before product copy implies ACE has reliable confidence calibration.
- Track calibration by bucket: predicted confidence vs realized win rate, CLV, sample size, sport, market, and time horizon.
- Until validated, avoid wording like “high confidence” in default user-facing pick surfaces when the underlying score is only a heuristic.

## Fix Batch 2 Implementation — Ops Default Reset — 2026-06-05

Status: implemented locally; pending build/verification at time of note.

### Fixed

- Ops Overview labels were adjusted toward picks/results, but product-copy leakage was later corrected and the broader Ops structure still needs redesign.
- Cross-sport Overview default labels changed from generic signal language to tracked-pick/result language.
- Overview diagnostics moved out of the default path and into collapsed `Diagnostics`:
  - Odds API quota strip
  - performance-over-time lab
  - edge-bucket validator
  - comparison workbench
- Recent cross-sport table renamed from `Recent signals` to `Recent picks/results`.
- Ops sport descriptions updated to state the default purpose: picks, open plays, and graded results.

### Still Open / Later Ops Work

- NBA, MLB, and Soccer tabs already use `Diagnostics`, but still need a tighter product pass to ensure every default panel is truly picks/results-only.
- Mutating job buttons/API spenders should eventually require a dedicated Diagnostics/Admin mode, not just a collapsed section.
- Soccer candidate approval/rejection UX needs a decision: keep as Pixl-facing pick review, or move to Diagnostics/Admin if it becomes too operator-heavy.
- Users/Admin remains removed from the default tab bar, but should get a proper Admin route later.

## Ops Source-of-Truth Audit — Added 2026-06-05

### Confirmed data reality

- `/api/ops/overview` currently reports:
  - Soccer: `total=0`, `graded=0`, `open=0`
  - MLB: `total=0`, `graded=0`, `open=0`
  - NBA: `total=19`, `graded=13`, record `5W-8L`
- `ml/nba_spread/data/mlb_signal_log.db` exists but `mlb_signals` has `0` rows.
- `ml/nba_spread/data/wc_signal_log.db` has:
  - `soccer_signals`: `0` rows
  - `soccer_approved_picks`: `0` rows
  - `soccer_model_candidates`: `606` rows (`219 candidate`, `387 graded`)
- `/api/ops/soccer` returns `actualPicks` from candidate/shortlist logic, not actual approved picks. This is confusing because the UI can look like there are picks, while the real approved-picks table is empty.
- `/api/ops/approved-picks` and `/api/picks/history` both return zero picks because `soccer_approved_picks` is empty.

### Product conclusion

Ops currently has no single canonical definition of a pick/result:

1. NBA uses `signal_log`.
2. MLB expects `mlb_signals`, but that table is empty.
3. Soccer has historical graded candidate rows in `soccer_model_candidates`, but approved/actual pick history is empty and `soccer_signals` is empty.

This means the UI cannot truthfully present cross-sport results until the product chooses and implements a canonical pick lifecycle:

`candidate → approved/tracked pick → open → graded → performance/history`

### Recommended direction

- Create a unified read model for Ops results across sports, e.g. `/api/ops/results`, that normalizes NBA, MLB, soccer candidates, and approved soccer picks into one `OpsPickResult` shape.
- Clearly separate:
  - **Research candidates**: model ideas, not picks.
  - **Tracked picks**: approved/selected plays we actually care about.
  - **Historical backtest/candidate grading**: validation evidence, not an active ticket record.
- Do not show candidate rows as “actual picks” unless they were explicitly approved/tracked.
- Surface empty states honestly: “No tracked MLB picks yet” is better than an empty table that implies data disappeared.
