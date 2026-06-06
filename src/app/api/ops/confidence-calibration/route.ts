import { NextResponse } from "next/server";
import { spawnSync } from "child_process";

export const dynamic = "force-dynamic";

export async function GET() {
  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
  const script = `
import json, sys
from ml.ops.confidence_calibration import build_calibration, load_all_calibration_picks
try:
    calibration = build_calibration(load_all_calibration_picks())
    print(json.dumps({"ok": True, "calibration": calibration}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)[:500]}))
    sys.exit(1)
`;

  const result = spawnSync("python3", ["-c", script], {
    cwd: appRoot,
    encoding: "utf-8",
    timeout: 10_000,
  });

  const raw = (result.stdout ?? "").trim().split("\n").pop() ?? "";
  try {
    const parsed = JSON.parse(raw);
    return NextResponse.json(parsed, { status: parsed.ok ? 200 : 500 });
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: "confidence calibration subprocess failed to return JSON",
        stderr: (result.stderr ?? "").slice(-1000),
      },
      { status: 500 },
    );
  }
}
