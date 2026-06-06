import { NextRequest, NextResponse } from "next/server";
import { spawnSync } from "child_process";
import path from "path";

export const dynamic = "force-dynamic";

function cleanString(value: unknown, max = 500): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function cleanNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function appRoot() {
  return process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
}

function runPython(script: string, timeout = 10_000) {
  const root = appRoot();
  const result = spawnSync("python3", ["-c", script], { cwd: root, encoding: "utf-8", timeout });
  try {
    return { parsed: JSON.parse(result.stdout), status: result.status ?? 0 };
  } catch {
    return {
      parsed: {
        ok: false,
        error: "parlay subprocess failed to return JSON",
        exitCode: result.status ?? -1,
        stderr_tail: (result.stderr ?? "").slice(-600),
        stdout_tail: (result.stdout ?? "").slice(-400),
      },
      status: result.status ?? 1,
    };
  }
}

export async function GET() {
  const root = appRoot();
  const dbPath = path.join(root, "ml", "nba_spread", "data", "tracked_picks.db");
  const script = `
import json, sys
from pathlib import Path
from ml.ops.tracked_picks import list_parlays
try:
    print(json.dumps({"ok": True, "parlays": list_parlays(Path(${JSON.stringify(dbPath)}))}, default=str))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)[:500]})); sys.exit(1)
`;
  const { parsed } = runPython(script);
  return NextResponse.json(parsed, { status: parsed.ok === false ? 500 : 200 });
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const payload = {
    pick_ids: Array.isArray(body.pick_ids) ? body.pick_ids.map((v) => Number(v)).filter(Number.isFinite) : [],
    label: cleanString(body.label, 180),
    stake_units: cleanNumber(body.stake_units) ?? 1,
    odds_american: cleanNumber(body.odds_american),
    notes: cleanString(body.notes, 1000),
    publish_state: cleanString(body.publish_state, 40) ?? "internal",
  };

  if (payload.pick_ids.length < 2 || !payload.label) {
    return NextResponse.json({ ok: false, error: "label and at least two pick_ids are required" }, { status: 400 });
  }

  const root = appRoot();
  const dbPath = path.join(root, "ml", "nba_spread", "data", "tracked_picks.db");
  const script = `
import json, sys
from pathlib import Path
from ml.ops.tracked_picks import add_operator_parlay
payload = ${JSON.stringify(payload)}
try:
    row = add_operator_parlay(target_db=Path(${JSON.stringify(dbPath)}), **payload)
    print(json.dumps({"ok": True, "parlay": row}, default=str))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)[:500]})); sys.exit(1)
`;
  const { parsed } = runPython(script);
  return NextResponse.json(parsed, { status: parsed.ok ? 201 : 400 });
}


export async function PATCH(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const payload = {
    parlay_id: cleanNumber(body.parlay_id),
    publish_state: cleanString(body.publish_state, 40) ?? "internal",
  };

  if (!payload.parlay_id) {
    return NextResponse.json({ ok: false, error: "parlay_id is required" }, { status: 400 });
  }

  const root = appRoot();
  const dbPath = path.join(root, "ml", "nba_spread", "data", "tracked_picks.db");
  const script = `
import json, sys
from pathlib import Path
from ml.ops.tracked_picks import update_parlay_publish_state
payload = ${JSON.stringify(payload)}
try:
    row = update_parlay_publish_state(target_db=Path(${JSON.stringify(dbPath)}), **payload)
    print(json.dumps({"ok": True, "parlay": row}, default=str))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)[:500]})); sys.exit(1)
`;
  const { parsed } = runPython(script);
  return NextResponse.json(parsed, { status: parsed.ok ? 200 : 400 });
}
