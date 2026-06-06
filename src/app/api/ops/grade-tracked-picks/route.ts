import { NextRequest, NextResponse } from "next/server";
import { spawnSync } from "child_process";
import path from "path";

export const dynamic = "force-dynamic";

function runGrade(appRoot: string, apply: boolean) {
  const dbPath = path.join(appRoot, "ml", "nba_spread", "data", "tracked_picks.db");
  const script = `
import json, sys
from pathlib import Path
from ml.ops.grade_tracked_picks import reconcile
try:
    print(json.dumps(reconcile(Path(${JSON.stringify(dbPath)}), apply=${apply ? "True" : "False"}), default=str))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)[:500]})); sys.exit(1)
`;
  const result = spawnSync("python3", ["-c", script], {
    cwd: appRoot,
    encoding: "utf-8",
    timeout: 45_000,
  });

  try {
    return { parsed: JSON.parse(result.stdout), status: result.status ?? 0, stderr: result.stderr ?? "" };
  } catch {
    return {
      parsed: {
        ok: false,
        error: "grade-tracked-picks subprocess failed to return JSON",
        exitCode: result.status ?? -1,
        stderr_tail: (result.stderr ?? "").slice(-600),
        stdout_tail: (result.stdout ?? "").slice(-400),
      },
      status: result.status ?? 1,
      stderr: result.stderr ?? "",
    };
  }
}

export async function GET() {
  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
  const { parsed } = runGrade(appRoot, false);
  return NextResponse.json(parsed, { status: parsed.ok === false ? 500 : 200 });
}

export async function POST(req: NextRequest) {
  let apply = true;
  try {
    const body = await req.json();
    if (body && typeof body.apply === "boolean") apply = body.apply;
  } catch {
    // Empty body is fine; POST defaults to applying grading.
  }
  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
  const { parsed } = runGrade(appRoot, apply);
  return NextResponse.json(parsed, { status: parsed.ok === false ? 500 : 200 });
}
