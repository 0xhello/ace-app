/**
 * /api/ops/soccer/sync-friendly-intel — data-only international-friendly rehearsal lane.
 *
 * Thin ops wrapper around ml.soccer.friendly_intel. This route parses request
 * limits and delegates domain work to the Python service layer. It does NOT
 * generate or approve picks.
 */
import { NextRequest, NextResponse } from "next/server";
import { spawnSync } from "child_process";

export const dynamic = "force-dynamic";

function boundedInt(value: string | null, fallback: number, min: number, max: number): number {
  const raw = Number(value ?? fallback);
  return Number.isFinite(raw) ? Math.max(min, Math.min(max, Math.floor(raw))) : fallback;
}

export async function GET(req: NextRequest) {
  const days = boundedInt(req.nextUrl.searchParams.get("days"), 7, 1, 21);
  const limit = boundedInt(req.nextUrl.searchParams.get("limit"), 8, 1, 24);
  const shouldSync = req.nextUrl.searchParams.get("sync") === "true";
  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();

  const script = `
import json, sys
from ml.soccer.friendly_intel import sync_friendly_intel
try:
    print(json.dumps(sync_friendly_intel(days=${days}, limit=${limit}, sync=${shouldSync ? "True" : "False"}), ensure_ascii=False, default=str))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)[:400]})); sys.exit(1)
`;

  const start = Date.now();
  const result = spawnSync("python3", ["-c", script], {
    cwd: appRoot,
    encoding: "utf-8",
    timeout: shouldSync ? 180_000 : 45_000,
  });
  const durationSec = Math.round((Date.now() - start) / 1000);

  try {
    return NextResponse.json({ ...JSON.parse(result.stdout), durationSec, exitCode: result.status ?? -1 });
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: "sync-friendly-intel subprocess failed to return JSON",
        durationSec,
        exitCode: result.status ?? -1,
        stderr_tail: (result.stderr ?? "").slice(-800),
        stdout_tail: (result.stdout ?? "").slice(-800),
      },
      { status: 500 },
    );
  }
}
