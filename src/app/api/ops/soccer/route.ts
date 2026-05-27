import { NextRequest, NextResponse } from "next/server";
import { spawnSync } from "child_process";
import path from "path";

export const dynamic = "force-dynamic";

interface SoccerSignal {
  id: number;
  game_id: string;
  game_date: string;
  home_team: string;
  away_team: string;
  commence_time: string | null;
  market: string;
  bet_side: string;
  total_line: number | null;
  pinnacle_prob: number | null;
  book: string;
  book_prob: number | null;
  book_odds: number | null;
  edge_pp: number | null;
  home_score: number | null;
  away_score: number | null;
  result: string | null;
  correct: number | null;
  status: string;
  notes: string | null;
  detected_at: string;
  // Pick-quality fields (added by signal_logger _migrate)
  confidence_tier: "A" | "B" | "C" | null;
  kelly_fraction: number | null;
  reasoning_json: string | null;
  closing_pinnacle_prob: number | null;
  closing_book_odds: number | null;
  clv_pp: number | null;
}

interface WCInjury {
  team_name: string;
  player_name: string;
  status: "out" | "suspended" | "questionable";
  reason: string | null;
  updated_at: string;
}

interface SoccerCandidate {
  id: number;
  game_id: string;
  sport_key: string;
  tournament: string;
  game_date: string;
  home_team: string;
  away_team: string;
  model_home_team: string;
  model_away_team: string;
  commence_time: string | null;
  market: string;
  bet_side: string;
  total_line: number | null;
  model_prob: number;
  book_prob: number;
  book_odds: number;
  book: string;
  edge_pp: number;
  confidence_tier: "A" | "B" | "C";
  status: string;
  rationale_json: string | null;
  review_notes: string | null;
  reviewed_at: string | null;
  home_score: number | null;
  away_score: number | null;
  result: string | null;
  correct: number | null;
  graded_at: string | null;
  exposed_to_beta: number;
  detected_at: string;
  updated_at: string;
}

interface ActualPick {
  id: number;
  source: "approved" | "shortlist";
  status: string;
  tournament: string;
  game_date: string;
  commence_time: string | null;
  matchup: string;
  market: string;
  pick: string;
  book: string;
  odds: number;
  model_prob: number;
  market_prob: number;
  edge_pp: number;
  confidence_tier: "A" | "B" | "C";
  stake_units: number;
  reason: string;
  correct: number | null;
  result: string | null;
}

interface FootballAnalysisCard {
  game_id: string;
  league: string;
  matchup: string;
  commence_time: string | null;
  prediction: Record<string, unknown>;
  variables: Record<string, unknown>;
  picks: Array<{
    market: string;
    pick: string;
    model_prob: number;
    confidence: "A" | "B" | "C";
    football_case: string[];
    route: { book: string; odds: number; market_prob: number } | null;
  }>;
}

interface PropCard {
  id: number;
  game_id: string;
  sport_key: string;
  tournament: string;
  commence_time: string | null;
  home_team: string;
  away_team: string;
  team: string;
  opponent: string;
  player_name: string;
  market: string;
  model_prob: number | null;
  model_mean: number | null;
  book: string | null;
  book_odds: number | null;
  book_point: number | null;
  implied_prob: number | null;
  edge_pp: number | null;
  decision: string;
  confidence_tier: "A" | "B" | "C";
  blocker_reasons: string[];
  bettor_notes: string[];
  context: Record<string, unknown>;
}

interface WCData {
  signals: SoccerSignal[];
  meta: Record<string, string>;
  injuries: WCInjury[];
  candidates: SoccerCandidate[];
  actualPicks: ActualPick[];
  footballAnalysis: FootballAnalysisCard[];
  propCards: PropCard[];
  propCardStats: { by_decision: Record<string, number>; priced: number; top_edge_pp: number | null };
  candidateStats: { total: number; by_status: Record<string, number>; top_edge_pp: number | null; record?: { graded: number; wins: number; losses: number; win_rate: number | null } };
  error?: string;
}

function readWCData(dbPath: string, appRoot: string): WCData {
  // Calling init_db() here triggers _migrate() — keeps the prod schema
  // current any time the ops dashboard is loaded. Idempotent and cheap.
  // Injuries are pulled from wc_injuries (populated by context.sync_injuries
  // on the worker's daily 7am ET tick).
  const script = `
import json, sys
from pathlib import Path
try:
    from ml.world_cup.signal_logger import init_db, get_db
    from ml.world_cup.context import init_context_tables
    from ml.soccer.candidates import init_db as init_candidate_db, list_candidates, list_actual_picks, stats as candidate_stats
    from ml.soccer.analysis import analyze_slate
    from ml.soccer.prop_cards import init_db as init_prop_cards_db, list_cards as list_prop_cards, stats as prop_card_stats
    from ml.soccer.live_state import init_db as init_live_state_db
    db_path = Path(${JSON.stringify(dbPath)})
    init_db(db_path)
    init_context_tables(db_path)
    init_candidate_db(db_path)
    init_prop_cards_db(db_path)
    init_live_state_db(db_path)
    conn = get_db(db_path)
    sigs = conn.execute("SELECT * FROM soccer_signals ORDER BY detected_at DESC").fetchall()
    meta_rows = conn.execute("SELECT key, value FROM meta").fetchall()
    inj_rows = []
    try:
        inj_rows = conn.execute(
            "SELECT team_name, player_name, status, reason, updated_at "
            "FROM wc_injuries "
            "ORDER BY CASE status WHEN 'out' THEN 0 WHEN 'suspended' THEN 1 ELSE 2 END, team_name"
        ).fetchall()
    except Exception:
        pass
    conn.close()
    print(json.dumps({
        "signals":  [dict(r) for r in sigs],
        "meta":     {r["key"]: r["value"] for r in meta_rows},
        "injuries": [dict(r) for r in inj_rows],
        "candidates": list_candidates(db_path, limit=40),
        "actualPicks": list_actual_picks(db_path, limit=8),
        "footballAnalysis": analyze_slate(limit=8),
        "propCards": list_prop_cards(db_path, limit=24),
        "propCardStats": prop_card_stats(db_path),
        "candidateStats": candidate_stats(db_path),
    }))
except Exception as e:
    print(json.dumps({"signals": [], "meta": {}, "injuries": [], "candidates": [], "actualPicks": [], "footballAnalysis": [], "propCards": [], "propCardStats": {"by_decision": {}, "priced": 0, "top_edge_pp": None}, "candidateStats": {"total": 0, "by_status": {}, "top_edge_pp": None}, "error": str(e)}))
`;
  // 60s timeout — analyze_slate hits the Odds API for ~5 leagues which can
  // take 15-30s under load. Previously 20s, which silently truncated JSON
  // output and made candidates/stats return empty in the UI with no error.
  // If we ever need this faster, move analyze_slate to a worker-driven
  // cache instead of fetching synchronously inside the request path.
  const result = spawnSync("python3", ["-c", script], {
    encoding: "utf-8",
    timeout: 60_000,
    cwd: appRoot,
  });
  try {
    return JSON.parse(result.stdout) as WCData;
  } catch {
    return { signals: [], meta: {}, injuries: [], candidates: [], actualPicks: [], footballAnalysis: [], propCards: [], propCardStats: { by_decision: {}, priced: 0, top_edge_pp: null }, candidateStats: { total: 0, by_status: {}, top_edge_pp: null } };
  }
}

function updateCandidate(
  dbPath: string,
  appRoot: string,
  id: number,
  status: string,
  notes?: string | null,
): { ok: boolean; candidate?: SoccerCandidate; error?: string; output?: string } {
  const script = `
import json
from pathlib import Path
try:
    from ml.soccer.candidates import update_candidate_status
    row = update_candidate_status(${JSON.stringify(id)}, ${JSON.stringify(status)}, ${JSON.stringify(notes ?? null)}, Path(${JSON.stringify(dbPath)}))
    print(json.dumps({"ok": row is not None, "candidate": row}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
`;
  const result = spawnSync("python3", ["-c", script], {
    encoding: "utf-8",
    timeout: 5_000,
    cwd: appRoot,
  });
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { ok: false, error: "parse error", output: result.stdout.slice(0, 400) };
  }
}

function runJob(
  module: string,
  extraArgs: string[] = [],
  appRoot: string,
): { ok: boolean; output: string } {
  const result = spawnSync(
    "python3",
    ["-m", "ml.nba_spread.run_job", module, ...extraArgs],
    { encoding: "utf-8", timeout: 100_000, cwd: appRoot },
  );
  const output = ((result.stdout ?? "") + (result.stderr ?? "")).slice(-3000);
  return { ok: (result.status ?? 1) === 0, output };
}

export async function GET() {
  const appRoot = process.cwd().includes("/.next/standalone")
    ? "/app"
    : process.cwd();
  const dbPath = path.join(
    appRoot,
    "ml",
    "nba_spread",
    "data",
    "wc_signal_log.db",
  );

  const { signals, meta, injuries, candidates, actualPicks, footballAnalysis, propCards, propCardStats, candidateStats, error } = readWCData(dbPath, appRoot);

  const toTs = (raw: string | null) =>
    raw ? new Date(raw).toISOString().replace("T", " ").slice(0, 19) : null;

  // Job status from meta table
  const lastPollAt = toTs(meta["last_poll_at"] ?? null);
  const lastPollOk =
    meta["last_poll_ok"] == null ? null : meta["last_poll_ok"] === "1";
  const fetchMeta = {
    lastRunAt: toTs(
      meta["job:fetch_signals:last_run_at"] ??
        meta["last_poll_at"] ??
        null,
    ),
    lastError: meta["job:fetch_signals:last_error"] || null,
  };
  const gradeMeta = {
    lastRunAt: toTs(meta["job:grade_results:last_run_at"] ?? null),
    lastError: meta["job:grade_results:last_error"] || null,
  };
  // Players-sync job state (squad refresh + auto-chained priors compute).
  // Previously hidden, which is why a missing API_FOOTBALL_KEY surfaced as
  // "0 squads in the panel" with no error visible anywhere. Surface it.
  const playersSyncMeta = {
    lastRunAt: toTs(meta["job:players_sync:last_run_at"] ?? null),
    lastError: meta["job:players_sync:last_error"] || null,
  };
  const candidatesMeta = {
    lastRunAt: toTs(meta["job:candidates:last_run_at"] ?? null),
    lastError: meta["job:candidates:last_error"] || null,
  };
  const propCardsMeta = {
    lastRunAt: toTs(meta["job:prop_cards:last_run_at"] ?? null),
    lastError: meta["job:prop_cards:last_error"] || null,
    marketEventsChecked: Number(meta["job:prop_cards:market_events_checked"] ?? 0),
    pricedCards: Number(meta["job:prop_cards:priced_cards"] ?? 0),
  };
  const livePipelineMeta = {
    lastRunAt: toTs(meta["job:soccer_live_pipeline:last_run_at"] ?? null),
    lastError: meta["job:soccer_live_pipeline:last_error"] || null,
    mapped: Number(meta["job:soccer_live_pipeline:last_mapped"] ?? 0),
    synced: Number(meta["job:soccer_live_pipeline:last_synced"] ?? 0),
    cards: Number(meta["job:soccer_live_pipeline:last_cards"] ?? 0),
    priced: Number(meta["job:soccer_live_pipeline:last_priced"] ?? 0),
  };
  const sportmonksInventoryMeta = {
    lastRunAt: toTs(meta["job:sportmonks_inventory:last_run_at"] ?? null),
    lastError: meta["job:sportmonks_inventory:last_error"] || null,
  };

  // Performance stats
  const graded  = signals.filter((s) => s.status === "graded");
  const open    = signals.filter((s) => s.status === "open");
  const wins    = graded.filter((s) => s.correct === 1).length;
  const losses  = graded.length - wins;
  const payout  = 100 / 110;
  const winRate = graded.length > 0 ? wins / graded.length : null;
  const roi     = graded.length > 0
    ? (wins * payout + losses * -1) / graded.length
    : null;

  const h2hGraded  = graded.filter((s) => s.market === "h2h");
  const h2hWins    = h2hGraded.filter((s) => s.correct === 1).length;
  const totGraded  = graded.filter((s) => s.market === "totals");
  const totWins    = totGraded.filter((s) => s.correct === 1).length;

  // Quick schema-presence check — surfaces in ops so we can see if the
  // pick-quality columns are live without spelunking SQLite directly.
  const hasPickFields = signals.length > 0
    ? "confidence_tier" in (signals[0] as unknown as Record<string, unknown>)
    : null;

  return NextResponse.json({
    worker: { lastPollAt, lastPollOk },
    jobs: { fetch: fetchMeta, grade: gradeMeta, playersSync: playersSyncMeta, candidates: candidatesMeta, propCards: propCardsMeta, livePipeline: livePipelineMeta, sportmonksInventory: sportmonksInventoryMeta },
    signals,
    candidates,
    actualPicks,
    footballAnalysis,
    propCards,
    propCardStats,
    candidateStats,
    stats: {
      total: signals.length,
      open: open.length,
      graded: graded.length,
      wins,
      losses,
      winRate,
      roi,
      h2h:    { graded: h2hGraded.length,  wins: h2hWins },
      totals: { graded: totGraded.length,   wins: totWins },
    },
    schema: { hasPickFields, migrationRunAt: meta["schema:last_migration_at"] ?? null },
    injuries: injuries ?? [],
    refreshedAt: new Date().toISOString(),
    ...(error ? { error } : {}),
  });
}

export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const id = Number(body?.id);
  const status = String(body?.status ?? "");
  const notes = body?.notes == null ? null : String(body.notes);
  const allowed = new Set(["candidate", "watching", "approved", "rejected", "expired", "graded"]);

  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ ok: false, error: "Invalid candidate id" }, { status: 400 });
  }
  if (!allowed.has(status)) {
    return NextResponse.json({ ok: false, error: "Invalid status" }, { status: 400 });
  }

  const appRoot = process.cwd().includes("/.next/standalone")
    ? "/app"
    : process.cwd();
  const dbPath = path.join(appRoot, "ml", "nba_spread", "data", "wc_signal_log.db");
  const result = updateCandidate(dbPath, appRoot, id, status, notes);
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}

export async function POST(req: NextRequest) {
  const body   = await req.json().catch(() => ({}));
  const job    = body?.job ?? "fetch_signals";
  const appRoot = process.cwd().includes("/.next/standalone")
    ? "/app"
    : process.cwd();

  const results: Record<string, { ok: boolean; output: string }> = {};

  if (job === "grade_results" || job === "both") {
    results.grade = runJob("ml.world_cup.grade_results", ["--days", "3"], appRoot);
  }
  if (job === "fetch_signals" || job === "both") {
    results.fetch = runJob("ml.world_cup.fetch_signals", [], appRoot);
  }
  if (job === "candidates" || job === "both") {
    results.candidates = runJob("ml.soccer.candidates", ["scan"], appRoot);
  }
  if (job === "grade_candidates" || job === "both") {
    results.gradeCandidates = runJob("ml.soccer.candidates", ["grade"], appRoot);
  }
  if (job === "grade_prop_cards" || job === "both") {
    results.gradePropCards = runJob("ml.soccer.live_state", ["grade-props"], appRoot);
  }
  if (job === "prop_cards" || job === "both") {
    results.propCards = runJob("ml.soccer.prop_cards", ["scan"], appRoot);
  }
  if (job === "prop_market_scan") {
    const maxEvents = Math.max(1, Math.min(Number(body?.maxMarketEvents ?? 4), 12));
    results.propMarketScan = runJob("ml.soccer.prop_cards", ["scan", "--with-market", "--max-market-events", String(maxEvents)], appRoot);
  }
  if (job === "soccer_live_pipeline") {
    const maxEvents = Math.max(1, Math.min(Number(body?.maxMarketEvents ?? 4), 12));
    results.soccerLivePipeline = runJob("ml.soccer.live_pipeline", ["--horizon-hours", "168", "--max-market-events", String(maxEvents)], appRoot);
  }
  if (job === "sportmonks_inventory") {
    results.sportmonksInventory = runJob("ml.soccer.sportmonks_inventory", [], appRoot);
  }

  const allOk = Object.values(results).every((r) => r.ok);
  return NextResponse.json({ ok: allOk, results });
}
