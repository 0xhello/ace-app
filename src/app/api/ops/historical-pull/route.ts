/**
 * One-shot endpoint to run the StatsBomb historical pull on the prod
 * container. Admin-only (gated by middleware on /api/ops/*).
 *
 * The pull itself is offline batch work — it downloads from GitHub
 * (statsbomb/open-data) and writes to the shared SQLite volume that the
 * worker reads. No Odds API or API-Football credits are burned.
 *
 * Run one tournament at a time to stay under Railway's proxy timeout
 * (~5 min per HTTP request). Each tournament is idempotent (upserts), so
 * re-running a step that already completed is safe.
 *
 * Suggested order:
 *   POST {"step": "wc2018"}
 *   POST {"step": "wc2022"}
 *   POST {"step": "euro2020"}
 *   POST {"step": "euro2024"}
 *   POST {"step": "dedupe"}
 *   POST {"step": "status"}
 */
import { NextRequest, NextResponse } from "next/server";
import { spawnSync } from "child_process";
import path from "path";

export const dynamic = "force-dynamic";

interface TournamentSpec {
  comp: number;
  season: number;
  displayName: string;
}

const TOURNAMENTS: Record<string, TournamentSpec> = {
  wc2018:    { comp: 43, season: 3,   displayName: "WC 2018"   },
  wc2022:    { comp: 43, season: 106, displayName: "WC 2022"   },
  euro2020:  { comp: 55, season: 43,  displayName: "Euro 2020" },
  euro2024:  { comp: 55, season: 282, displayName: "Euro 2024" },
};

type ValidStep = keyof typeof TOURNAMENTS | "dedupe" | "status";

interface PyRunResult {
  ok: boolean;
  durationSec: number;
  exitCode: number;
  output: string;        // last 8KB of stdout+stderr
}

function runPython(args: string[], timeoutMs: number, appRoot: string): PyRunResult {
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

function isValidStep(s: unknown): s is ValidStep {
  if (typeof s !== "string") return false;
  return s in TOURNAMENTS || s === "dedupe" || s === "status";
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const step = body?.step;

  if (!isValidStep(step)) {
    return NextResponse.json(
      {
        ok: false,
        error: `Invalid 'step'. Allowed: ${Object.keys(TOURNAMENTS).join(", ")}, dedupe, status`,
      },
      { status: 400 },
    );
  }

  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();

  if (step === "dedupe") {
    const r = runPython(["-m", "ml.world_cup.historical", "dedupe"], 60_000, appRoot);
    return NextResponse.json({ step, ...r });
  }

  if (step === "status") {
    const r = runPython(["-m", "ml.world_cup.historical", "status"], 30_000, appRoot);
    return NextResponse.json({ step, ...r });
  }

  // Tournament pull — each finishes in 2-4 min on a warm GitHub CDN
  const t = TOURNAMENTS[step];
  const r = runPython(
    [
      "-m", "ml.world_cup.historical", "pull",
      "--comp", String(t.comp),
      "--season", String(t.season),
      "--name", t.displayName,
    ],
    280_000, // 4m40s — under Railway's 5-min proxy timeout
    appRoot,
  );
  return NextResponse.json({ step, tournament: t.displayName, ...r });
}

export async function GET() {
  return NextResponse.json({
    description: "POST {step} to run a StatsBomb historical pull step",
    steps: [
      ...Object.entries(TOURNAMENTS).map(([k, v]) => `${k} — pull ${v.displayName}`),
      "dedupe — collapse multi-variant player names",
      "status — print row/goal counts per tournament",
    ],
  });
}
