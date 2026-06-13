/**
 * /api/ops/soccer/refresh-takes
 *   GET  — read the current ACE Takes cache (debug)
 *   POST — warm takes for the board's upcoming soccer games and persist
 */
import { NextResponse } from "next/server";
import { warmMatchTakes, getMatchTakesPayload } from "@/lib/match-takes";

export const dynamic = "force-dynamic";

export async function GET() {
  const payload = await getMatchTakesPayload();
  const games = payload?.games ?? {};
  const summary = Object.entries(games).map(([id, g]) => ({
    id, match: `${g.away} @ ${g.home}`, takes: g.takes?.length ?? 0,
    lineups: g.lineups_posted, source: g.source,
  }));
  return NextResponse.json({ refreshedAt: payload?.refreshedAt ?? null, count: summary.length, games: summary });
}

export async function POST() {
  const r = await warmMatchTakes("ops");
  return NextResponse.json(r);
}
