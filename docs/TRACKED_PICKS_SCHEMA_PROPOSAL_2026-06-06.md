# Canonical Tracked Picks Schema Proposal — 2026-06-06

Purpose: define the durable ACE source of truth for paper-tracked picks before implementation.

This proposal is additive. It does not delete or rewrite existing sport-specific signal tables.

## Why We Need This

Current Ops data is split across sport-specific and research tables:

- NBA: `signal_log`
- MLB: `mlb_signals`
- Soccer signals: `soccer_signals`
- Soccer approved picks: `soccer_approved_picks`
- Soccer candidates/backtests: `soccer_model_candidates`

That made the UI confusing and created local/prod divergence risk. A real product needs one canonical ledger for what ACE intentionally paper-tracks.

## Core Product Rule

A row in `tracked_picks` means:

> ACE intentionally recorded this pick before, or at the time of, tracking so it can be graded and evaluated as paper performance.

It does **not** mean real-money execution.

For now:

```text
tracking_mode = paper
```

Real-money execution can be added later as a separate mode/ledger, not mixed into this one.

## Recommended DB Location

Use the existing Railway persistent volume path:

```text
ml/nba_spread/data/tracked_picks.db
```

Why:

- same persistent volume as current NBA/MLB/Soccer DBs
- no new Railway volume needed
- easier local/prod parity
- keeps canonical ledger separate from old sport DBs

Alternative: add `tracked_picks` table into one existing DB, likely `signal_log.db`.

Recommendation: **separate `tracked_picks.db`**. It is cleaner and avoids making NBA’s DB look like the owner of cross-sport Ops.

## Table: `tracked_picks`

```sql
CREATE TABLE IF NOT EXISTS tracked_picks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Traceability / import idempotency
  source_table TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_db TEXT,
  source_snapshot_at TEXT,

  -- Product classification
  sport TEXT NOT NULL,                  -- nba | mlb | soccer | ...
  tracking_mode TEXT NOT NULL DEFAULT 'paper',
  origin TEXT NOT NULL,                 -- model_auto | model_approved | operator_manual | historical_signal
  lifecycle TEXT NOT NULL,              -- open | graded | void | no_action | archived
  publish_state TEXT NOT NULL DEFAULT 'internal', -- internal | signal_feed | hidden

  -- Game / event identity
  game_id TEXT NOT NULL,
  game_date TEXT,
  commence_time TEXT,
  league TEXT,
  tournament TEXT,
  home_team TEXT,
  away_team TEXT,
  matchup_label TEXT,

  -- Market / selection
  market TEXT NOT NULL,
  side TEXT NOT NULL,
  line REAL,
  selection_label TEXT,

  -- Price / edge at tracking time
  book TEXT,
  odds_american REAL,
  implied_prob REAL,
  sharp_prob REAL,
  model_prob REAL,
  edge_pp REAL,
  signal_strength REAL,
  confidence_tier TEXT,
  kelly_fraction REAL,
  stake_units REAL,

  -- Model/context
  model_version TEXT,
  confidence_model_version TEXT,
  rationale_json TEXT,
  notes TEXT,

  -- Closing line value
  closing_book TEXT,
  closing_odds_american REAL,
  closing_implied_prob REAL,
  clv_pp REAL,
  clv_points REAL,

  -- Outcome
  home_score INTEGER,
  away_score INTEGER,
  result TEXT,                          -- win | loss | push | void | no_action | unknown
  result_detail TEXT,                   -- home | away | over | under | draw | etc.
  pnl_units REAL,

  -- Timestamps
  detected_at TEXT,
  tracked_at TEXT NOT NULL,
  graded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(source_table, source_id)
);
```

## Indexes

```sql
CREATE INDEX IF NOT EXISTS idx_tracked_picks_sport
  ON tracked_picks(sport);

CREATE INDEX IF NOT EXISTS idx_tracked_picks_lifecycle
  ON tracked_picks(lifecycle);

CREATE INDEX IF NOT EXISTS idx_tracked_picks_game_date
  ON tracked_picks(game_date);

CREATE INDEX IF NOT EXISTS idx_tracked_picks_tracked_at
  ON tracked_picks(tracked_at);

CREATE INDEX IF NOT EXISTS idx_tracked_picks_publish_state
  ON tracked_picks(publish_state);

CREATE INDEX IF NOT EXISTS idx_tracked_picks_origin
  ON tracked_picks(origin);

CREATE INDEX IF NOT EXISTS idx_tracked_picks_source
  ON tracked_picks(source_table, source_id);
```

## Supporting Table: `tracked_pick_import_runs`

Purpose: keep a durable audit trail of imports.

```sql
CREATE TABLE IF NOT EXISTS tracked_pick_import_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_name TEXT NOT NULL,
  source_snapshot_at TEXT,
  source_archive_sha256 TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,                 -- running | completed | failed
  rows_seen INTEGER DEFAULT 0,
  rows_inserted INTEGER DEFAULT 0,
  rows_updated INTEGER DEFAULT 0,
  rows_skipped INTEGER DEFAULT 0,
  notes TEXT,
  error TEXT
);
```

## Lifecycle Semantics

### `open`

Pick is paper-tracked and awaiting result.

### `graded`

Pick is settled with `result in ('win', 'loss', 'push')`.

### `void`

Pick was invalid/cancelled/pushed out of tracking due to missing/invalid market, postponed game, or non-actionable data.

### `no_action`

A signal existed but was intentionally not tracked as a pick. Usually should not appear in Results.

### `archived`

Imported for historical traceability but excluded from default product surfaces.

## Origin Semantics

### `model_auto`

Model produced a pick and ACE automatically paper-tracked it.

This is the default go-forward behavior Pixl approved.

### `model_approved`

Model produced a pick that was manually approved before tracking.

Mostly relevant for older/current soccer approved pick workflow.

### `operator_manual`

Pixl/operator manually entered a pick for paper tracking.

Public UI must not label these “Pixl picks.” Use neutral ACE product copy.

### `historical_signal`

Older signal rows imported for continuity before the canonical ledger existed.

Use when the source does not map cleanly to the go-forward model-auto path.

## Publish State

Internal origin and public display are separate.

### `internal`

Tracked internally; not shown in consumer-facing Signal Feed.

### `signal_feed`

Allowed to appear in consumer-facing Signal Feed with polished ACE copy.

### `hidden`

Excluded from default surfaces; retained for audit/history.

This supports Pixl's request:

- manual/operator picks can be shown publicly;
- they should not be labeled as Pixl picks;
- ACE can internally compare human/operator vs model origin.

## Import Mapping: MLB `mlb_signals`

Source:

```text
mlb_signal_log.db:mlb_signals
```

Mapping:

| tracked_picks field | MLB source |
|---|---|
| source_table | `mlb_signals` |
| source_id | `id` |
| source_db | `mlb_signal_log.db` |
| sport | `mlb` |
| origin | `model_auto` for go-forward rows, `historical_signal` for imported history |
| lifecycle | `status` mapped to `open` / `graded` / `void` |
| game_id | `game_id` |
| game_date | `game_date` |
| commence_time | `commence_time` |
| league | `league` |
| home_team | `home_team` |
| away_team | `away_team` |
| market | `market` |
| side | `bet_side` |
| line | `line` |
| book | `book` |
| odds_american | `book_odds` |
| implied_prob | `book_prob` |
| sharp_prob | `pinnacle_prob` |
| edge_pp | `edge_pp` |
| confidence_tier | `confidence_tier` |
| kelly_fraction | `kelly_fraction` |
| closing_odds_american | `closing_book_odds` |
| closing_implied_prob | `closing_pinnacle_prob` |
| clv_pp | `clv_pp` |
| home_score | `home_score` |
| away_score | `away_score` |
| result_detail | `result` |
| result | `correct` → win/loss or status void/open |
| detected_at | `detected_at` |
| tracked_at | `detected_at` |

## Import Mapping: Soccer `soccer_signals`

Source:

```text
wc_signal_log.db:soccer_signals
```

Mostly identical to MLB, with soccer fields:

| tracked_picks field | Soccer source |
|---|---|
| sport | `soccer` |
| tournament | `tournament` |
| line | `total_line` |
| market | `market` |
| side | `bet_side` |
| source_table | `soccer_signals` |
| source_db | `wc_signal_log.db` |

Classification:

- Import production `soccer_signals` as historical/prospective signal history.
- Do not confuse with `soccer_model_candidates`.

## Import Mapping: Soccer `soccer_approved_picks`

Source:

```text
wc_signal_log.db:soccer_approved_picks
```

Mapping:

| tracked_picks field | Approved pick source |
|---|---|
| sport | `soccer` |
| origin | `model_approved` unless manually entered |
| lifecycle | `graded_status` mapped to `open` / `graded` / `void` |
| game_id | `game_id` |
| commence_time | `commence_time` |
| tournament | `tournament` |
| matchup_label | `fixture_label` |
| market | `market` |
| side | `side` |
| selection_label | `bet_label` |
| model_prob | `model_prob_at_pick` |
| implied_prob | `implied_prob_at_pick` |
| edge_pp | `edge_pp_at_pick` |
| odds_american | `opening_price` |
| book | `opening_book` |
| stake_units | `stake_units` |
| closing_odds_american | `closing_price` |
| closing_book | `closing_book` |
| clv_pp | `clv_pp` |
| result | `graded_status` mapped |
| pnl_units | `pnl_units` |
| rationale_json | `rationale_json` |
| notes | `notes` |
| model_version | `model_version` |
| tracked_at | `approved_at` |
| graded_at | `graded_at` |

Important: production currently has 2 open UCL Final rows from 2026-05-30. These should be reconciled/graded before or during import.

## Import Mapping: NBA `signal_log`

Source:

```text
signal_log.db:signal_log
```

Mapping:

| tracked_picks field | NBA source |
|---|---|
| sport | `nba` |
| source_table | `signal_log` |
| source_db | `signal_log.db` |
| origin | `historical_signal` initially |
| lifecycle | `graded` rows → `graded`; `proxy_captured` requires confirmation; `no_action` excluded/archived |
| game_id | `game_id` |
| game_date | `game_date` |
| commence_time | `commence_time` |
| home_team | `home_team` |
| away_team | `away_team` |
| market | `signal_type` |
| side | `bet_side` |
| line | `line_at_signal` |
| odds_american | `bet_odds` |
| clv_points | `clv_points` |
| home_score | `score_home` |
| away_score | `score_away` |
| result | `covered` relative to `bet_side` |
| detected_at | `detected_at` |
| tracked_at | `detected_at` |

Open question:

- `proxy_captured` is not automatically a tracked pick result. It needs explicit mapping before import into Results.

## Excluded from Results Import

### Soccer `soccer_model_candidates`

Keep in Research.

Reason: production candidate rows have `game_date` before `detected_at`/`created_at`, indicating backfill/research validation, not clean prospective paper tracking.

### NBA `predictions`, `book_lines`, `divergence_alerts`

Keep for Research/Diagnostics.

These support analysis but are not themselves tracked picks.

### Soccer prop cards/results

Keep in Research/Diagnostics until productized as a tracked prop-pick workflow.

## Go-Forward Behavior

### Model-generated picks

When a model pick qualifies:

1. Insert into sport-specific signal table if existing workflow needs it.
2. Insert/upsert into `tracked_picks` as `origin = model_auto`.
3. Set `tracking_mode = paper`.
4. Set `publish_state` based on product rules.
5. Grade later into the same row.

Eventually sport-specific signal tables can become diagnostics/history rather than the primary product source.

### Operator/manual picks

When Pixl/operator creates a manual pick:

1. Insert into `tracked_picks` directly.
2. Set `origin = operator_manual`.
3. Set `tracking_mode = paper`.
4. Allow `publish_state = signal_feed` if it should appear on consumer board.
5. Public UI must use neutral ACE copy, not internal operator labels.

## APIs to Build on This

### `/api/ops/today`

Reads `tracked_picks` where:

- `lifecycle = open`
- upcoming/today relevant ET window

### `/api/ops/results`

Reads `tracked_picks` where:

- `lifecycle = graded`
- filters by sport/date/market/origin/model_version

### `/api/ops/research`

Reads research/candidate/backtest data:

- `soccer_model_candidates`
- edge buckets
- calibration
- candidate grading
- model experiments

### `/api/ops/diagnostics`

Reads worker/admin/system state:

- job runs
- quota
- raw table counts
- sync health
- import runs

## Migration Safety Rules

1. Never delete old tables during initial migration.
2. Preserve `source_table`, `source_db`, and `source_id` for every imported row.
3. Use `UNIQUE(source_table, source_id)` to make imports idempotent.
4. Dry-run first against exported production DBs.
5. Report row counts before/after.
6. Keep production DB backup hash with the import run.
7. Do not import candidate/backfill data into Results by default.
8. Do not expose internal origin labels in consumer UI.
9. Do not label unvalidated heuristic tiers as model confidence.

## Recommended Implementation Module

Create:

```text
ml/ops/tracked_picks.py
```

Responsibilities:

- `init_db(path)`
- `import_mlb_signals(source_db, target_db, dry_run=True)`
- `import_soccer_signals(source_db, target_db, dry_run=True)`
- `import_soccer_approved_picks(source_db, target_db, dry_run=True)`
- `import_nba_signal_log(source_db, target_db, dry_run=True)`
- `summarize(target_db)`

CLI usage:

```bash
python3 -m ml.ops.tracked_picks init
python3 -m ml.ops.tracked_picks import --source-dir /path/to/exported/dbs --dry-run
python3 -m ml.ops.tracked_picks import --source-dir /path/to/exported/dbs --apply
python3 -m ml.ops.tracked_picks summarize
```

## Recommendation

Approve this schema direction and implement it locally first against the exported production DBs.

No production migration should run until local dry-run/import counts are reviewed.
