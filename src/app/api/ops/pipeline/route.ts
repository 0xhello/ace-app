import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import { spawnSync } from "child_process";
import path from "path";

export const dynamic = "force-dynamic";

interface JobStatus {
  lastRunAt: string | null;
  quotaRemaining: number | null;
  hasError: boolean;
  errorSnippet: string | null;
  truncated: boolean;
}

function parseLog(content: string): JobStatus {
  if (!content.trim()) {
    return { lastRunAt: null, quotaRemaining: null, hasError: false, errorSnippet: null, truncated: false };
  }

  const timestamps = [...content.matchAll(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/g)];
  const quotas = [...content.matchAll(/\[quota\]\s+\d+\s+used\s*\/\s*(\d+)\s+remaining/g)];

  const lastTs = timestamps[timestamps.length - 1];
  const lastQuota = quotas[quotas.length - 1];

  const lastRunAt = lastTs ? lastTs[1] : null;
  const quotaRemaining = lastQuota ? parseInt(lastQuota[1]) : null;

  // Only flag errors that appear after the last run timestamp
  const afterLastTs = lastTs && lastTs.index !== undefined ? content.slice(lastTs.index) : content;
  const errorMatch = afterLastTs.match(/ERROR:(.+)/);
  const hasError = !!errorMatch;
  const errorSnippet = errorMatch ? errorMatch[1].trim().slice(0, 120) : null;

  // Truncation: fewer than 5 non-empty lines after the last timestamp suggests a crash mid-run
  const linesAfter = afterLastTs.split("\n").filter((l) => l.trim()).length;
  const truncated = linesAfter < 5 && timestamps.length > 0;

  return { lastRunAt, quotaRemaining, hasError, errorSnippet, truncated };
}

async function readLogWithMtime(filePath: string): Promise<{ content: string; mtimeMs: number }> {
  try {
    const [content, stat] = await Promise.all([fs.readFile(filePath, "utf-8"), fs.stat(filePath)]);
    return { content, mtimeMs: stat.mtimeMs };
  } catch {
    return { content: "", mtimeMs: 0 };
  }
}

function mtimeToTs(ms: number): string | null {
  if (!ms) return null;
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

interface CsvRow {
  logged_at: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  home_line: string;
  pick_side: string;
  result_status: string;
  correct: string;
  pick_confidence: string;
  is_bet: string;
  edge_vs_pinnacle: string;
  game_id: string;
  model_version: string;
}

function parseCsv(text: string): CsvRow[] {
  const lines = text.trim().split("\n").filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const vals = line.split(",");
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = (vals[i] ?? "").trim(); });
    return row as unknown as CsvRow;
  });
}

interface WorkerMeta {
  lastPollAt: string | null;
  lastPollOk: boolean | null;
  jobMeta: Record<string, { lastRunAt: string | null; lastError: string | null }>;
}

function readWorkerMeta(dbPath: string): WorkerMeta {
  const script = `
import sqlite3, json
try:
    conn = sqlite3.connect(${JSON.stringify(dbPath)})
    rows = conn.execute("SELECT key, value FROM meta").fetchall()
    conn.close()
    print(json.dumps({r[0]: r[1] for r in rows}))
except Exception as e:
    print(json.dumps({}))
`;
  const result = spawnSync("python3", ["-c", script], { encoding: "utf-8", timeout: 5_000 });
  const toTs = (raw: string | null) =>
    raw ? new Date(raw).toISOString().replace("T", " ").slice(0, 19) : null;
  try {
    const d: Record<string, string> = JSON.parse(result.stdout) ?? {};
    const jobMeta: WorkerMeta["jobMeta"] = {};
    for (const [key, val] of Object.entries(d)) {
      const m = key.match(/^job:(\w+):last_run_at$/);
      if (m) {
        const name = m[1];
        jobMeta[name] = {
          lastRunAt: toTs(val),
          lastError: d[`job:${name}:last_error`] || null,
        };
      }
    }
    return {
      lastPollAt: toTs(d["last_poll_at"] ?? null),
      lastPollOk: d["last_poll_ok"] == null ? null : d["last_poll_ok"] === "1",
      jobMeta,
    };
  } catch {
    return { lastPollAt: null, lastPollOk: null, jobMeta: {} };
  }
}

export async function GET() {
  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
  const logDir = path.join(appRoot, "ml", "logs");
  const csvPath = path.join(appRoot, "ml", "nba_spread", "data", "model_performance.csv");
  const dbPath  = path.join(appRoot, "ml", "nba_spread", "data", "signal_log.db");

  const segmentsPath   = path.join(appRoot, "ml", "nba_spread", "artifacts", "model_performance_segments.json");
  const archetypesPath = path.join(appRoot, "ml", "nba_spread", "artifacts", "team_archetypes.json");

  const [stateMeta, gradeMeta, fetchMeta, csvText, segmentsRaw, archetypesRaw] = await Promise.all([
    readLogWithMtime(path.join(logDir, "state.log")),
    readLogWithMtime(path.join(logDir, "grade.log")),
    readLogWithMtime(path.join(logDir, "fetch.log")),
    fs.readFile(csvPath, "utf-8").catch(() => ""),
    fs.readFile(segmentsPath, "utf-8").catch(() => ""),
    fs.readFile(archetypesPath, "utf-8").catch(() => ""),
  ]);

  const stateJob = parseLog(stateMeta.content);
  const gradeJob = parseLog(gradeMeta.content);
  const fetchJob = parseLog(fetchMeta.content);

  // state.log has no inline timestamp — use file mtime as fallback
  if (!stateJob.lastRunAt && stateMeta.mtimeMs) stateJob.lastRunAt = mtimeToTs(stateMeta.mtimeMs);

  // Worker daemon status from meta table
  const workerMeta = readWorkerMeta(dbPath);

  // When log files are empty (Railway: worker logs to stdout only), fall back to meta table
  const { jobMeta } = workerMeta;
  if (!gradeJob.lastRunAt && jobMeta.grade_results?.lastRunAt) {
    gradeJob.lastRunAt = jobMeta.grade_results.lastRunAt;
    if (jobMeta.grade_results.lastError) {
      gradeJob.hasError = true;
      gradeJob.errorSnippet = jobMeta.grade_results.lastError.slice(0, 120);
    }
  }
  if (!fetchJob.lastRunAt && jobMeta.fetch_and_predict?.lastRunAt) {
    fetchJob.lastRunAt = jobMeta.fetch_and_predict.lastRunAt;
    if (jobMeta.fetch_and_predict.lastError) {
      fetchJob.hasError = true;
      fetchJob.errorSnippet = jobMeta.fetch_and_predict.lastError.slice(0, 120);
    }
  }
  if (!stateJob.lastRunAt && jobMeta.update_team_state?.lastRunAt) {
    stateJob.lastRunAt = jobMeta.update_team_state.lastRunAt;
    if (jobMeta.update_team_state.lastError) {
      stateJob.hasError = true;
      stateJob.errorSnippet = jobMeta.update_team_state.lastError.slice(0, 120);
    }
  }

  const jobs = { state: stateJob, grade: gradeJob, fetch: fetchJob };

  // Latest quota from whichever log file was written most recently
  const jobsWithQuota = [
    { quota: fetchJob.quotaRemaining, mtime: fetchMeta.mtimeMs },
    { quota: gradeJob.quotaRemaining, mtime: gradeMeta.mtimeMs },
    { quota: stateJob.quotaRemaining, mtime: stateMeta.mtimeMs },
  ].filter((j): j is { quota: number; mtime: number } => j.quota !== null);
  jobsWithQuota.sort((a, b) => b.mtime - a.mtime);
  const latestQuota = jobsWithQuota[0]?.quota ?? null;

  const etToday = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  // Model stats from CSV
  const rows = parseCsv(csvText);
  // correct is stored as "1.0"/"0.0" (float) or "1"/"0" — normalise with parseFloat
  const isWin = (r: CsvRow) => parseFloat(r.correct) === 1;

  const graded = rows.filter((r) => r.result_status === "graded");
  const pending = rows.filter((r) => r.result_status === "pending");
  const pushed  = rows.filter((r) => r.result_status === "push");
  const wins    = graded.filter(isWin).length;
  const losses  = graded.length - wins;
  const payout  = 100 / 110;
  const winRate = graded.length > 0 ? wins / graded.length : null;
  const roi     = graded.length > 0 ? (wins * payout + losses * -1) / graded.length : null;

  const allBets    = rows.filter((r) => r.is_bet === "1");
  const betsGraded = graded.filter((r) => parseFloat(r.is_bet) === 1);
  const betsWins   = betsGraded.filter(isWin).length;
  const betsLosses = betsGraded.length - betsWins;
  const betsWinRate = betsGraded.length > 0 ? betsWins / betsGraded.length : null;
  const betsRoi    = betsGraded.length > 0 ? (betsWins * payout + betsLosses * -1) / betsGraded.length : null;

  // Pinnacle-backed (has edge_vs_pinnacle) vs fallback (no edge)
  const pinnacleGraded = graded.filter((r) => r.edge_vs_pinnacle && r.edge_vs_pinnacle !== "");
  const fallbackGraded = graded.filter((r) => !r.edge_vs_pinnacle || r.edge_vs_pinnacle === "");
  const pinnacleWins   = pinnacleGraded.filter(isWin).length;
  const fallbackWins   = fallbackGraded.filter(isWin).length;

  // Confidence buckets
  const BUCKETS = [
    { label: "≥0.65",     min: 0.65, max: 1.01 },
    { label: "0.58–0.65", min: 0.58, max: 0.65 },
    { label: "<0.58",     min: 0.0,  max: 0.58 },
  ];
  const buckets = BUCKETS.map(({ label, min, max }) => {
    const subset = graded.filter((r) => {
      const c = parseFloat(r.pick_confidence);
      return c >= min && c < max;
    });
    const w = subset.filter(isWin).length;
    return { label, graded: subset.length, wins: w, winRate: subset.length > 0 ? w / subset.length : null };
  });

  const confs = rows.map((r) => parseFloat(r.pick_confidence)).filter((c) => !isNaN(c));
  const avgConf = confs.length > 0 ? confs.reduce((a, b) => a + b, 0) / confs.length : null;

  const todayLogged = rows.filter((r) => r.logged_at.startsWith(etToday)).length;

  // Full picks log, most recent first
  const picks = rows.slice().reverse().map((r) => {
    const line = parseFloat(r.home_line);
    const conf = parseFloat(r.pick_confidence);
    const correct = r.correct ? parseFloat(r.correct) : null;
    const edge = r.edge_vs_pinnacle ? parseFloat(r.edge_vs_pinnacle) : null;
    return {
      date: r.commence_time ? r.commence_time.slice(0, 10) : r.logged_at.slice(0, 10),
      home: r.home_team,
      away: r.away_team,
      line: isNaN(line) ? null : line,
      side: r.pick_side,
      conf: isNaN(conf) ? null : conf,
      isBet: parseFloat(r.is_bet) === 1,
      status: r.result_status,
      correct: isNaN(correct as number) ? null : correct,
      edge: edge !== null && isNaN(edge) ? null : edge,
      version: r.model_version,
    };
  });

  return NextResponse.json({
    jobs,
    worker: workerMeta,
    latestQuota,
    model: {
      total: rows.length,
      graded: graded.length,
      pending: pending.length,
      pushed: pushed.length,
      wins,
      losses,
      winRate,
      roi,
      betsTotal: allBets.length,
      betsGraded: betsGraded.length,
      betsWins,
      betsLosses,
      betsWinRate,
      betsRoi,
      pinnacleGraded: pinnacleGraded.length,
      pinnacleWins,
      pinnacleWinRate: pinnacleGraded.length > 0 ? pinnacleWins / pinnacleGraded.length : null,
      fallbackGraded: fallbackGraded.length,
      fallbackWins,
      fallbackWinRate: fallbackGraded.length > 0 ? fallbackWins / fallbackGraded.length : null,
      avgConf,
      buckets,
      todayLogged,
    },
    picks,
    etToday,
    segments: segmentsRaw ? (() => { try { return JSON.parse(segmentsRaw); } catch { return null; } })() : null,
    archetypes: archetypesRaw ? (() => { try { return JSON.parse(archetypesRaw); } catch { return null; } })() : null,
    refreshedAt: new Date().toISOString(),
  });
}
