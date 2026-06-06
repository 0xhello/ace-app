/**
 * /api/ops/sportmonks/sync-slate — manual Sportmonks fixture-bundle sync.
 *
 * What this does
 * --------------
 * Discovers Big-5 + UCL + WC fixtures in a forward-looking window and
 * (re-)fetches each one's pre-match bundle (lineups + predictions +
 * post-match xGFixture) into ``soccer_sportmonks_fixture_cache``. The
 * downstream prop-card path (player_props.py) auto-uses cached lineups
 * to replace the legacy "assumed_minutes=74" heuristic — see M38.
 *
 * Why a manual trigger
 * --------------------
 * The worker tick eventually wires this in autonomously, but we want an
 * operator (or this codebase, via curl) to be able to refresh the cache
 * on-demand:
 *   - Right after deploy to pick up newly-published projected lineups
 *   - Before a marquee fixture (UCL final, WC opening match) to ensure
 *     we have the latest confirmed XI
 *   - For debugging: re-run with ?force=true to bust the refresh policy
 *
 * POST-only: this spends provider credits and mutates fixture-cache state,
 * so it must stay behind an admin session instead of the read-token GET path.
 *
 * Query params
 * ------------
 *   ?days=3          window size in days (default 3)
 *   ?force=true      bypass the refresh policy and re-fetch everything
 *   ?leagues=8,2     CSV of Sportmonks league_ids (default Big-5 + UCL + WC)
 *
 * Budget
 * ------
 * Worst case: ~50 Sportmonks credits per call (full Big-5 + UCL slate
 * over 3 days). Idempotent.
 */
import { NextRequest, NextResponse } from "next/server";
import { spawnSync } from "child_process";

export const dynamic = "force-dynamic";

async function runSync(req: NextRequest) {
  const days = parseInt(req.nextUrl.searchParams.get("days") || "3", 10);
  const force = req.nextUrl.searchParams.get("force") === "true";
  const leaguesParam = req.nextUrl.searchParams.get("leagues")?.trim();
  const leaguesExpr = leaguesParam
    ? `[${leaguesParam.split(",")
        .map((s) => parseInt(s, 10))
        .filter((n) => Number.isFinite(n))
        .join(",")}]`
    : "None";

  if (!Number.isFinite(days) || days < 1 || days > 14) {
    return NextResponse.json(
      { ok: false, error: "days must be an integer in [1, 14]" },
      { status: 400 },
    );
  }

  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();

  // Sized for the worst case (~50 fixtures × ~1.5s/call with auth + JSON).
  // The python loop sleeps ~150ms between calls to stay under Sportmonks
  // rate limits.
  const timeoutMs = 180_000;

  const script = `
import json, sys
from ml.soccer.sportmonks_fixture import sync_slate
try:
    summary = sync_slate(days=${days}, league_ids=${leaguesExpr}, force=${force ? "True" : "False"})
    print(json.dumps({"ok": True, "summary": summary}, default=str))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)[:400]})); sys.exit(1)
`;

  const start = Date.now();
  const result = spawnSync("python3", ["-c", script], {
    encoding: "utf-8",
    timeout: timeoutMs,
    cwd: appRoot,
  });
  const durationSec = Math.round((Date.now() - start) / 1000);

  try {
    const parsed = JSON.parse(result.stdout);
    return NextResponse.json({
      ...parsed,
      durationSec,
      exitCode: result.status ?? -1,
    });
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: "sync-slate subprocess failed to return JSON",
        durationSec,
        exitCode: result.status ?? -1,
        stderr_tail: (result.stderr ?? "").slice(-600),
        stdout_tail: (result.stdout ?? "").slice(-400),
      },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  return runSync(req);
}

export async function GET() {
  return NextResponse.json(
    { ok: false, error: "sync-slate mutates cache state and must be called with POST by an admin session" },
    { status: 405, headers: { Allow: "POST" } },
  );
}
