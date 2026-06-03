# ACE Model R&D Roadmap — from toy picks model to handicapping engine

**Status:** R&D blueprint (2026-06-02). Post-launch. Each phase must produce
a backtested ROI result before the next begins. **No phase ships to
subscribers until it beats the closing line on a clean held-out test.**

---

## The thesis

| Current model (no edge) | Future model (possible edge) |
|---|---|
| "Team A averages X corners" | "Team A dominates territory because Team B sits deep" |
| "Player B scores Y/90" | "This striker's shot volume rises vs teams weak at defending cutbacks" |
| "Team C has Z xG" | "If Team A trails, its corner rate spikes late" |
| "Two marginal team strengths → BTTS" | "Heat/altitude/travel cut pressing → changes the late-game goal/corner profile" |
| **Market already prices this** | **Market may price this lazily → edge** |

The edge is **not** a secret probability. It's modeling the *conditional,
matchup-specific, game-state-dependent* drivers the soft books price
lazily. We model the game *flow*; corners / goals / scorers / BTTS fall
out of it, correlated.

**Where the realistic edge comes from** (be honest about this):
1. Soft books (FanDuel/DK) lag the sharp consensus on conditionals.
2. Markets price the *average*, miss the *matchup-specific*.
3. Derivative markets (corners, props) on smaller fixtures get less attention.
We are NOT claiming to out-predict Pinnacle's true probability. We're
claiming to find conditional spots the soft books misprice.

---

## The Proven bar (non-negotiable, reused from backtest discipline)

A market is **Proven** only when, on a leakage-free held-out test
(`backtest_v2` protocol + `hist_join` Sportmonks closing odds):
- ROI > 0 at the 5pp edge threshold, with ≥ 30 test bets, **and**
- not losing at the lower 3pp threshold (a real edge holds at the
  larger-sample lower threshold — guards against single-threshold noise).
- Success is measured in **ROI vs the closing line**, NOT prediction
  accuracy. A 60%-accurate model that loses to the vig is worthless.

Everything else stays **Experimental** and is labeled as such to subscribers.

---

## Data inventory — what we have vs what we need to build

**Available now (per match):**
- `soccer_team_form` — goals, **corners**, corners_against, **shots-on-target**,
  referee, closing odds (1X2/totals). Broad league coverage, multi-season.
- `soccer_source_team_match_stats` (Understat) — **xG**, xGA, np_xG,
  **PPDA (pressing)**, deep_completions. Big-5, 2024-25 only.
- `soccer_hist_fixtures` (Sportmonks) — score, corners_total, BTTS,
  **goal_scorers** (events). Broad, 2024-26.
- `soccer_hist_closing_odds` — closing odds for 1X2 / totals / BTTS /
  **corners** / **goalscorers** across 21 books. The backtest benchmark.
- Our own model's **expected game script** (1X2 + expected goal diff) —
  the pre-match proxy for "will this team lead or chase?"

**Need to ingest (extends M48 — Sportmonks per-fixture `statistics`):**
- Shots by location (inside/outside box), **blocked shots**, shots off target.
- **Total + accurate crosses**, **dangerous attacks**, attacks.
- Possession %, big chances created/missed, key passes.
- These are the *pressure* drivers. They exist in the Sportmonks
  `xGFixture`/`statistics` includes (146 metrics) — we ingested odds +
  events + corners_total, NOT the full per-fixture stat lines yet.

**Need to build (features), not just ingest:**
- Leakage-free **per-player as-of-date** scoring/shot rates (for scorers —
  the current `player_baselines` is cumulative/leaky, M40.4).
- **Opponent style proxies** — block height (corners-against + deep
  completions conceded), aerial weakness, cutback/wide vulnerability.
- WC-only: **heat / altitude / travel-rest** features per fixture.

---

## Phase 1 — Corners pressure model — DONE, RESULT: NEGATIVE (2026-06-02)

> **Outcome:** built (`ml/soccer/corners_pressure.py`, pressure stats in
> `soccer_hist_team_stats`), backtested leakage-free on 3,540 fixtures.
> The pressure model does **not** beat the corners market or the rolling
> baseline (both lose ~7–10%), and predicts corner totals *worse than a
> constant*. Match-level corners are near-random (model corr 0.08 vs
> market 0.19). **Corners is a dead end as a model target.** Full write-up:
> `SOCCER_MODEL_BACKTEST_V2.md` → "Corners pressure model". Cost: ~one day,
> exactly as "cheap to kill" intended. This tempers the thesis below —
> derivatives may be efficient; demand the clean bar on every future market.
>
> **Follow-up (R1b) — in-play also tested, also negative.** Hypothesis: maybe
> the edge is in-play, not pregame. Built `corners_inplay.py` (per-half stats
> in `soccer_hist_period_stats`): does observed H1 pressure predict H2 corners?
> Directionally yes (in-play beats pre-match), but the signal is far too weak
> to bet — it can't beat a constant mean (corr 0.05). Corners don't persist
> within a match. **Corners closed: pre-match AND in-play.** A leakage bug
> (Sportmonks 2nd-half stats are cumulative for ~41% of fixtures) faked an 18%
> lift on the first run — caught and corrected. Caveat recorded for future
> in-play work on other markets.

Corners are the cleanest game-flow derivative and we already have most
inputs. This is the first milestone; it proves the *approach* before we
invest in harder markets.

**Inputs (per fixture, all leakage-controlled with `before_date`):**
- Team shot volume + shots-on-target (soccer_team_form; richer: Sportmonks
  shots inside/outside box once ingested).
- Crosses / dangerous attacks (Sportmonks per-fixture stats — to ingest).
- Possession tendency.
- Corner for/against rolling rates (what the current model uses — kept as
  one feature among many, not the whole model).
- Opponent block-height proxy (opponent corners-against + deep completions
  conceded → deep blocks concede more corners).
- **Expected game script** — our 1X2 / expected goal-difference: blowout-
  likely and chase-likely games have different corner profiles.

**Model architecture (concrete, not sci-fi):**
- A gradient-boosted regressor (or Poisson regression) predicting **expected
  total corners λ** from the pressure features — NOT from corner history alone.
- Poisson(λ) → P(corners ≥ line) per offered line.
- This is a single supervised model on tabular features. No simulation yet.

**Backtest protocol:**
- `backtest_v2` 3-way split (train fit / val tune / test report).
- Features computed strictly before each match date (leakage-free).
- Grade vs Sportmonks closing corners odds (`hist_join.corners_odds`), with
  push handling on whole-number lines (already built in
  `run_corners_backtest`).

**Success criteria (the bar):**
- Positive ROI at 3pp / 5pp / 7pp on the held-out test, robust (holds at
  3pp), ≥ 30 bets. Beats the current rolling-rate model (which was −4.5%).
- If it clears the bar → corners becomes **Proven**. If not → we learned
  the pressure features don't beat the market either, cheaply, and move on.

**Why this first:** it reuses the corners backtest harness we already built,
the data is largely in hand, and it's a clean test of the core thesis
(pressure drivers > raw counts). One model, one backtest, a clear yes/no.

---

## Phase 2 — BTTS game-state / score-flow model

BTTS is a game-state market: a team going 2-0 up shuts shop and kills it.
- Model **clean-sheet probability** conditioned on defensive solidity (xGA,
  PPDA, set-piece concession) + expected game script, rather than
  multiplying two marginal team strengths.
- Backtest vs Sportmonks BTTS closing odds (already wired in `backtest_v2`).
- Proven bar as above.

## Phase 3 — Anytime scorer player-chance model

- First **build the leakage-free per-player as-of-date feature** (shot
  volume, xG-per-shot, penalty/set-piece role) from Sportmonks historical
  events — the blocker we hit in F4. NOT `player_baselines`.
- Model P(player scores) = P(gets chances | role, matchup, game script) ×
  P(converts | shot quality). Edge is in chance generation + role, not
  season goal rate.
- Backtest vs the 533k anytime-scorer closing odds rows we already have.

## Phase 4 — Unified minute-by-minute match simulation (LAST)

**Only after Phases 1-3 prove their component models.** Simulate the match
with **game-state feedback** (score changes shift attacking intensity,
corner generation, subs). Every market falls out of one coherent sim,
capturing the correlations the market misprices.

**Guardrail:** the simulation is the *endgame*, not the starting point. We
do NOT build it speculatively. It earns its place only once corners / BTTS /
scorer component models have each beaten the close on a clean test. If the
components don't find edge, the simulation won't either — and we'll have
spent days, not months, finding that out.

---

## Anti-sci-fi principles

1. **One market, one model, one backtest at a time.** No grand unified
   build before the pieces prove out.
2. **ROI vs the close is the only success metric.** Accuracy is a vanity number.
3. **Every phase is cheap to kill.** If the features don't beat the market,
   we learn it in days and move on — no sunk-cost cathedral.
4. **Leakage discipline is permanent.** Every feature `before_date`-gated,
   every verdict on a held-out test, every ROI claim cites this protocol.
