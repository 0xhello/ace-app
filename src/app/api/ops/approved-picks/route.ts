/**
 * /api/ops/approved-picks — list + create approved picks (M18).
 *
 *   GET  /api/ops/approved-picks?game_id=X&status=open
 *        → list rows from soccer_approved_picks (read-token gated)
 *
 *   POST /api/ops/approved-picks  (admin session required)
 *        Body: {
 *          game_id, market, side, bet_label,
 *          model_prob, best_price, best_book,
 *          fixture_label?, tournament?, commence_time?,
 *          lineup_status?, rationale?, notes?,
 *        }
 *        → calls approve_pick(...) which computes quarter-Kelly stake and
 *          snapshots the opening line. Returns the persisted row including
 *          stake_units the bettor should risk.
 *
 * The Python subprocess uses the canonical implementations in
 * ml/soccer/approved_picks.py so the Kelly math + table schema stay
 * single-sourced.
 */
import { NextRequest, NextResponse } from "next/server";
import { spawnSync } from "child_process";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gameId = req.nextUrl.searchParams.get("game_id")?.trim() || null;
  const status = req.nextUrl.searchParams.get("status")?.trim() || null;
  const limit = parseInt(req.nextUrl.searchParams.get("limit") || "50", 10);
  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();

  const script = `
import json, sys
from ml.soccer.approved_picks import list_approved_picks, summary_stats
try:
    picks = list_approved_picks(
        game_id=${gameId ? JSON.stringify(gameId) : "None"},
        status=${status ? JSON.stringify(status) : "None"},
        limit=${Number.isFinite(limit) ? limit : 50},
    )
    summary = summary_stats()
    print(json.dumps({"picks": picks, "summary": summary}, default=str))
except Exception as e:
    print(json.dumps({"error": str(e)[:300]})); sys.exit(1)
`;
  const r = spawnSync("python3", ["-c", script], {
    encoding: "utf-8",
    timeout: 10_000,
    cwd: appRoot,
  });
  try {
    return NextResponse.json(JSON.parse(r.stdout));
  } catch {
    return NextResponse.json(
      {
        error: "approved-picks subprocess failed",
        stderr: r.stderr?.slice(-400) ?? "",
        stdout_tail: r.stdout?.slice(-200) ?? "",
      },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const required = ["game_id", "market", "side", "bet_label", "model_prob", "best_price", "best_book"];
  for (const k of required) {
    if (body[k] === undefined || body[k] === null) {
      return NextResponse.json({ error: `Missing field: ${k}` }, { status: 400 });
    }
  }

  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
  const argsJson = JSON.stringify(body);
  const script = `
import json, sys
from ml.soccer.approved_picks import approve_pick
args = json.loads(${JSON.stringify(argsJson)})
try:
    row = approve_pick(
        game_id=args["game_id"],
        market=args["market"],
        side=args["side"],
        bet_label=args["bet_label"],
        model_prob=float(args["model_prob"]),
        best_price=float(args["best_price"]),
        best_book=args["best_book"],
        fixture_label=args.get("fixture_label"),
        tournament=args.get("tournament"),
        commence_time=args.get("commence_time"),
        lineup_status=args.get("lineup_status", "projected"),
        rationale=args.get("rationale"),
        notes=args.get("notes"),
    )
    print(json.dumps({"ok": True, "pick": row}, default=str))
except ValueError as e:
    print(json.dumps({"ok": False, "error": str(e)})); sys.exit(0)
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)[:300]})); sys.exit(1)
`;
  const r = spawnSync("python3", ["-c", script], {
    encoding: "utf-8",
    timeout: 10_000,
    cwd: appRoot,
  });
  try {
    return NextResponse.json(JSON.parse(r.stdout));
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: "approve-pick subprocess failed",
        stderr: r.stderr?.slice(-400) ?? "",
      },
      { status: 500 },
    );
  }
}
