import { NextResponse } from "next/server";
import { promises as fs } from "fs";
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
  result_status: string;
  correct: string;
  pick_confidence: string;
  is_bet: string;
  edge_vs_pinnacle: string;
  game_id: string;
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

export async function GET() {
  const logDir = path.join(process.cwd(), "ml", "logs");
  const csvPath = path.join(process.cwd(), "ml", "nba_spread", "model_performance.csv");

  const [stateMeta, gradeMeta, fetchMeta, snapshotMeta, csvText] = await Promise.all([
    readLogWithMtime(path.join(logDir, "state.log")),
    readLogWithMtime(path.join(logDir, "grade.log")),
    readLogWithMtime(path.join(logDir, "fetch.log")),
    readLogWithMtime(path.join(logDir, "snapshot.log")),
    fs.readFile(csvPath, "utf-8").catch(() => ""),
  ]);

  const stateJob    = parseLog(stateMeta.content);
  const gradeJob    = parseLog(gradeMeta.content);
  const fetchJob    = parseLog(fetchMeta.content);
  const snapshotJob = parseLog(snapshotMeta.content);

  // state.log has no inline timestamp — use file mtime as fallback
  if (!stateJob.lastRunAt && stateMeta.mtimeMs) stateJob.lastRunAt = mtimeToTs(stateMeta.mtimeMs);

  const jobs = { state: stateJob, grade: gradeJob, fetch: fetchJob, snapshot: snapshotJob };

  // Latest quota = from the job whose log was modified most recently AND has a quota reading
  const jobsWithQuota = [
    { quota: snapshotJob.quotaRemaining, mtime: snapshotMeta.mtimeMs },
    { quota: fetchJob.quotaRemaining,    mtime: fetchMeta.mtimeMs },
    { quota: gradeJob.quotaRemaining,    mtime: gradeMeta.mtimeMs },
    { quota: stateJob.quotaRemaining,    mtime: stateMeta.mtimeMs },
  ].filter((j): j is { quota: number; mtime: number } => j.quota !== null);
  jobsWithQuota.sort((a, b) => b.mtime - a.mtime);
  const latestQuota = jobsWithQuota[0]?.quota ?? null;

  // ET today (UTC-5 conservative)
  const etToday = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);

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

  return NextResponse.json({
    jobs,
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
    etToday,
    refreshedAt: new Date().toISOString(),
  });
}
