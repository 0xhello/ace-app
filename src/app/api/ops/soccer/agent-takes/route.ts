/**
 * /api/ops/soccer/agent-takes
 *   GET  — read the analyst-agent override store
 *   POST — write agent takes. Body: { games: { [gameId]: GameTakes } }
 *
 * This is the channel the analyst agent writes to (manual seed today, the
 * production LLM agent once a funded ANTHROPIC_API_KEY exists). getMatchTakes
 * prefers this store over the rule-engine takes.
 */
import { NextRequest, NextResponse } from "next/server";
import { writeAgentTakes, getAgentTakesPayload, type GameTakes } from "@/lib/match-takes";

export const dynamic = "force-dynamic";

export async function GET() {
  const payload = await getAgentTakesPayload();
  const games = payload?.games ?? {};
  return NextResponse.json({
    refreshedAt: payload?.refreshedAt ?? null,
    count: Object.keys(games).length,
    games: Object.entries(games).map(([id, g]) => ({ id, match: `${g.away} @ ${g.home}`, takes: g.takes?.length ?? 0 })),
  });
}

export async function POST(req: NextRequest) {
  let body: { games?: Record<string, GameTakes> };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  if (!body?.games || typeof body.games !== "object") {
    return NextResponse.json({ error: "expected { games: { gameId: GameTakes } }" }, { status: 400 });
  }
  const r = await writeAgentTakes(body.games);
  return NextResponse.json(r);
}
