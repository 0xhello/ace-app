/**
 * /api/ops/explain — turn a signal id into a "why this pick" explanation.
 *
 * The differentiator. Competitors give you the edge number. We give you
 * the rationale — using the StatsBomb historical g/90, club form, intl
 * tournament uplift, and live divergence math.
 *
 * Query: ?signal_id=N  (required, integer)
 * Returns: { headline, why, caveat }
 *
 * Auth: same /api/ops/* gate as everything else. Read-only via
 * OPS_READ_TOKEN works too.
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

function explainSignal(dbPath: string, signalId: number): ExplainResponse {
  const script = `
import json, sys
from pathlib import Path
try:
    # Patch DB_PATH so explain_from_db reads the right file
    from ml.world_cup import signal_logger
    signal_logger.DB_PATH = Path(${JSON.stringify(dbPath)})
    from ml.world_cup.pick_explainer import explain_from_db
    out = explain_from_db(${signalId})
    print(json.dumps(out))
except Exception as e:
    print(json.dumps({"headline": "Error", "why": "", "caveat": "", "error": str(e)}))
`;
  const r = spawnSync("python3", ["-c", script], { encoding: "utf-8", timeout: 8_000 });
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
  return NextResponse.json(explainSignal(dbPath, id));
}
