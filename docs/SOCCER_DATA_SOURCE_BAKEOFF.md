# ACE Soccer Data Source Bakeoff

Status: v0.1 proof-of-concept plan
Owner: ACE internal ops

## Product requirement

ACE soccer should be a real football intelligence product, not an odds-discrepancy/arbitrage product.

Target flow:

```text
team/player variables -> model read -> pick recommendation -> odds/price check
```

Needed data classes:

| Class | Why it matters | Examples |
| --- | --- | --- |
| Team form | Match outcome, totals | W-D-L, GF/GA, xG/xGA, shots, SoT, corners |
| Player baselines | Goalscorer/prop model | minutes, goals/90, shots/90, SoT/90, assists |
| Availability | Major probability swing | injuries, suspensions, confirmed/expected lineups |
| Match context | Totals/style adjustment | referee cards, weather, venue, rest/congestion |
| Live events | Grading + in-play later | goals, cards, subs, shots, lineups |
| Odds/props | Routing only after model case | anytime scorer, shots, SoT, assists, cards |

## Scoring rubric

Each source gets 1-5 for:

- **Coverage**: leagues/competitions and player-prop depth
- **Freshness**: live/update latency
- **Reliability**: stable schema, uptime, breakage risk
- **Commercial safety**: API/ToS fit for a product
- **Cost fit**: can ACE afford it while pre-revenue?
- **Integration difficulty**: engineering lift and maintenance

## Current source rankings

| Rank | Source | Role | Verdict |
| --- | --- | --- | --- |
| 1 | Sportmonks trial | Paid production candidate | Best first paid test: affordable enough to validate lineups/player stats quickly. |
| 2 | soccerdata package | Free/internal research | Best no-spend POC; useful for model building, but scraper fragility/ToS risk means internal-only until cleared. |
| 3 | SportsDataIO Soccer | Premium production candidate | Best all-in-one if budget allows; likely custom/expensive. |
| 4 | StatsBomb Open Data | Training data | Excellent event/lineup data for model training; not live coverage. |
| 5 | API-Football | Sparse fallback only | 100/day credits and account/season restrictions make it unsuitable for player-prop daily ops. |
| 6 | PlayerStats.football | Inspiration/possible partnership | Great prop UX/data concept, but do not scrape; ToS prohibits copying/reproduction. |

## Source notes

### soccerdata Python package

Repository/docs:
- https://github.com/probberechts/soccerdata
- https://soccerdata.readthedocs.io/
- https://pypi.org/project/soccerdata/

Supports scrapers for sources including FotMob, SofaScore, Understat, FBref, ESPN, WhoScored, ClubElo, and football-data.co.uk. Latest PyPI line supports Python >=3.9 and <3.14.

ACE use:
- Internal research/backtesting
- Fill team/player stats where stable
- Probe FotMob/SofaScore/Understat/FBref coverage

Risk:
- Scrapers can break when sites change.
- Commercial use requires ToS/legal review.

### Sportmonks

Docs/pricing:
- https://www.sportmonks.com/football-api/plans-pricing/
- https://docs.sportmonks.com/football/
- https://docs.sportmonks.com/v3/endpoints-and-entities/endpoints/premium-expected-lineups

ACE use:
- First paid trial for squads, fixtures, player stats, lineups, injuries/suspensions, expected lineups add-on.

Risk:
- Expected lineups are paid add-on.
- Need test for World Cup and player-prop depth.

### SportsDataIO Soccer

Docs:
- https://sportsdata.io/developers/workflow-guide/soccer
- https://sportsdata.io/developers/api-documentation/soccer

ACE use:
- Production-grade candidate if Sportmonks is insufficient.
- Strong candidate for betting/productized player stats, lineups, injuries, odds/props.

Risk:
- Likely higher/custom pricing.

### StatsBomb Open Data

Repository:
- https://github.com/statsbomb/open-data

ACE use:
- Train/evaluate event-based xG and player prop priors.
- Build model features independent of live feed cost.

Risk:
- Limited competitions; not live.

### API-Football

Current local finding:
- Key exists, but 2025 player endpoints were unavailable on free plan.
- 2024 call returned account suspended.
- Pixl confirmed 100 daily credits.

ACE use:
- Do not use as primary.
- Keep only for sparse metadata if account is repaired.

### PlayerStats.football

Site/terms:
- https://playerstats.football/about
- https://playerstats.football/terms-of-service

ACE use:
- Product inspiration or partnership target.

Risk:
- Do not scrape/copy without permission.

## Bakeoff deliverables

1. Normalized source schema in code.
2. `soccerdata` adapter POC that can run without breaking if dependency is missing.
3. CLI to print source status and attempt source probes.
4. Scorecard artifact from real probe outputs.
5. Decision: free/internal only vs Sportmonks trial vs SportsDataIO contact.

## First live POC result — soccerdata / Understat

Ran `soccerdata==1.8.8` in a throwaway `/tmp/ace-soccerdata-poc` install.

Import status:

- Installed and importable in isolated target directory.
- Exposed providers: ClubElo, ESPN, FBref, FotMob, Sofascore, SoFIFA, Understat, WhoScored.

Understat EPL 2024/25 probe:

- `read_schedule`: 380 rows
- `read_player_season_stats`: 562 rows
- `read_team_match_stats`: 380 rows

Observed useful fields:

- Match schedule/team xG: `home_xg`, `away_xg`, goals, dates, teams, PPDA, deep completions.
- Player season stats: `player`, `team`, `position`, `matches`, `minutes`, `goals`, `xg`, `np_xg`, `assists`, `xa`, `shots`, `key_passes`, cards.

Immediate value:

- Strong no-spend source for xG/team and player shooting baselines across supported Understat leagues.
- Good enough to enrich ACE internal props for Big Five leagues.

Limitations:

- Understat does not cover every league/competition.
- Player match stats can be slower/heavier; use season stats and team match stats first.
- Internal/research use only until ToS/commercial clearance.

## Initial implementation plan

```text
ml/soccer/sources/
  base.py         normalized dataclasses + scoring types
  soccerdata_adapter.py
  sportmonks.py  stub until key/trial exists
  sportsdataio.py stub until key/contact exists
  cli.py
```

Adapter output should normalize into ACE shapes:

- `TeamMatchStats`
- `PlayerSeasonStats`
- `AvailabilityReport`
- `LineupProjection`
- `ProviderProbeResult`

This lets ACE swap providers without rewriting the model.
