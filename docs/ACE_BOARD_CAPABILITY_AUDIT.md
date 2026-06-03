# ACE Board Capability Audit

Status: Draft brief for Claude Code / implementation audit
Date: 2026-06-03

## Product correction

ACE right now is not primarily an "AI picks machine." ACE is the the betting research/intelligence layer that compresses hours of slate research into minutes.

Core promise:
- Package the data clearly and concise and display easily, not provided over analyzed.
- Pull together odds, movement, news, injuries, lineups, weather, matchup context, model signals, and receipts.
- Let users browse seamlessly and make sharper decisions.
- Picks can exist sort of as "what ACE took today — DYOR," but they are not the main selling point.

## Audit goal

Before building more UI/pick surfaces, confirm what data we have, where it comes from, how fresh/fast it is, and whether it is reliable enough for launch.

Claude Code should fill this table with evidence from code, DB, API responses, logs, or timed route checks. No guessing.

## Capability checklist

Filled with measured evidence on 2026-06-03 (see "Audit results" below).

| Capability | Real? | Source/provider | Freshness / speed (measured) | Launch status | Notes |
|---|---|---|---|---|---|
| Live odds board | ✅ REAL | Odds API | `/api/board` warm **17–35ms**; multi-sport (WC, MLB, NBA, NHL) | READY | Dev-only mock fallback; prod shows maintenance screen if empty. Fast + reliable. |
| Book comparison / best price | ✅ REAL | Odds API | derived from `Game.bookmakers` on each board fetch | READY | Pure odds math (best vs consensus). |
| Line movement | 🟡 PARTIAL | Odds API snapshot cache | `server-cache` movement map, recomputed per poll | OK | Tied to poll cadence; in-memory cache (may not survive restart). |
| Soccer fixture scan | 🟠 REAL but SLOW | Sportmonks | `/api/ops/soccer/friendlies` shells to Python **every call, NO cache → 30–45s** | NEEDS CACHE | Root cause confirmed: `spawnSync` python `scan_friendlies` per request. |
| Friendlies / WC warmups | ✅ REAL | Sportmonks | same slow path | analyzable | Bettable depends on odds coverage per fixture. |
| Soccer model signals | 🟠 REAL but STALE | internal model + DB | `soccer_model_candidates` = 606 rows, **last detected May 27** | EXPERIMENTAL | Only Over 2.5 proven; excluded from consumer feed (paused). |
| Proven/experimental verdicts | ✅ DONE (M49) | backtest V2 | `src/lib/market-tier.ts` + `TierBadge`, live on `/performance` | READY | Single source; agrees with ops + featured route. |
| Pick lifecycle / grading | ✅ infra real, EMPTY | internal DB + Sportmonks | `soccer_approved_picks` = **0 rows** (purged); grader exists | READY | Starts clean at WC; no stale picks possible. |
| Consumer sport filtering | ✅ FIXED + VERIFIED | internal routing | `src/lib/sport-tab.ts` routes on `sport_key`; WC→SOCCER confirmed | READY | Soccer only in Soccer+All; no cross-leak. |
| **Injury alerts** | ❌ **EMPTY** | WC injury cache | `wc_injuries` = **0 rows** — fetcher not populating | **NOT READY** | **Biggest gap.** The headline "research" feature shows nothing. |
| Lineups | 🟠 NOT SURFACED | Sportmonks | `soccer_sportmonks_fixture_cache` = 1 row (May 30); not on consumer board | not surfaced | Sportmonks serves pre-match ~1h before kick; only in ops/detail. |
| Weather | ✅ REAL / LIVE | open-meteo (no key) | live probe OK (NYC 19.1°C); surfaces only as occasional "signal" | real, underused | Works; not a clean always-on panel. |
| News monitoring | ✅ REAL / LIVE | ESPN public API (no key) | live probe OK (6 NBA articles); surfaces as "signal" | real, underused | Aggregation, not faster than ESPN itself. |
| Roster/squad data | 🟡 PARTIAL/STALE | Sportmonks/cache | `wc_players` = 53 (May 28); `player_baselines` = 1738 (leaky, no ts) | partial | WC squad readiness incomplete. |
| Player props context | 🟡 PARTIAL | internal + Sportmonks/Understat | `soccer_prop_cards` = 418 (May 25) | POST-LAUNCH | Experimental; do not sell as proven. |
| Historical track record | ✅ infra real, EMPTY | internal graded picks | `/performance` = 0 graded now; backtest data RICH (988k closing-odds rows) | READY | Starts clean; current model only publicly. |
| Featured pick (subscriber) | ✅ REAL | model + V2 gate | `/api/picks/featured` **3.4s** (shells to python); returns null when no edge | READY | Only Over 2.5 can surface; verdicts now correct. |
| Alerts/notifications | 🟡 TBD | app notifications | price alerts via `/api/alerts`; browser notif | partial | Not deeply verified what fires automatically. |

## Speed questions to answer

For each live source/route:
1. Cold request latency.
2. Warm/cache-hit latency.
3. Cache TTL.
4. Last successful fetch timestamp.
5. Failure mode when provider is down/out of credits.
6. Whether data updates faster than books, slower than books, or only complements books.

## Competitive/source comparison questions

For each important event type:
- Odds move: how quickly do we show it vs the book/API?
- Injury: how quickly do we know vs ESPN/FotMob/SofaScore/team X accounts?
- Lineup: how quickly do we know vs official lineup posts and books?
- Weather: do we have venue-specific actionable weather or generic city weather?
- News: are we ingesting enough sources to be useful, or just summarizing late public info?

## Launch-quality definition

A capability is launch-ready only if:
- The source is real, not demo/fallback.
- The UI clearly indicates stale/empty/unknown states.
- Latency is measured, not guessed.
- Failure mode is safe and honest.
- It upgrades user research even if ACE never publishes a pick.

## Audit results (2026-06-03)

```text
DONE:
- Sources audited: odds board, best-price, line movement, soccer scan/friendlies,
  soccer model signals, verdicts, pick lifecycle, sport filtering, injuries,
  lineups, weather, news, roster/squad, player props, track record, featured pick.
- Timings measured (warm, dev server):
    /api/board ............ 17–35 ms   (fast, cached)
    /api/picks/history .... 0.35 s
    /api/picks/featured ... 3.4 s      (shells to python)
    /api/ops/soccer/friendlies ... 30–45 s, NO CACHE (shells to python per call)
- Live-source liveness confirmed: ESPN news (6 NBA articles), open-meteo weather
  (live), Odds API board (multi-sport), Sportmonks historical (988k odds rows).

- LAUNCH-READY: live odds board, best price, proven/experimental verdicts (M49),
  consumer sport filtering, pick lifecycle (clean/empty), historical track-record
  infra, featured-pick endpoint.

- PARTIAL/NOT-READY: injuries (EMPTY — 0 rows, headline gap), lineups (not on
  consumer board), news + weather (live but buried as occasional "signals", not a
  clean panel), soccer model signals (stale, May 27, paused), friendlies scan
  (works but 30–45s, no cache), roster/squad (partial/stale), alerts (unverified).

- BIGGEST DATA GAPS:
    1. Injuries: the single most important "research" feature is EMPTY. The
       wc_injuries fetcher is not populating. (NBA injuries path unverified too.)
    2. Live data is STALE: model signals / candidates last ran ~May 27–30. The
       freshness depends on a background worker that is NOT currently running.
    3. The board is INVERTED: it foregrounds odds-math jargon (no-vig %) + sparse
       NBA-only model chips, and hides/omits the real research (injuries, lineups,
       news, weather).

- FASTEST PATH TO MAKE ACE FEEL LIKE "THE BOARD":
    a. Populate injuries (fix/run the injury fetcher) + surface them per game.
    b. Surface news + weather as a clean per-game context strip (data is already
       live) instead of burying them as occasional signals.
    c. De-emphasize / hide the no-vig % + stale model chips for the consumer view.
    d. Cache the friendlies/soccer scan (kill the 30–45s shell-per-call).
    e. Ensure the background worker runs so "freshness" is real, not May-30 stale.

VERIFIED:
- DB inventory: 30+ tables across signal_log.db / wc_signal_log.db / mlb_signal_log.db
  with row counts + freshness timestamps (wc_injuries=0, mlb_signals=0,
  soccer_approved_picks=0, soccer_model_candidates=606@May27, soccer_hist_*=fresh).
- Route timings via curl -w (above).
- Liveness probes: ESPN + open-meteo returned real data on 2026-06-03.
- No commit (audit is read-only / doc-only).

NEXT DECISION (for Pixl):
- Confirm the repositioning: invert the board to a research cockpit — real
  injuries/news/weather/lineups foregrounded, model jargon demoted.
- Decide injuries priority: is a populated injury feed a launch blocker for the
  "research tool" promise? (Recommend: yes — it's the headline feature.)
- Decide whether the background worker must run for launch (freshness), or whether
  launch is "board + research context" with picks fully de-emphasized.
```

## Recommended immediate Claude Code task

Run an ACE Board Capability Audit and fill this doc with evidence.

Required output:
```text
DONE:
- Sources audited:
- Timings measured:
- Launch-ready capabilities:
- Partial/not-ready capabilities:
- Biggest data gaps:
- Fastest path to make ACE feel like the board:

VERIFIED:
- commands/routes run
- timestamps/latencies
- commit hash if changed

NEXT DECISION:
- what Pixl needs to choose
```
