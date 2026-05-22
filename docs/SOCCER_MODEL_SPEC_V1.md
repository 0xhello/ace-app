# Soccer Intelligence Model — v1 Spec

**Status**: Draft for sign-off before implementation
**Target ship**: ~7-10 days from green light, plug into WC June 11
**Replaces**: CLV-arbitrage divergence detection (which stays running in the background as data collection / baseline)

---

## In one paragraph

We build our own probability estimate for every soccer match — independent of what any book says. We feed it recent results, shots-on-target patterns, referee tendencies, and team strength ratings learned from history. It outputs: probability of home win, draw, away win, expected total goals, and probabilities for every Asian handicap line. We then compare those probabilities to every book's prices and surface picks where our number disagrees with the market by enough to be a real edge. **Pinnacle becomes one of many books we evaluate against our own view, not the source of truth.**

---

## What it eats (inputs)

| Input | Source | Why it matters |
| --- | --- | --- |
| Team Elo rating | Computed from 3 seasons of historical results (~5,700 matches in our DB) | Baseline strength estimate that updates after every match |
| Recent results (last N games) | football-data.co.uk CSVs (already on disk) | Captures form swings Elo is slow to reflect |
| Shots-on-target (SoT) for/against | football-data.co.uk | Best free proxy for shot quality / "expected goals." If a team is generating SoT but not goals, they're due. |
| Shot conversion rate | Derived | Finishing quality — separates Liverpool (clinical) from say Brentford (profligate) |
| Corner differential | football-data.co.uk | Territorial dominance proxy. Light feature. |
| Cards per game (team) | football-data.co.uk | Discipline patterns, red-card risk |
| Cards per game (referee) | football-data.co.uk | Per-ref tendencies — some refs card 6/game, some 3/game. Affects red-card risk → affects late-game outcomes |
| Home advantage (per league) | Learned from data | EPL HFA ≠ Bundesliga HFA. Captured numerically per competition. |
| H2H history | Same DB, last 5 meetings | Captures tactical/stylistic mismatch beyond raw strength |

### What we explicitly do NOT have in v1

| Missing input | Impact | Why we're shipping without it |
| --- | --- | --- |
| Real xG (from Understat / Opta / StatsBomb) | Moderate — would tighten goal-expectancy estimates ~10-15% | Understat is Cloudflare-walled; commercial xG feeds are $$$$. SoT is a 0.7-correlated proxy. |
| Lineups (confirmed starting XI ~60min pre-game) | Moderate — star rest reduces team strength noticeably | No clean free source we've verified |
| Injuries | High — keeper or first-striker out swings outcome ~15-30% probability | ESPN news parsing produced garbage; Sofascore blocked; API-Football is paid. v1.5 problem. |
| Weather | Low-moderate — mainly affects totals at outdoor venues with wind/rain | No soccer-venue weather mapping yet |
| Travel / fixture congestion (UCL midweek → league weekend) | Low-moderate | Computable from fixture lists, not in v1 |

---

## What it produces (outputs)

For every upcoming match, the model spits out:

| Output | What it is | What it powers |
| --- | --- | --- |
| `P(home win)` | Probability home team wins (0-1) | Moneyline picks |
| `P(draw)` | Probability of a draw | Draw picks (structural edge vs US books that often misprice draws) |
| `P(away win)` | Probability away team wins | Moneyline picks |
| `λ_home` | Expected home goals (Poisson rate) | Totals + AH lines (derived from Poisson math) |
| `λ_away` | Expected away goals | Same |
| `P(total > 0.5)`, `P(total > 1.5)`, ..., `P(total > 5.5)` | Over probability for every common line | Over/under picks |
| `P(home -1.5)`, `P(home -1)`, ..., `P(home +1.5)` | AH probabilities at every quarter-line | Asian handicap picks |
| `P(both teams score)` | BTTS probability | BTTS picks |

Every output is a real, calibrated probability — meaning if the model says 65% and we check 100 such picks, they should hit ~65% of the time. Calibration is the metric we explicitly measure in backtest.

---

## How it works (light math)

### Step 1 — Team strength from history (Dixon-Coles base model)

For every team we estimate two numbers:
- **α (alpha)**: attacking strength. How many goals they score above league average.
- **δ (delta)**: defensive strength. How many goals they concede below league average.

A league-average team has α = 1.0 and δ = 1.0. A team scoring 1.5× the league average in goals has α = 1.5.

These are estimated by **fitting Poisson regressions to historical match data** — we look at every goal scored across our 5,700 matches and solve for the α/δ values that best explain the observed scoring patterns. Standard academic technique (Dixon & Coles 1997, used by Bloomberg and pretty much every serious betting model since).

### Step 2 — Match-specific goal expectancy

For a match between Home H and Away A:

```
λ_home = α_H × δ_A × γ_league       (expected home goals)
λ_away = α_A × δ_H                  (expected away goals)
```

`γ_league` is the league-specific home advantage factor (EPL ~1.32, Bundesliga ~1.27, Serie A ~1.30 — learned from data, not assumed).

### Step 3 — Adjust for recent form + SoT divergence

The base model treats all historical matches equally. We adjust:

- **Recency weighting**: matches from 3 years ago count 0.36× as much as recent matches. Decay factor learned from data.
- **SoT-based adjustment**: if Team X is generating shots-on-target at rate that implies they should be scoring 1.8 goals/game but actually scoring 1.4, we nudge α_X upward (they're due). Reverse for opponents conceding lots of SoT but few actual goals.
- **Per-ref red-card risk**: if a high-card ref is assigned, increase variance on the goal output.

### Step 4 — Compute outcome probabilities

Goals are Poisson-distributed with rates λ_home and λ_away. The probability of a specific scoreline (H goals home, A goals away) is:

```
P(H, A) = Poisson(λ_home, H) × Poisson(λ_away, A) × τ(H, A)
```

`τ(H, A)` is the **Dixon-Coles correction** — applies a small multiplier to outcomes 0-0, 1-0, 0-1, 1-1 because real-world soccer produces more draws and 1-0/0-1 scorelines than pure Poisson predicts. (Defensive tactics, time-wasting, etc.)

From the matrix of scoreline probabilities, every market we care about (h2h, totals, AH, BTTS) is just a sum over the right cells.

### Step 5 — Compare to books, find edge

For every market and every book:

```
edge_pp = model_prob - book_implied_prob
```

If edge_pp ≥ 5pp on any market × bet_side, we fire a signal. (Threshold higher than current 3pp because we'll be more confident in our own number than in pure Pinnacle divergence.)

---

## How we'll know if it's good (backtest)

We train on the first 80% of historical fixtures, hold out the last 20%. On the held-out data we measure:

| Metric | What it tells us | Target for v1 |
| --- | --- | --- |
| **Calibration** | When model says X%, does it hit X% of the time across confidence buckets? | Within ±2% per bucket |
| **Log-loss** | How confidently right (or wrong) the model is | Beat a constant 33/33/33 baseline; ideally beat published Elo-only models |
| **Closing-line value (CLV)** | When model fires a pick, does the book's closing price move toward our number? | Average CLV > 0pp (sharp signal) |
| **Simulated ROI** | If we'd bet every pick the model fires at the available closing odds, what's the ROI? | > 0 across held-out sample (>5% would be excellent) |
| **Hit rate by edge bucket** | Picks fired at 5-7pp edge vs 7-10pp vs 10pp+ — does higher edge correspond to higher hit rate? | Monotonic relationship (higher edge → higher win rate) |

**Honest expectation**: A v1 without xG/lineups/injuries probably lands at ~3-6% simulated ROI on held-out data, with mediocre calibration on extreme edges. That's a real model and a defensible product, but not yet world-class. We'll know within ~2 days of training whether the math is producing sensible numbers.

---

## What this gives ACE / subscribers

### For subscribers
- Real probability estimates they can act on independently ("model says 65% — book offers 58% — that's a real value bet")
- Ability to filter picks by their own edge threshold
- Ability to evaluate the model's calibration over time (credibility surface)
- Multi-book best-price still surfaced
- No dependency on "Pinnacle says X, soft book says Y" arbitrage that they can't actually execute

### For ACE (the business)
- Defensible IP — anyone can write a Pinnacle de-vig divergence in a weekend; a calibrated trained model is months of work others won't replicate
- Pricing tiers justified by model output (free delayed picks vs paid live model probabilities vs raw model API access)
- Marketing claims grounded in calibration ("our 65% picks hit 65%") that perform in ads
- B2B potential — sell model outputs to smaller media operators
- Architecture extends to NBA/MLB/NFL with same skeleton

---

## Build sequence

| Day | What | Check-in |
| --- | --- | --- |
| 1 | Extend form ingestor to parse the extra columns (shots, corners, cards, refs). Verify ~115 columns × ~5,700 matches land in DB | Show row counts + sample query |
| 2-3 | Implement Dixon-Coles base + Elo + recency weighting. Fit on training data. | Show team strength rankings (does Man City come out top? Brighton mid-pack?) — sanity check |
| 4 | Add SoT adjustment + ref-tendency feature | Show side-by-side comparison: model with/without these features |
| 5 | Backtest on held-out 20%. Calibration, ROI, CLV. | **Show backtest report. You decide whether the model is worth shipping.** |
| 6-7 | Integrate model into the signal pipeline (model_prob vs book_prob = edge) | Show sample picks fired by the model — you read them, give thumbs up/down |
| 8 | New explainer narrative format | Show before exposing to UI |
| 9-10 | WC adaptations + soccer-tab UI re-enable | Live walk-through of subscriber experience |

---

## Open questions (for you to answer before I start coding)

1. **Threshold confirmation**: I'm proposing edge ≥ 5pp to fire a model-driven signal (vs current 3pp for divergence). Higher confidence in our own number lets us be more conservative. Are you OK with fewer-but-better picks?

2. **Markets to support in v1**: h2h, totals, AH covers ~95% of subscriber action. Do we also build BTTS in v1, or save for v1.5?

3. **Backtest threshold**: If v1 hits ~3-6% simulated ROI on held-out data, do we ship and iterate, or do we keep building until it's higher? My instinct is ship and iterate — perfect is the enemy of WC June 11.

4. **Show-your-work in explainer**: Should subscribers see the actual numbers ("our model puts Liverpool at 64.3%") or rounded narratives ("our model strongly favors Liverpool")? Trade-off: transparency vs feeling like a research product.

---

## Limitations being honest about

- Without xG, model accuracy on totals will lag a real xG-based system by ~10-15%
- Without lineups/injuries, model misses major events (Salah out 60min pre-game → model still says Liverpool 65%)
- Promoted teams have thin training data (only 1 season in the dataset) → estimates of their strength are noisy
- Model is league-specific in v1 — won't generalize to leagues we haven't trained on (Brazilian Serie A, MLS, etc.) until we add their data
- WC requires separate adaptation (international team Elo, neutral venues) — Phase 7 in the build plan
