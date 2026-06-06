import { NextRequest, NextResponse } from "next/server";
import { spawnSync } from "child_process";
import path from "path";

export const dynamic = "force-dynamic";

function cleanString(value: unknown, max = 240): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function cleanNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const payload = {
    sport: cleanString(body.sport, 24),
    matchup_label: cleanString(body.matchup_label, 180),
    market: cleanString(body.market, 60),
    side: cleanString(body.side, 80),
    game_id: cleanString(body.game_id, 120),
    game_date: cleanString(body.game_date, 32),
    commence_time: cleanString(body.commence_time, 64),
    league: cleanString(body.league, 80),
    tournament: cleanString(body.tournament, 80),
    home_team: cleanString(body.home_team, 120),
    away_team: cleanString(body.away_team, 120),
    line: cleanNumber(body.line),
    selection_label: cleanString(body.selection_label, 120),
    book: cleanString(body.book, 80),
    odds_american: cleanNumber(body.odds_american),
    model_prob: cleanNumber(body.model_prob),
    edge_pp: cleanNumber(body.edge_pp),
    confidence_tier: cleanString(body.confidence_tier, 24),
    stake_units: cleanNumber(body.stake_units) ?? 1,
    notes: cleanString(body.notes, 1000),
  };

  if (!payload.sport || !payload.matchup_label || !payload.market || !payload.side) {
    return NextResponse.json(
      { ok: false, error: "sport, matchup_label, market, and side are required" },
      { status: 400 },
    );
  }

  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
  const dbPath = path.join(appRoot, "ml", "nba_spread", "data", "tracked_picks.db");
  const script = `
import json, sys
from pathlib import Path
from ml.ops.tracked_picks import add_operator_pick
payload = ${JSON.stringify(payload)}
try:
    row = add_operator_pick(target_db=Path(${JSON.stringify(dbPath)}), **payload)
    print(json.dumps({"ok": True, "pick": row}, default=str))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)[:500]})); sys.exit(1)
`;

  const result = spawnSync("python3", ["-c", script], {
    cwd: appRoot,
    encoding: "utf-8",
    timeout: 8_000,
  });

  try {
    const parsed = JSON.parse(result.stdout);
    return NextResponse.json(parsed, { status: parsed.ok ? 201 : 400 });
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: "manual pick subprocess failed to return JSON",
        exitCode: result.status ?? -1,
        stderr_tail: (result.stderr ?? "").slice(-600),
        stdout_tail: (result.stdout ?? "").slice(-400),
      },
      { status: 500 },
    );
  }
}
