# UCL Final picks — publish to prod runbook

Pushes the 4 approved picks for **PSG vs Arsenal (Sat May 30 16:00 UTC)**
into prod's `soccer_approved_picks` table so they appear in the live
Soccer Ops dashboard.

## Picks being published

| Bet | Best price | Model% | Edge |
|---|---:|---:|---:|
| Over 2.5 goals | +120 BetRivers | 59.7% | +14.2pp |
| Both Teams To Score Yes | −118 BetMGM | 61.3% | +7.2pp |
| Dembélé anytime scorer | +210 DraftKings | 45.1% | +12.8pp |
| Saka anytime scorer | +380 BetRivers | 30.8% | +10.0pp |

Each pick's `rationale_json` includes:
- `model_prob_source` (Sportmonks for game-level, M38 lineup-aware for player props)
- `cross_check` (M39 Sportmonks agreement signal)
- `leakage_note` (citation to `docs/SOCCER_LEAKAGE_AUDIT_2026-05-29.md` — reported edges are upward-biased)
- `backtest_support` (what's actually validated vs what isn't)

Edge math was verified stable vs live prices in the local audit
(2026-05-29). Run the publish step within ~1 hour of the audit or
re-audit first if prices have moved.

## How to run

You must be logged in to **acebets.io as admin**. Open dev tools console
on any acebets.io page (so the admin session cookie is attached) and
paste this whole block:

```js
const PICKS = [
  {
    game_id: "ucl_final_2026_psg_arsenal",
    market: "totals_2.5",
    side: "over",
    bet_label: "Over 2.5 goals",
    model_prob: 0.597,
    best_price: 120,
    best_book: "betrivers",
    fixture_label: "PSG vs Arsenal · UCL Final",
    tournament: "UEFA Champions League",
    commence_time: "2026-05-30T16:00:00Z",
    lineup_status: "projected",
    notes: "PLACED — 0.5u staked. Validated market type (only positive in either backtest).",
    rationale: {
      leakage_note: "Per docs/SOCCER_LEAKAGE_AUDIT_2026-05-29.md, reported ROI is partially over-fit (shrinkage + M21 hyperparams tuned on holdout). Edges shown are upward-biased.",
      model_version: "v2_post_m21",
      sportmonks_fixture_id: 19683241,
      model_prob_source: "Sportmonks 'Over/Under 2.5 Probability' yes",
      primary_thesis: "goals-heavy attacking final — both teams' xG profiles + Sportmonks + market lean over",
      cross_check: "Sportmonks 60% vs market ~46%",
      backtest_support: "V1 doc +3.06% on 1044 holdout / M21 commit body +9.1% on 198-bet subset; both upward-biased per audit",
      edge_pp_at_placement: 14.2,
    },
  },
  {
    game_id: "ucl_final_2026_psg_arsenal",
    market: "btts",
    side: "yes",
    bet_label: "Both teams to score — yes",
    model_prob: 0.613,
    best_price: -118,
    best_book: "betmgm",
    fixture_label: "PSG vs Arsenal · UCL Final",
    tournament: "UEFA Champions League",
    commence_time: "2026-05-30T16:00:00Z",
    lineup_status: "projected",
    notes: "RECOMMENDED — 0.25u suggested. Cross-check positive, untested in our backtest.",
    rationale: {
      leakage_note: "Per docs/SOCCER_LEAKAGE_AUDIT_2026-05-29.md, edges shown are upward-biased.",
      model_version: "v2_post_m21",
      sportmonks_fixture_id: 19683241,
      model_prob_source: "Sportmonks 'Both Teams To Score Probability' yes",
      primary_thesis: "same goals-heavy thesis as Over 2.5; positively correlated",
      cross_check: "Sportmonks 61% vs market 54%",
      backtest_support: "BTTS not yet backtested — calibration pipeline pending (M31 follow-up)",
      correlation_note: "positively correlated with Over 2.5",
      edge_pp_at_recommendation: 7.2,
    },
  },
  {
    game_id: "ucl_final_2026_psg_arsenal:dembele",
    market: "anytime_scorer",
    side: "yes",
    bet_label: "Ousmane Dembélé to score anytime",
    model_prob: 0.451,
    best_price: 210,
    best_book: "draftkings",
    fixture_label: "PSG vs Arsenal · UCL Final",
    tournament: "UEFA Champions League",
    commence_time: "2026-05-30T16:00:00Z",
    lineup_status: "projected",
    notes: "RECOMMENDED — 0.10u suggested. UNTESTED market type. Re-check confirmed XI ~1h pre-kickoff.",
    rationale: {
      leakage_note: "Per docs/SOCCER_LEAKAGE_AUDIT_2026-05-29.md, edges shown are upward-biased. Anytime scorer market never backtested in our pipeline — M40 follow-up.",
      model_version: "v2_post_m21",
      sportmonks_fixture_id: 19683241,
      model_prob_source: "ACE M38 lineup-aware player_props pipeline (Sportmonks projected XI as PSG #9)",
      primary_thesis: "primary attacking outlet for PSG, top xG/90 in cached pool, in projected XI",
      lineup_status: "projected_starting",
      lineup_data_source: "soccer_sportmonks_fixture_cache.fixture_id=19683241",
      backtest_support: "NONE — anytime scorer market never backtested",
      edge_pp_at_recommendation: 12.8,
      calibration_warning: "model_prob may be inflated by 0.82 attacker-share constant in player_props.py",
    },
  },
  {
    game_id: "ucl_final_2026_psg_arsenal:saka",
    market: "anytime_scorer",
    side: "yes",
    bet_label: "Bukayo Saka to score anytime",
    model_prob: 0.308,
    best_price: 380,
    best_book: "betrivers",
    fixture_label: "PSG vs Arsenal · UCL Final",
    tournament: "UEFA Champions League",
    commence_time: "2026-05-30T16:00:00Z",
    lineup_status: "projected",
    notes: "RECOMMENDED — 0.10u suggested. UNTESTED market type. Same caveats as Dembélé pick.",
    rationale: {
      leakage_note: "Per docs/SOCCER_LEAKAGE_AUDIT_2026-05-29.md, edges shown are upward-biased. Anytime scorer market never backtested.",
      model_version: "v2_post_m21",
      sportmonks_fixture_id: 19683241,
      model_prob_source: "ACE M38 lineup-aware player_props pipeline",
      primary_thesis: "Arsenal's top attacker, in projected XI, vs PSG defense with recent xGA pressure",
      lineup_status: "projected_starting",
      lineup_data_source: "soccer_sportmonks_fixture_cache.fixture_id=19683241",
      backtest_support: "NONE",
      edge_pp_at_recommendation: 10.0,
    },
  },
];

console.log(`\n========== PUBLISHING ${PICKS.length} UCL FINAL PICKS ==========`);
const results = [];
for (const pick of PICKS) {
  console.log(`\n--- ${pick.bet_label} ---`);
  const t0 = Date.now();
  const res = await fetch("/api/ops/approved-picks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(pick),
  });
  const out = await res.json();
  const wall = ((Date.now() - t0) / 1000).toFixed(1);
  if (out.ok && out.pick) {
    console.log(`  ✓ id=${out.pick.id}  stake_units=${out.pick.stake_units}u  edge=${(out.pick.edge_pp_at_pick*100).toFixed(1)}pp  wall=${wall}s`);
    results.push({ pick: pick.bet_label, ok: true, id: out.pick.id });
  } else {
    console.warn(`  ✗ FAILED: ${out.error || JSON.stringify(out).slice(0,200)}`);
    results.push({ pick: pick.bet_label, ok: false, error: out.error });
  }
}

console.log(`\n========== SUMMARY ==========`);
console.table(results);
console.log(`\nView them in the Soccer Ops dashboard's Approved Picks panel.`);
console.log(`Stake_units displayed will be the Kelly recommendation (HIGH — ignore per leakage audit).`);
console.log(`Use the sizing in chat (0.5u Over, 0.25u BTTS, 0.10u each scorer) instead.`);
```

## What success looks like

```
--- Over 2.5 goals ---
  ✓ id=<N>  stake_units=5.00u  edge=14.2pp

--- Both teams to score — yes ---
  ✓ id=<N>  stake_units=3.91u  edge=7.2pp

--- Ousmane Dembélé to score anytime ---
  ✓ id=<N>  stake_units=4.74u  edge=12.8pp

--- Bukayo Saka to score anytime ---
  ✓ id=<N>  stake_units=3.15u  edge=10.0pp
```

After they land, refresh the Soccer Ops dashboard — they'll appear in
the Approved Picks panel, ordered by approved_at desc.

## Important — the displayed Kelly stakes are TOO HIGH

The Kelly numbers shown (5u, 3.91u, etc.) assume the model_prob is
perfectly calibrated. Per the audit, our model is partially over-fit,
so true edges are smaller than displayed. **Use these sizes instead:**

- Over 2.5: **0.5u** (not 5u)
- BTTS Yes: **0.25u** (not 3.91u)
- Dembélé: **0.10u** (not 4.74u)
- Saka: **0.10u** (not 3.15u)

A future ship (M40.6) will cap displayed Kelly when the rationale
flags a leakage caveat. Until then, trust the sizing in chat over the
sizing in the table.

## If a pick fails

Most likely causes:
- **401 / not admin**: re-login on acebets.io
- **400 missing field**: paste the full block as shown
- **500 subprocess failed**: prod env may have missing `SPORTMONKS_API_TOKEN` or similar; check the stderr_tail in the response

Re-run the script — `approve_pick` is idempotent via `ON CONFLICT
(game_id, market, side) DO UPDATE`, so successful picks won't duplicate.
