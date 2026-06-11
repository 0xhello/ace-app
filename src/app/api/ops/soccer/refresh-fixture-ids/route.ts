/**
 * /api/ops/soccer/refresh-fixture-ids — resolve board soccer games → Sportmonks
 * fixture ids and persist the map the LIVE view reads. One cheap discovery call;
 * no per-game spend. The scheduler runs this every ~10 min; POST is the manual
 * trigger (used to seed the map immediately, e.g. before a marquee kickoff).
 *
 *   GET  → current persisted map
 *   POST → re-resolve off the cached board and persist
 */
import { NextResponse } from "next/server";
import { refreshFixtureIdMap, getFixtureIdMap } from "@/lib/soccer-fixture-id";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ok: true, map: await getFixtureIdMap() });
}

export async function POST() {
  const result = await refreshFixtureIdMap();
  return NextResponse.json({ ...result, map: await getFixtureIdMap() });
}
