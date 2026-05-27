/**
 * /api/ops/wc-force-refresh — manually re-runs the Sportmonks WC bootstrap.
 *
 * Why this exists
 * ---------------
 * The worker's boot bootstrap is idempotent: it skips when wc_players AND
 * wc_player_form are already populated. That's correct steady-state behavior
 * but makes deploys that improve the COMPUTE side (e.g. M14's name-alias
 * expansion and per-player stats enrichment) invisible until the next 7:30am
 * ET scheduled refresh — up to 24 hours out.
 *
 * This endpoint lets an operator (or this codebase, via curl with the
 * OPS_READ_TOKEN) force a re-sync now:
 *   GET /api/ops/wc-force-refresh?step=all   ← squads + form + enrich + priors
 *   GET /api/ops/wc-force-refresh?step=form  ← form + enrich + priors only
 *   GET /api/ops/wc-force-refresh?step=priors ← compute_all_priors only
 *
 * GET-only by design so it goes through the middleware's read-token gate
 * (POST would require an admin session). Read token must be present.
 *
 * Idempotent: every underlying sync uses ON CONFLICT UPDATE — re-running
 * refreshes data, never duplicates it.
 */
import { NextRequest, NextResponse } from "next/server";
import { spawnSync } from "child_process";
import path from "path";

export const dynamic = "force-dynamic";

type Step = "all" | "form" | "priors";

interface StepResult {
  ok: boolean;
  durationSec: number;
  exitCode: number;
  output: string;
  stderr_tail?: string;
}

function runPython(args: string[], timeoutMs: number, appRoot: string): StepResult {
  const start = Date.now();
  const result = spawnSync("python3", args, {
    encoding: "utf-8",
    timeout: timeoutMs,
    cwd: appRoot,
  });
  const durationSec = Math.round((Date.now() - start) / 1000);
  return {
    ok: (result.status ?? -1) === 0,
    durationSec,
    exitCode: result.status ?? -1,
    output: (result.stdout ?? "").slice(-4000),
    stderr_tail: (result.stderr ?? "").slice(-800) || undefined,
  };
}

export async function GET(req: NextRequest) {
  const stepParam = req.nextUrl.searchParams.get("step") ?? "all";
  const validSteps: Step[] = ["all", "form", "priors"];
  if (!validSteps.includes(stepParam as Step)) {
    return NextResponse.json(
      {
        ok: false,
        error: `Invalid 'step'. Allowed: ${validSteps.join(", ")}`,
      },
      { status: 400 },
    );
  }
  const step = stepParam as Step;

  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();

  // The Python entry points are CLIs on the existing modules. squads and
  // form modules both auto-chain priors via their CLI wrappers — well, they
  // don't currently — so we explicitly chain priors after sync via the
  // worker's helper. Cleanest path: use a small inline -c script that
  // imports + sequences. Timeout sized for the slowest path (form sync +
  // ~125 player stats fetches + priors compute ≈ 90s on a fresh DB).
  const timeoutMs = step === "priors" ? 60_000 : 240_000;

  let script = "";
  if (step === "priors") {
    // Just recompute priors from existing wc_players + wc_player_form data.
    // Useful after a code-only change (e.g. M14's name-alias expansion)
    // when the data is already current but the compute needs to re-run.
    script = `
import json, sys
from ml.world_cup.players import compute_all_priors
try:
    n = compute_all_priors()
    print(json.dumps({"ok": True, "priors_written": n}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)[:300]}))
    sys.exit(1)
`;
  } else if (step === "form") {
    script = `
import json, sys
from ml.world_cup.sportmonks_form import sync_topscorers_for_all_leagues
from ml.world_cup.players import compute_all_priors
try:
    summary = sync_topscorers_for_all_leagues(enrich_stats=True)
    priors_n = compute_all_priors()
    print(json.dumps({
        "ok": True,
        "form_rows":       summary.get("rows_written", 0),
        "enrichment":      summary.get("enrichment", {}),
        "priors_written":  priors_n,
    }))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)[:300]}))
    sys.exit(1)
`;
  } else {
    // "all" — full chain (squads + form + enrich + priors)
    script = `
import json, sys
from ml.world_cup.sportmonks_squads import sync_wc_2026_squads
from ml.world_cup.sportmonks_form import sync_topscorers_for_all_leagues
from ml.world_cup.players import compute_all_priors
try:
    sq = sync_wc_2026_squads()
    form = sync_topscorers_for_all_leagues(enrich_stats=True)
    priors_n = compute_all_priors()
    print(json.dumps({
        "ok": True,
        "squad_players":   sq.get("players_synced", 0),
        "form_rows":       form.get("rows_written", 0),
        "enrichment":      form.get("enrichment", {}),
        "priors_written":  priors_n,
    }))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)[:300]}))
    sys.exit(1)
`;
  }

  const r = runPython(["-c", script], timeoutMs, appRoot);
  // Try to parse the script's own JSON line out of stdout so the caller sees
  // a structured summary, not the raw text.
  let parsedSummary: Record<string, unknown> = {};
  try {
    const lastLine = r.output.trim().split("\n").pop() ?? "";
    parsedSummary = JSON.parse(lastLine);
  } catch {
    parsedSummary = { ok: false, parseFailed: true };
  }
  return NextResponse.json({
    step,
    runner: r,
    summary: parsedSummary,
  });
}
