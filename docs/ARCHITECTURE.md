# ACE — Soccer Betting Intelligence Architecture

**Status:** canonical reference (2026-06-02). Update when layer boundaries change.

## Product stance (the thing that keeps us honest)

> **ACE builds its own probability for each match, compares it to live odds,
> filters for real edges, and explains the why in plain English.**

ACE is a **betting-intelligence / research product**, NOT a generic AI
betting chatbot. The single rule that enforces this:

> **The model decides. AI explains. AI never invents a pick or a probability.**

Every number a user sees (probability, edge, price, stake) is produced by
the validated model + market layers. The AI layer only narrates what the
structured data already says. If the AI can't ground a claim in the pick
object, it doesn't make the claim.

---

## The five layers

```
   ┌─────────────────────────────────────────────────────────────┐
   │ 5. AI LAYER        explain · summarize · flag caveats · Q&A   │  ← narrates
   ├─────────────────────────────────────────────────────────────┤
   │ 4. OPS LAYER       approve · watchlist · grade · lifecycle    │  ← workflow
   ├─────────────────────────────────────────────────────────────┤
   │ 3. RISK LAYER      bettable? tier? blockers? proven status    │  ← gate
   ├─────────────────────────────────────────────────────────────┤
   │ 2. MARKET LAYER    model vs book · edge · best price · move   │  ← compare
   ├─────────────────────────────────────────────────────────────┤
   │ 1. MODEL LAYER     our own probability from soccer variables  │  ← source of truth
   └─────────────────────────────────────────────────────────────┘
```

### Layer 1 — Model (🟢 mature)
Calculates ACE's own probabilities from soccer variables: form, xG, shots,
SoT, lineups, injuries, player baselines, opponent weakness, home advantage.

- `ml/soccer/model.py` — Dixon-Coles fit + `predict_match` (1X2, totals,
  BTTS); xG priors (M9), SoT + referee adjustments, lineup availability
  (M7/M8), home gamma (M21), calibration shrinkage.
- `ml/soccer/player_props.py` — Poisson player props (anytime scorer,
  shots), lineup-aware minutes via Sportmonks (M38).
- `ml/soccer/sportmonks_fixture.py` — projected lineups, Sportmonks
  predictions, fixture xG.
- Inputs: `soccer_team_form` (form/goals/corners/SoT), Understat (xG),
  Sportmonks (lineups/injuries).
- **Gap:** national-team coverage — the DC model fits on club teams, so
  it returns no prediction for international fixtures (WC, friendlies).
  Tracked: Phase 4. Also `player_baselines` leakage risk (M40.4).

### Layer 2 — Market (🟢 mature)
Compares model probabilities to live book odds: implied prob, edge %, best
book, price availability, line movement, independent cross-check.

- `ml/soccer/candidates.py` — model-vs-book edge, de-vig, best price.
- `ml/soccer/leagues.py` — Pinnacle-vs-soft-book divergence, line movement,
  per-league odds fetch (WC-aware as of P1.1).
- `ml/soccer/prop_cards.py` — player-prop edge with multi-tier ladder search.
- `ml/soccer/predictions_crosscheck.py` — Sportmonks second-opinion (M39):
  demote picks where ACE and Sportmonks disagree.

### Layer 3 — Risk (🟡 scattered — consolidate)
Decides whether something is actually bettable, and at what trust tier.

- Logic currently spread across:
  - `prop_cards._bettor_review` — blockers (sample_low, lineup_unknown,
    opponent_context_missing…) + decision/confidence tier.
  - `approved_picks._apply_leakage_cap` (M40.6) — leakage-aware stake caps.
  - `backtest_v2` — the PROVEN / EXPERIMENTAL verdict (the citable source).
  - `candidates._confidence` — edge→tier mapping.
- **This is the biggest structural gap.** The Proven/Experimental gate
  (M49) is decided but not yet enforced live. Target: a single `risk.py`
  that takes (model output + market + backtest verdict + blockers) →
  `{tier, bettable, reasons}`.

### Layer 4 — Ops (🟢 mature)
Internal trading/research workflow. Operator approves/rejects/watchlists;
lifecycle candidate → watch → approved → published → graded. Subscriber
picks kept separate from raw candidates.

- `ml/soccer/approved_picks.py` — approve/grade/CLV, model_version tagging.
- `ml/soccer/candidates.py` — candidate lifecycle + status.
- UI: `SoccerOpsTab`, `SuggestedPicksPanel` (M44, one-click approve),
  `ApprovedPicksDashboard` (M24).
- API: `/api/ops/approved-picks`, `/api/ops/soccer/grade-approved-picks`,
  `/api/ops/sportmonks/sync-slate`.

### Layer 5 — AI (🔴 early — the product gap)
Explains approved/model picks; summarizes confidence + caveats; flags
missing context; answers operator/user questions from structured ACE data.
Drafts "why this bet" narratives. **Never invents picks.**

- `ml/world_cup/pick_explainer.py` — template-based explainer (deterministic,
  grounded, safe). This is the guardrail/fallback.
- `src/app/api/ask-ace/route.ts` — raw Claude Haiku Q&A endpoint. Currently
  unconstrained (the "generic chatbot" risk) — to be repositioned to answer
  *from ACE data only*.
- **Gap:** no LLM-grounded explainer wired to the pick object; the "why"
  field renders empty on cards.

---

## The pick object contract (the spine through all layers)

One structured object accumulates fields as it flows up the layers. AI only
ever sees this — never raw data.

```
{
  # Layer 1 — Model
  fixture, market, side, model_prob, model_confidence, drivers{xg, form, lineup…},

  # Layer 2 — Market
  best_price, best_book, implied_prob, edge_pp, line_movement, sportmonks_prob,

  # Layer 3 — Risk
  tier: "proven" | "experimental" | "watch" | "pass",
  bettable: bool,
  blockers: ["small_sample", "lineup_unconfirmed", …],
  stake_units,          # leakage-capped
  backtest_roi_ref,     # cites SOCCER_MODEL_BACKTEST_V2.md

  # Layer 5 — AI (added last, derived ONLY from the above)
  why_narrative, caveats[], what_would_invalidate,
}
```

---

## AI-safety rules (anti-hallucination)

1. AI receives the **structured pick object**, never raw data.
2. AI **explains, never computes.** Every number is passed in from Layers
   1–2; the AI restates, never derives.
3. The **template explainer is the guardrail** — fall back to it if the LLM
   is unavailable OR its output contradicts the numbers.
4. **Numbers shown beside the narrative** so users can verify.
5. **Caveats come from `blockers`**, not the LLM's imagination.
6. **Validation pass:** reject/regenerate any AI output stating a
   probability or pick the model didn't produce.

---

## Proven vs Experimental (source: `SOCCER_MODEL_BACKTEST_V2.md`)

- **PROVEN:** Totals 2.5 over (+8.83% clean held-out, monotonic edge).
- **EXPERIMENTAL / not bettable:** 1X2 moneyline (proven negative),
  under 2.5 (negative). BTTS / corners / anytime scorer: **verdict pending**
  the M40.2b backtest (historical odds loaded; backtest to run).
- **National-team markets (WC, friendlies): NO validated model.** The DC
  model is club-trained; the proven Over 2.5 edge was validated on club
  football and does NOT automatically transfer to international play.

---

## Subscriber vs Ops experience

| | Ops (admin) | Subscriber |
|---|---|---|
| Picks shown | all candidates incl. experimental | published only |
| Markets | every market, raw model trace | tiered (Proven / Still-testing) |
| Workflow | approve / reject / watchlist / grade | read + track |
| Numbers | full edge/CLV/model internals | plain-English "why" + honest record |

---

## What ships for WC launch vs later

- **Launch:** Layers 1–4 working for proven markets + the tiered display
  gate (Layer 3, M49) + a grounded AI explainer on proven picks (Layer 5).
- **Later:** full AI analyst / ask-ace-over-data, live in-play model,
  national-team model.
