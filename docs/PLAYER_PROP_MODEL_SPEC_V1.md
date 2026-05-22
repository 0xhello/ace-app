# Player-Prop Model — v1 (WC-Only) Spec

**Status**: Draft for sign-off before implementation
**Target**: Ship alongside game-level model for WC kickoff June 11
**Replaces**: Dormant player-prop divergence detection (which never had its own probability source — used soft-book mispricing)

---

## In one paragraph

For every player on every WC squad, we compute our own probability that they score at least once in a given match, and our own probability that they score first. We feed it career international goals per 90 minutes (we already have this for 2,924 player-rows across WC/Euro/Copa/UEFA Nations League since 2018), match-level expected team goals (from the game-level Dixon-Coles model), and projected minutes. We then compare our probabilities to the player-prop prices any book posts, and fire picks where our number disagrees with the market. The dormant infrastructure (compute_goalscorer_prior, fixture-events grading via API-Football) gets activated when WC kicks off and books start posting these markets.

---

## What it eats (inputs)

| Input | Source | Why |
| --- | --- | --- |
| Career intl goals per 90 | StatsBomb open data (have it — 2,924 rows since WC 2018) | The single most predictive feature for "will this player score in an international match" |
| Career intl shots per 90 | Same | Quality / volume separator — high-shot players are "due" more often |
| Recency-weighted form (last 3 intl tournaments) | Same | Captures hot/cold streaks in intl play |
| Match expected team goals (λ_team) | Game-level Dixon-Coles model output | Player can't score more than their team is expected to. Anchors player_xG to team_xG. |
| Position | StatsBomb / inferred from goal patterns | Forwards score more than mids more than defs — adjusts base rate |
| Projected minutes | Historical avg minutes per WC/Euro match for this player | Subs play 25 min, starters play 90 — huge impact on scoring probability |
| Opponent defensive strength | Game-level model's `δ_opponent` | Italy concedes 0.6/match historically — depresses player scoring |
| Tournament uplift / regression factor | Computed (intl g/90 vs club g/90 ratio when available) | Some players (Cristiano) elevate in intl; others (Lukaku) regress |

### What we explicitly do NOT have

| Missing input | Impact | Why |
| --- | --- | --- |
| Confirmed pre-match lineup | High — if a player isn't starting, their scoring prob drops 60-80% | No clean free source; lineups confirm ~60min pre-kickoff |
| Real-time injury status | High — if Salah is doubtful 2hr pre-kickoff, we should pull or downgrade the pick | ESPN news parsing produced garbage; no good free feed |
| Current club season form | Moderate — would smooth the "this guy has 3 intl goals total" thin-sample problem | Club data is API-Football paid only right now |
| xG per shot (positional shot data) | Moderate — converts raw shots into expected goals | Same Cloudflare walls as game-level model's xG ask |

---

## What it produces (outputs)

For every (player, match) pair where the player is in a WC squad:

| Output | What it is | Powers |
| --- | --- | --- |
| `P(scores ≥1)` | Probability the player scores at least once | Anytime-scorer market (the main one) |
| `P(scores first)` | Probability they're the first goal of the match | First-scorer market |
| `λ_player_match` | Expected goals for this player in this match | Foundation for the above + future "X+ goals" lines |
| `expected_minutes` | Projected minutes played | Used as a feature; also surfaced in narrative ("Mbappé typically plays 88min in WC matches") |

---

## How it works (light math)

### Step 1 — Per-player baseline scoring rate

For each player p, from their international history:

```
g_per_90(p) = total_intl_goals(p) / (total_intl_minutes(p) / 90)
```

Players with thin samples (<540 min = <6 full matches) get shrunk toward their position's league baseline using a Bayesian prior. Without this, a guy who scored 1 goal in 90 min looks like a 1.0 g/90 superstar.

### Step 2 — Team expected goals from game-level model

The game-level Dixon-Coles model (separate spec) outputs λ_team for both teams in the match. For player p on team T facing opponent O:

```
λ_team(T, vs O) = team_T_xG_in_match    # from game-level model
```

### Step 3 — Player's share of team xG

This is the modeling step. A player's expected goals in the match is their **share** of team xG, scaled by minutes:

```
player_share(p) = g_per_90(p) / sum(g_per_90 for all players on T)
λ_player_match  = λ_team(T) × player_share(p) × (expected_minutes(p) / 90)
```

The player_share calculation is anchored by the team's own g/90 — Mbappé scoring at 1.2 g/90 on a France team where the average is 0.18 g/90 gives him share ≈ 1.2 / (0.18 × 11) ≈ 0.61 (or 61% of France's expected goals).

### Step 4 — Anytime-scorer probability (Poisson)

Given player_xG = λ_player_match, by Poisson:

```
P(scores ≥1)  = 1 - e^(-λ_player_match)
P(scores =0)  = e^(-λ_player_match)
P(scores ≥2)  = 1 - e^(-λ) × (1 + λ)
```

A player with λ = 0.5 has P(scores ≥1) ≈ 39.3%. A player with λ = 0.1 has ≈ 9.5%.

### Step 5 — First-scorer probability

If team T scores first with probability P(T_first), and player p has share `s` of T's xG:

```
P(p scores first) = s × P(T_first)
```

P(T_first) comes from the game-level model's scoreline matrix.

### Step 6 — Compare to book prices, find edge

For every player × market that books actually post:

```
edge_pp = model_prob - book_implied_prob
```

If edge_pp ≥ 7pp on a player prop (higher threshold than game-level because per-player variance is higher, prevents thin-sample picks from firing), we fire a signal.

---

## How we know if it's good (backtest)

We have ground truth for every player who scored in WC 2018, WC 2022, Euro 2020, Euro 2024 — those are all in the StatsBomb data. Train on the older tournaments, validate on the most recent (Euro 2024). Metrics:

| Metric | What it tells us | Target |
| --- | --- | --- |
| **Calibration on anytime-scorer** | When we say 40%, do players score 40% of the time across the bucket? | Within ±3% per bucket |
| **Brier score** | Probabilistic accuracy over the full sample | Beat constant baseline (everyone at 25%) |
| **First-scorer hit rate vs implied** | First-scorer markets have ~10-15% implied for top players. Do ours match? | Within ±2% per top-player tier |
| **Simulated ROI vs historical Euro 2024 book closing odds** | If books had been live, what would the picks have done? | > 0; >3% would be a real signal |

**Honest expectation**: anytime-scorer is the highest-volume player prop and books are sharper on top scorers than they are on mid-tier names. Our edge will be larger on **mid-tier names** (Goretzka, McTominay, etc.) and smaller on **A-listers** (Mbappé, Haaland — books model these well too). Expected v1 simulated ROI: 2-5% on anytime-scorer picks.

---

## What this gives ACE

### Premium tier picks
The flagship marketing claim for WC kickoff: **"ACE picks every match's top anytime-scorer values, powered by every international tournament since 2018."** That's an actual data-backed pitch, not vibes.

### Volume during WC
A typical WC group-stage day has 4 matches = 4 game-level picks + maybe 8-15 player-prop picks. That's enough daily flow to keep subscribers engaged through the tournament.

### Brand differentiation
Most pick services don't do player props at all, or do them with no real model behind. A trained anytime-scorer model with calibration backtest IS the differentiator.

---

## Build sequence

| Day | What | Check-in |
| --- | --- | --- |
| 1 | Verify StatsBomb data on disk, audit per-player coverage. Add per-position scoring baselines. | Row counts + sample player rates |
| 2 | Implement Step 1-3 (player baseline + team xG + player share calc) — works on test data | Show predicted goals/match for a few known players (Mbappé, Saka, Ronaldo) — sanity check |
| 3 | Wire in game-level model output (Step 2 input). Compute end-to-end probabilities. | Sample table: player → P(scores) for known matchups |
| 4 | Backtest on Euro 2024 held-out data. Calibration + Brier + simulated ROI. | **Backtest report — you approve next phase.** |
| 5 | Integrate into signal pipeline (replaces the existing divergence-only player-prop detector) | Sample picks fired |
| 6 | Player-prop narrative extension to explainer | Sample narrative output |

This parallels the game-level build. **Combined total: ~10-12 days** when both streams run in parallel, because the player-prop model REUSES the game-level model's output (so Stream 2 lags Stream 1 by 2-3 days but they finish around the same time).

---

## Open question

**Edge threshold for player props.** I'm proposing 7pp because player-prop variance is higher than game-level. Game-level: 5pp threshold for premium tier. Player-prop: 7pp threshold for premium tier.

If you want larger volume (more picks), drop to 5pp. If you want tighter quality (fewer, higher-conviction picks), keep at 7pp.

---

## Limitations being honest about

- No lineups means we treat every WC squad member as "could play." First-XI predictions are based on minutes-per-tournament history.
- No real-time injury feed means a player ruled out 2 hours pre-kickoff would still show on our pick list. We'd need to manually pull or build a fast injury layer.
- Thin samples for promoted/new players (someone making their first WC) get heavy regression toward position-baseline.
- First-scorer market is a separate, smaller market. Anytime-scorer is the main volume driver.
- Only WC in v1. Club-league player props (EPL/La Liga) require current-season player data we don't have free access to. Post-WC consideration.
