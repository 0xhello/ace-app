/**
 * /api/picks/history — public subscriber-facing pick history.
 *
 * Returns the most recent approved picks (from soccer_approved_picks)
 * with status, P&L, CLV — the receipt strip that earns trust with
 * subscribers. Picks marked "open" included so subscribers can see
 * what's currently live; settled picks dominate the rest of the list.
 *
 * Public, cached: max-age 60s / s-maxage 120s. The rows change only
 * when picks settle.
 */
import { NextResponse } from "next/server";
import { spawnSync } from "child_process";

export const dynamic = "force-dynamic";

interface HistoryEntry {
  id: number;
  fixture_label: string;
  tournament: string;
  commence_time: string | null;
  market: string;
  side: string;
  bet_label: string;
  stake_units: number;
  opening_price: number;
  opening_book: string;
  closing_price: number | null;
  closing_book: string | null;
  clv_pp: number | null;
  graded_status: string;
  pnl_units: number | null;
  approved_at: string;
  graded_at: string | null;
}

interface HistoryResponse {
  picks: HistoryEntry[];
  summary: {
    total: number;
    open: number;
    graded: number;
    wins: number;
    losses: number;
    pushes: number;
    win_rate: number | null;
    pnl_units: number;
    staked_units: number;
    roi: number | null;
    avg_clv_pp: number | null;
    clv_sample: number;
  };
  refreshed_at: string;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(50, parseInt(url.searchParams.get("limit") || "10", 10));
  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();

  const script = `
import json, sys
from ml.soccer.approved_picks import list_approved_picks, summary_stats
try:
    picks = list_approved_picks(limit=${Number.isFinite(limit) ? limit : 10})
    summary = summary_stats()
    print(json.dumps({"picks": picks, "summary": summary}, default=str))
except Exception as e:
    print(json.dumps({"picks": [], "summary": {}, "error": str(e)[:300]}))
`;
  const r = spawnSync("python3", ["-c", script], {
    encoding: "utf-8",
    timeout: 10_000,
    cwd: appRoot,
  });
  let parsed: { picks?: HistoryEntry[]; summary?: HistoryResponse["summary"] } = {};
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return NextResponse.json(
      { picks: [], summary: emptySummary(), refreshed_at: new Date().toISOString(), error: "parse failed" },
      { status: 500 },
    );
  }
  const payload: HistoryResponse = {
    picks: parsed.picks ?? [],
    summary: parsed.summary ?? emptySummary(),
    refreshed_at: new Date().toISOString(),
  };
  return NextResponse.json(payload, {
    headers: { "Cache-Control": "public, max-age=60, s-maxage=120, stale-while-revalidate=300" },
  });
}

function emptySummary(): HistoryResponse["summary"] {
  return {
    total: 0, open: 0, graded: 0,
    wins: 0, losses: 0, pushes: 0,
    win_rate: null,
    pnl_units: 0, staked_units: 0,
    roi: null,
    avg_clv_pp: null, clv_sample: 0,
  };
}
