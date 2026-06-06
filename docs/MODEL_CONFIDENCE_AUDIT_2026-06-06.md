# ACE Model Confidence Audit — 2026-06-06

## Decision

Model confidence is a data/model workstream, not UI polish. Until ACE has calibrated model-confidence output, product-facing surfaces should call heuristic scores **signal strength**, **market read**, or **sample confidence** depending on source.

## Current confidence sources

| Source | Fields / files | What it actually is | Product wording |
| --- | --- | --- | --- |
| Live Signal Feed | `src/lib/live-picks.ts`, `src/components/TopAIPicks.tsx` | Price-discrepancy heuristic plus book-count bonus | Signal strength |
| BetSlip selected legs | `src/components/BetSlip.tsx` | Preserved source-pick signal strength, not calibrated confidence | Strong/Medium/Weak signal |
| Game tracked read | `src/lib/confidence.ts`, `src/lib/live-signals.ts`, `src/app/dashboard/tracked/[gameId]/page.tsx` | No-vig market probability adjusted by injuries/weather/movement | Market read / signal strength |
| Tracked bets page | `src/app/dashboard/tracked/page.tsx` | Saved tier from slip/source heuristic | Signal-strength accuracy |
| NBA Ops model history | `ml/nba_spread/inference.py`, `ml/nba_spread/segment_model_performance.py`, `src/components/ops/nba/NBAOpsTab.tsx` | Model pick probability and calibration buckets; partially valid for diagnostics only | Diagnostics: signal/model bucket until validated |
| MLB / World Cup / Soccer signal DBs | `confidence_tier`, edge-derived A/B/C tiers | Edge bucket from market disagreement / model probability, not calibrated confidence | Signal tier |
| Soccer player props | `sample_confidence` | Player-baseline sample-size quality | Sample confidence, OK as-is when clearly tied to sample size |

## Changes made in this pass

- Renamed misleading UI copy from confidence/conviction to signal strength or market read on default user-facing surfaces.
- Left internal field names intact for compatibility (`confidence`, `confidence_tier`, `pick_confidence`) but documented their meanings.
- Kept NBA calibration views as diagnostics; the current data is useful for debugging but should not be promoted as product-grade model confidence.

## Remaining work

1. Add a dedicated calibration artifact/table that stores predicted probability, realized win rate, CLV, sport, market, source, and sample size by bucket.
2. Backfill calibration from canonical `tracked_picks` once the import path is stable.
3. Gate any future “model confidence” label behind a minimum sample-size rule and calibration error threshold.
4. Consider renaming persisted fields in a later migration only after the API/UI contract is stable; for now, compatibility beats churn.
