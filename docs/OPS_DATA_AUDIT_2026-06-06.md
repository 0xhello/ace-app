# ACE Ops Data Audit — 2026-06-06

Purpose: preserve and classify current Ops data before designing or running a canonical tracked-picks migration.

## Executive Summary

Pixl's screenshot was correct: production contains active/recent MLB, Soccer, and NBA signal history that the local DB snapshot does not contain.

The local app should **not** be treated as the full data source for migration planning.

Production Railway volume has the live signal DBs mounted at:

```text
/app/ml/nba_spread/data
```

Raw production signal DBs were exported read-only into a local private audit artifact:

```text
docs/audits/prod-ops-2026-06-06/raw-db/prod-signal-dbs.tar.gz
```

Archive SHA-256:

```text
f0692d86ecce0c0684c63eb9f4db979fb437eef6a0e70eb665f61ea4377b3eef
```

Raw JSON endpoint snapshots were also captured under:

```text
docs/audits/prod-ops-2026-06-06/
```

These raw artifacts are intentionally excluded from git to avoid committing production data into repo history.

## Production Overview Snapshot

Authenticated production `/api/ops/overview` on 2026-06-06 showed:

| Sport | Total | Open | Graded | Record | Win Rate | ROI |
|---|---:|---:|---:|---:|---:|---:|
| Soccer | 18 | 0 | 18 | 7W-11L | 38.9% | -25.8% |
| MLB | 64 | 6 | 57 | 27W-30L | 47.4% | -9.6% |
| NBA | 47 | 0 | 25 | 11W-14L | 44.0% | -16.0% |

Combined edge-bucket view showed 100 graded signals across NBA/MLB/Soccer.

## Production DB Inventory

### `mlb_signal_log.db`

Tables:

- `meta`: 3 rows
- `mlb_signals`: 64 rows
- `sqlite_sequence`: 1 row

`mlb_signals` schema:

```text
id, game_id, game_date, home_team, away_team, commence_time, league, market, bet_side, line, signal_type, pinnacle_prob, book, book_prob, book_odds, edge_pp, home_score, away_score, result, correct, status, notes, detected_at, created_at, confidence_tier, kelly_fraction, reasoning_json, closing_pinnacle_prob, closing_book_odds, clv_pp
```

Date range:

- `game_date`: 2026-05-18 → 2026-06-05
- `detected_at`: 2026-05-19T00:33:31Z → 2026-06-05T22:11:54Z

Status counts:

- `graded`: 57
- `open`: 6
- `void`: 1

Market counts:

- `run_line`: 24
- `totals`: 21
- `h2h`: 19

Correct counts:

- wins: 27
- losses: 30
- ungraded/void/open: 7

Audit classification:

- Treat as **prospective model signal history** unless row-level checks prove otherwise.
- Candidate for import into canonical `tracked_picks` as `origin = model_auto`, `source_table = mlb_signals`.
- Needs row-level validation for duplicate same-game/multi-market exposure and stale-line issues.

## `signal_log.db` / NBA

Tables:

- `book_lines`: 24,217 rows
- `divergence_alerts`: 178 rows
- `execution_log`: 26 rows
- `line_snapshots`: 70 rows
- `meta`: 18 rows
- `predictions`: 46 rows
- `signal_log`: 47 rows
- `sqlite_sequence`: 6 rows

`signal_log` schema:

```text
id, game_id, game_date, home_team, away_team, commence_time, signal_type, signal_detail, detected_at, opening_line, line_at_signal, execution_source, closing_line, closing_source, closing_captured_at, bet_side, bet_odds, score_home, score_away, covered, clv_points, regime, bet_rest_days, opp_rest_days, status, notes, created_at
```

Date range:

- `game_date`: 2026-04-26 → 2026-06-05
- `detected_at`: 2026-04-27T03:46:48Z → 2026-06-05T07:56:25Z

Status counts:

- `graded`: 25
- `proxy_captured`: 20
- `no_action`: 2

Signal type counts:

- `soft_book_divergence`: 26
- `steam_move`: 15
- `line_movement`: 6

Covered counts:

- wins: 11
- losses: 14
- null/ungraded/proxy/no-action: 22

Audit classification:

- Treat `graded` rows as **early/current tracked NBA signal history**, not dismissed as legacy.
- `proxy_captured` needs classification before import. It may represent captured market movement rather than a tracked paper pick.
- `no_action` should not enter Results; likely belongs in diagnostics/research or remains historical signal metadata.
- Candidate for import into canonical `tracked_picks` only after status mapping is explicit.

## `wc_signal_log.db` / Soccer

Tables of interest:

- `soccer_signals`: 18 rows
- `soccer_approved_picks`: 2 rows
- `soccer_model_candidates`: 219 rows
- `soccer_prop_cards`: 48 rows
- `soccer_player_prop_results`: 187 rows
- plus context/team/player/provider tables

### `soccer_signals`

Schema:

```text
id, game_id, game_date, home_team, away_team, commence_time, tournament, market, bet_side, total_line, signal_type, pinnacle_prob, book, book_prob, book_odds, edge_pp, home_score, away_score, result, correct, status, notes, detected_at, created_at, confidence_tier, kelly_fraction, reasoning_json, closing_pinnacle_prob, closing_book_odds, clv_pp, player_name, api_player_id, prior_prob, book_offers, best_book, best_book_odds
```

Date range:

- `game_date`: 2026-05-22 → 2026-05-24
- `detected_at`: 2026-05-21T09:21:11Z → 2026-05-24T18:08:28Z

Status counts:

- `graded`: 18

Market counts:

- `h2h`: 14
- `totals`: 4

Correct counts:

- wins: 7
- losses: 11

Audit classification:

- Treat as **prospective soccer signal history** unless row-level evidence says otherwise.
- Candidate for canonical `tracked_picks` import as `origin = model_auto`, `source_table = soccer_signals`.

### `soccer_approved_picks`

Rows: 2

Both are UCL Final approved picks for PSG vs Arsenal:

1. Over 2.5 goals
2. Both teams to score — yes

Both rows currently have:

- `graded_status = open`
- `approved_at`: 2026-05-30T16:22Z
- `model_version`: `v2_post_m21`
- explicit leakage/upward-bias warnings in rationale JSON

Audit classification:

- These are closer to the future manual/model-approved tracked-pick concept than `soccer_model_candidates`.
- They should be reviewed/graded before import because the game is already in the past as of 2026-06-06.
- Because rationale includes leakage/upward-bias warnings, import should preserve `model_version`, warnings, and source context.

### `soccer_model_candidates`

Rows: 219 in production snapshot.

Date range:

- `game_date`: 2026-04-12 → 2026-05-24
- `detected_at`: 2026-05-27T02:42:52Z only
- `created_at`: 2026-05-27T02:42:52Z only

Status:

- `graded`: 219

Record:

- 98W-121L
- win rate: 44.7%

Important audit conclusion:

Many candidate rows have `game_date` before `detected_at`/`created_at`. That strongly indicates backfill/research validation, not prospective paper-tracked picks.

Audit classification:

- Keep in **Research / validation**, not Results.
- Do not bulk-promote into canonical `tracked_picks` as historical tracked results.
- Useful for model debugging and leakage/edge validation.

## Local vs Production Divergence

Local snapshot differs materially from production:

### Local MLB

`ml/nba_spread/data/mlb_signal_log.db`

- `mlb_signals`: 0 rows

### Local Soccer

`ml/nba_spread/data/wc_signal_log.db`

- `soccer_signals`: 0 rows
- `soccer_approved_picks`: 0 rows
- `soccer_model_candidates`: 606 rows
- `soccer_prop_cards`: 418 rows
- `soccer_player_prop_results`: 73 rows

### Production Soccer

`wc_signal_log.db`

- `soccer_signals`: 18 rows
- `soccer_approved_picks`: 2 rows
- `soccer_model_candidates`: 219 rows
- `soccer_prop_cards`: 48 rows
- `soccer_player_prop_results`: 187 rows

Conclusion:

Production and local are not just different row counts; they represent different runtime histories/snapshots. Migration cannot rely on local alone.

## Why ROI Appears Negative

Current high-level symptoms:

- NBA: -16.0% ROI
- MLB: -9.6% ROI
- Soccer signals: -25.8% ROI
- Soccer candidates: 44.7% win rate
- Combined edge buckets show the 4-5pp bucket underperforming the 3-4pp bucket.

Initial product/model hypotheses to investigate:

1. Edge threshold is too low; most signals cluster in 3-4pp.
2. Edge magnitude is not currently predictive enough.
3. Signal strength/confidence tiers may be miscalibrated.
4. Positive CLV does not guarantee realized ROI over small samples, but persistent negative ROI needs scrutiny.
5. Multiple correlated bets on same game may inflate exposure and distort record.
6. Some data may be proxy/candidate/backfill rather than clean prospective picks.
7. Soccer candidate set appears backfilled and should not be mixed with prospective signal performance.
8. Closing-price capture is incomplete in some rows, limiting CLV reliability.

## Recommended Canonical Import Policy

### Import as paper-tracked history after validation

- MLB `mlb_signals` rows with `status in ('graded', 'open', 'void')`
- Soccer `soccer_signals` rows with `status = 'graded'`
- NBA `signal_log` rows with `status = 'graded'`
- Soccer `soccer_approved_picks` after explicit review/grading

### Do not import into Results by default

- Soccer `soccer_model_candidates`
- NBA `proxy_captured` rows
- NBA `no_action` rows
- Research/backtest rows generated after game completion

### Preserve separately for Research/Diagnostics

- Soccer candidates
- Soccer prop cards/results
- NBA predictions/book lines/divergence alerts
- Line snapshots
- Execution logs

## Migration Readiness Verdict

ACE is **ready to design** the canonical DB migration.

ACE is **not ready to run** the migration until:

1. Row-level import rules are finalized.
2. Soccer approved picks are graded/reconciled.
3. NBA `proxy_captured` semantics are confirmed.
4. Duplicate/correlated same-game exposure rules are defined.
5. A dry-run import produces expected counts.
6. Rollback/backup process is tested locally.

## Recommended Next Engineering Steps

1. Design canonical `tracked_picks` schema.
2. Write an idempotent local migration script that creates `tracked_picks` without deleting old tables.
3. Write import adapters:
   - `import_mlb_signals`
   - `import_soccer_signals`
   - `import_nba_signal_log`
   - `import_soccer_approved_picks`
4. Add `source_table`, `source_id`, and unique constraint to prevent duplicate imports.
5. Add `origin` field:
   - `model_auto`
   - `model_approved`
   - `operator_manual`
   - `historical_signal`
6. Add `tracking_mode = paper` only for now.
7. Build `/api/ops/today` and `/api/ops/results` from `tracked_picks`.
8. Keep `/api/ops/research` separate for candidates/backtests.
9. Keep diagnostics/admin controls separate.

## Product Direction Confirmation

The correct product shape remains:

```text
Today | Results | Research | Diagnostics
```

But this audit confirms the UI must be backed by a real canonical ledger and must preserve production signal history, not reset from local empty tables.
