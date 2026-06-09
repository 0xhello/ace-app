/**
 * /api/game/[gameId]/live?fixtureId=<sportmonks id> — real-time match state for
 * the live game view. Polled by the LiveCenter client (~20s). Returns the
 * current score, minute, status and key events straight from Sportmonks (no
 * fabrication). Short serverCache TTL so concurrent viewers share one upstream
 * call. If no fixtureId / not live, returns { live: false } honestly.
 */
import { NextRequest, NextResponse } from "next/server";
import { spawnSync } from "child_process";
import * as serverCache from "@/lib/server-cache";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ gameId: string }> }) {
  const { gameId } = await params;
  const fixtureId = (req.nextUrl.searchParams.get("fixtureId") || "").trim();
  if (!/^\d+$/.test(fixtureId)) {
    return NextResponse.json({ live: false, reason: "no fixture id" });
  }

  const cacheKey = `live-state:${fixtureId}`;
  const cached = await serverCache.get(cacheKey).catch(() => null);
  // 15s freshness — keeps it real-time-ish while sharing one upstream fetch.
  if (cached?.data && cached.fetchedAt && Date.now() - new Date(cached.fetchedAt).getTime() < 15_000) {
    return NextResponse.json({ ...cached.data, cached: true });
  }

  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
  const script = `
import json, sys
from ml.soccer.live_match import live_state
try:
    print(json.dumps(live_state(${JSON.stringify(Number(fixtureId))})))
except Exception as e:
    print(json.dumps({"live": False, "error": str(e)[:200]})); sys.exit(0)
`;
  const r = spawnSync("python3", ["-c", script], { encoding: "utf-8", timeout: 12_000, cwd: appRoot });
  let data: any;
  try { data = JSON.parse(r.stdout); }
  catch { return NextResponse.json({ live: false, error: "live fetch failed" }, { status: 200 }); }

  data.gameId = gameId;
  try { await serverCache.set(cacheKey, data, []); } catch { /* ignore */ }
  return NextResponse.json(data);
}
