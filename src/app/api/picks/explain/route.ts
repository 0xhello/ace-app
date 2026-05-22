/**
 * /api/picks/explain — subscriber-facing pick explainer.
 *
 * Same template-based explainer as /api/ops/explain (which is admin-gated
 * via OPS_READ_TOKEN / admin session), but exposed here without auth so
 * subscribers can read the "why this pick" rationale on the dashboard.
 *
 * The explainer is the differentiator — historical g/90, club form,
 * intl uplift, Pinnacle de-vig divergence — and hiding it behind auth
 * defeats the marketing pitch. Public read is fine: it doesn't reveal
 * any signal beyond what the corresponding pick already exposes, and
 * pick metadata itself is gated separately for unauth users on
 * /api/performance/public.
 *
 * Query:   ?signal_id=N
 * Returns: { headline, why, caveat }
 *
 * 24-hour CDN cache header — the underlying explainer output is
 * deterministic for a given signal_id (no time-varying joins).
 */
import { NextRequest, NextResponse } from "next/server";
import { spawnSync } from "child_process";
import path from "path";

export const dynamic = "force-dynamic";

interface ExplainResponse {
  headline: string;
  why: string;
  caveat: string;
  error?: string;
}

function explain(appRoot: string, dbPath: string, signalId: number): ExplainResponse {
  const script = `
import json
from pathlib import Path
try:
    from ml.world_cup import signal_logger
    signal_logger.DB_PATH = Path(${JSON.stringify(dbPath)})
    from ml.world_cup.pick_explainer import explain_from_db
    out = explain_from_db(${signalId})
    print(json.dumps(out))
except Exception as e:
    print(json.dumps({"headline": "Error", "why": "", "caveat": "", "error": str(e)}))
`;
  const r = spawnSync("python3", ["-c", script], {
    encoding: "utf-8",
    timeout: 8_000,
    cwd: appRoot,
  });
  try {
    return JSON.parse(r.stdout) as ExplainResponse;
  } catch {
    return {
      headline: "Error",
      why: "",
      caveat: "",
      error: r.stderr?.slice(-200) || "parse_failed",
    };
  }
}

export async function GET(req: NextRequest) {
  const idRaw = req.nextUrl.searchParams.get("signal_id");
  const id = parseInt(idRaw || "0", 10);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json(
      { headline: "Invalid signal_id", why: "", caveat: "" },
      { status: 400 },
    );
  }
  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
  const dbPath = path.join(appRoot, "ml", "nba_spread", "data", "wc_signal_log.db");
  const out = explain(appRoot, dbPath, id);
  return NextResponse.json(out, {
    headers: {
      // Explainer is deterministic per signal_id — safe to cache aggressively.
      "Cache-Control": "public, max-age=600, s-maxage=86400, stale-while-revalidate=86400",
    },
  });
}
