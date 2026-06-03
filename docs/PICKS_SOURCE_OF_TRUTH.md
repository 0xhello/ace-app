# Picks — Source of Truth

**Status:** canonical reference (2026-06-03). Written during the OPS-CLEAN pass.
If a pick shows up anywhere, it MUST trace to a source in this doc. Anything
else is a bug.

The goal: at a glance, know what is **real, current, experimental, or
subscriber-facing** — and never see stale or demo data presented as live.

---

## 1. Where every pick surface gets its data

### Consumer (subscriber-facing)

| Surface | Source | Notes |
|---|---|---|
| `/dashboard` games board | Live odds board — `fetchAllGames()` (Odds API). **Dev-only** mock fallback when out of credits. | Real games. No picks here, just the board. |
| `/dashboard` Signal Feed (`TopAIPicks`) | `generateLivePicks(games)` — a **price-discrepancy heuristic** (best price vs consensus), NOT the soccer model. | Sport-routed (see §4). These are "price edge" signals, not model predictions. |
| `/performance` (public) | Graded rows from `soccer_approved_picks`, **current model_version only**. | The honest public track record. Losses shown. CLV-forward. |
| `/dashboard/tracked` | The user's own tracked bets via `/api/bets`. | Personal ledger, not ACE picks. |

Soccer **model** signals are intentionally **excluded** from the consumer feed
(`GamesFeed.tsx`) until a market clears the backtest bar. Soccer *games* still
appear on the board; they just don't get an ACE pick chip yet.

### Ops (internal trading desk, `/dashboard/ops`)

| Panel | Source | Empty state |
|---|---|---|
| Approved Picks | `soccer_approved_picks` DB (all model versions) | clean — table is empty post-purge |
| Featured Pick / Match Intelligence | `/api/ops/featured-fixture` (live 14-day fixture scan) → `/api/ops/match-intelligence` model | "No upcoming fixture to feature" — **no hardcoded fallback** |
| Suggested Picks | `TODAYS_PICKS` — **currently empty** (no seed) until the WC model wires in | honest empty state |
| Friendlies | `/api/ops/soccer/friendlies` (live Sportmonks scan) | empty when no friendlies |
| Overview | `/api/ops/overview` (live DB + signals) | — |
| NBA / MLB / NFL | live signals + DB | — |

---

## 2. Pick statuses (the `graded_status` column)

`soccer_approved_picks.graded_status`:

| Status | Meaning | Where it shows |
|---|---|---|
| `open` | Approved, not yet settled | Ops "active"; **only valid if kickoff is in the future** |
| `won` / `lost` / `push` | Settled (graded) | Ops history + public `/performance` |

There is no "stale" status. **Stale = an `open` pick whose kickoff is in the
past** — that's a bug: the grader (auto-runs daily; manual via
`/api/ops/soccer/grade-approved-picks`) should have settled it. If you see one,
it's a data/grading issue, not a state.

---

## 3. Active vs graded vs stale vs experimental

- **Active** — `graded_status = open` AND `commence_time` is in the future. A
  real, live, un-settled pick.
- **Graded** — `won` / `lost` / `push`. Part of the track record.
- **Stale** — `open` but kickoff has passed. Should never appear; indicates the
  grader didn't run or a demo pick was injected. (This pass purged 4 such UCL
  pilot rows.)
- **Experimental** — a market **not proven** by the V2 backtest. Shown with an
  explicit "experimental / not proven" label. Never presented as a confirmed
  bet and **not one-click-approvable** in ops.

### What's "proven" vs "experimental" (per `SOCCER_MODEL_BACKTEST_V2.md`)

| Market | Verdict | In ops |
|---|---|---|
| **Over 2.5 goals** | **PROVEN** (+8.83%, leakage-free test) | `bet` — the only approvable market |
| Under 2.5 / 1X2 (all) | loses | `loses` badge, not approvable |
| BTTS yes/no | tested, not proven | `experimental` badge, not approvable |
| Corners | conclusively not proven (R1) | `loses` badge, not approvable |
| Anytime scorer | can't validate yet (data gap) | experimental / exposure only |

---

## 4. Consumer sport-tab routing (the fix that mattered)

Tabs: ALL / SOCCER / NBA / NFL / MLB / NHL / NCAAB.

Routing goes through **`src/lib/sport-tab.ts` → `sportTab(game.sport, …)`**,
keyed on the reliable Odds-API `sport_key` (`soccer_fifa_world_cup`,
`baseball_mlb`, …). **Never** route on `sport_title` substring — that bug made
"FIFA World Cup" fail to match "SOCCER", so 20 WC games were invisible on the
Soccer tab.

Guarantees:
- A soccer pick (any competition: WC, UCL, EPL…) shows **only** under SOCCER.
- MLB only under MLB, NBA only under NBA, etc. No cross-leak.
- **All** tab = top picks across sports, score-ranked, one per game (not a dump).

---

## 5. Invariants (don't regress these)

1. **No hardcoded fixtures/picks as fallback.** When a live source is empty,
   render an honest empty state — never resurrect a settled match (e.g. the old
   PSG–Arsenal UCL final).
2. **Sport routing uses `sportTab()` (sport_key), never title substring.**
3. **Every ROI number cites `SOCCER_MODEL_BACKTEST_V2.md`** — the single source.
   Only Over 2.5 is a "bet"; everything else is experimental or loses.
4. **Only proven markets are approvable** in ops; experimental ones are labeled.
5. **Public `/performance` shows current-model-version graded picks only** —
   legacy v1 backfill stays ops-only.
6. **No demo/seed pick data in shipped code.** (Removed this pass: `bet-history`
   SEED_BETS, the UCL suggested-pick seed, the UCL fallback fixtures.)

---

## 6. Pick lifecycle

```
model candidate
   → ops review (Featured Pick / Suggested Picks)
   → approve  (ONLY proven markets; computes quarter-Kelly stake, snapshots line)
   → graded_status = open   (active; kickoff in future)
   → grader settles at fulltime
   → won / lost / push       (graded)
   → surfaces on /performance (current model_version)
```
