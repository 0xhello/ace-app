/**
 * /api/ops/wc-squad-sync — one-shot WC squad + club form sync.
 *
 * Fires `python3 -m ml.world_cup.players sync_all` on the prod container,
 * which:
 *   - Discovers each WC qualifier's national-team id via /teams?country=X
 *     (~48 API-Football calls, free-tier workaround)
 *   - Pulls each team's squad via /players/squads (~48 calls)
 *   - Pulls top-scorer + top-assist stats from 10 club leagues × 2 seasons
 *     (~40 calls)
 *   - Pulls intl tournament top-scorers (~12 calls)
 *
 * Total budget: ~150 API-Football calls. Free tier is 100/day, paid is
 * much higher — keep an eye on it. The script will silently degrade if
 * quota is hit (logs to stderr, partial population is fine).
 *
 * Idempotent: re-running upserts. Squads + form refresh in place.
 *
 * Each sub-step has its own timeout. The HTTP request itself may finish
 * before the subprocess does, but Node's spawnSync runs the full job
 * on the container regardless of client timeout. Re-run anytime.
 *
 * Auth: gated by /api/ops/* middleware.
 */
import { NextRequest, NextResponse } from "next/server";
import { spawnSync } from "child_process";
import path from "path";

export const dynamic = "force-dynamic";

type Step = "squads" | "form" | "intl" | "all" | "priors" | "status";

const STEP_CMDS: Record<Step, string[]> = {
  squads:   ["-m", "ml.world_cup.players", "sync_squads"],
  form:     ["-m", "ml.world_cup.players", "sync_form"],
  intl:     ["-m", "ml.world_cup.players", "sync_intl"],
  all:      ["-m", "ml.world_cup.players", "sync_all"],
  priors:   ["-m", "ml.world_cup.players", "priors"],
  status:   ["-m", "ml.world_cup.players", "status"],
};

interface StepResult {
  ok: boolean;
  durationSec: number;
  exitCode: number;
  output: string;
}

function isValidStep(s: unknown): s is Step {
  return typeof s === "string" && s in STEP_CMDS;
}

function runPython(args: string[], timeoutMs: number, appRoot: string): StepResult {
  const start = Date.now();
  const result = spawnSync("python3", args, {
    encoding: "utf-8",
    timeout: timeoutMs,
    cwd: appRoot,
  });
  const durationSec = Math.round((Date.now() - start) / 1000);
  const output = ((result.stdout ?? "") + (result.stderr ?? "")).slice(-8000);
  return {
    ok: (result.status ?? 1) === 0,
    durationSec,
    exitCode: result.status ?? -1,
    output,
  };
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const step = body?.step;

  if (!isValidStep(step)) {
    return NextResponse.json(
      {
        ok: false,
        error: `Invalid 'step'. Allowed: ${Object.keys(STEP_CMDS).join(", ")}`,
      },
      { status: 400 },
    );
  }

  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();

  // Per-step timeouts — squad discovery + sync is the slowest (~48 + 32 calls).
  // status/priors/intl finish in seconds; squads+form can take 2-3 min.
  const timeoutMs =
    step === "all"     ? 280_000 :
    step === "squads"  ? 200_000 :
    step === "form"    ? 200_000 :
    step === "intl"    ?  60_000 :
    step === "priors"  ?  60_000 :
                          30_000;

  const r = runPython(STEP_CMDS[step], timeoutMs, appRoot);
  return NextResponse.json({ step, ...r });
}

export async function GET() {
  return NextResponse.json({
    description: "POST {step} to run a WC player-context step",
    steps: [
      "squads   — pull 32+ WC team rosters (~48 API-Football calls via country-discovery)",
      "form     — pull club top-scorer/assist stats from major leagues (~40 calls × 2 seasons)",
      "intl     — pull recent intl tournament top-scorers (~12 calls)",
      "all      — squads + form + intl in sequence (~150 calls total)",
      "priors   — compute goalscorer priors for all cached players (no API calls)",
      "status   — print player/form/prior row counts (no API calls)",
    ],
  });
}
