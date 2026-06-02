/**
 * /api/ops/soccer/friendlies — international-friendly candidates (F2).
 *
 * Surfaces this week's international-friendly pick candidates (WC-team
 * warmups) sourced from Sportmonks, since the US-only Odds API doesn't
 * carry them. Read-token gated through /api/ops middleware.
 *
 * These are EXPERIMENTAL / dress-rehearsal candidates — built from
 * Sportmonks' model vs the de-vigged consensus, NOT ACE's validated
 * model (which doesn't cover national teams). The UI must label them
 * accordingly; never present as proven ACE picks.
 *
 * ?days=N  window size (default 5).
 */
import { NextRequest, NextResponse } from "next/server";
import { spawnSync } from "child_process";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const days = parseInt(req.nextUrl.searchParams.get("days") || "5", 10);
  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();

  const script = `
import json, sys
from ml.soccer.friendlies import scan_friendlies
try:
    res = scan_friendlies(days=${Number.isFinite(days) ? days : 5})
    print(json.dumps({"ok": True, **res}, default=str))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)[:300]})); sys.exit(1)
`;

  const start = Date.now();
  const r = spawnSync("python3", ["-c", script], {
    encoding: "utf-8",
    timeout: 60_000,        // scanning ~80 fixtures × 1 call each
    cwd: appRoot,
  });
  const durationSec = Math.round((Date.now() - start) / 1000);

  try {
    return NextResponse.json({ ...JSON.parse(r.stdout), durationSec });
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: "friendlies subprocess failed",
        durationSec,
        stderr_tail: (r.stderr ?? "").slice(-500),
      },
      { status: 500 },
    );
  }
}
