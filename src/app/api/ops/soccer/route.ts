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

interface WCData {
  signals: SoccerSignal[];
  meta: Record<string, string>;
  injuries: WCInjury[];
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
    db_path = Path(${JSON.stringify(dbPath)})
    init_db(db_path)
    init_context_tables(db_path)
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
    }))
except Exception as e:
    print(json.dumps({"signals": [], "meta": {}, "injuries": [], "error": str(e)}))
`;
  const result = spawnSync("python3", ["-c", script], {
    encoding: "utf-8",
    timeout: 5_000,
    cwd: appRoot,
  });
  try {
    return JSON.parse(result.stdout) as WCData;
  } catch {
    return { signals: [], meta: {}, injuries: [] };
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

  const { signals, meta, injuries, error } = readWCData(dbPath, appRoot);

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
    jobs: { fetch: fetchMeta, grade: gradeMeta, playersSync: playersSyncMeta },
    signals,
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

  const allOk = Object.values(results).every((r) => r.ok);
  return NextResponse.json({ ok: allOk, results });
}
