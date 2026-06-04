/**
 * /api/ops/refresh-game-intel — warm the prepared game research cache used by
 * /dashboard/game/[gameId]. This keeps expensive ESPN/news + Sportmonks reads
 * out of user click/navigation paths.
 *
 * GET /api/ops/refresh-game-intel
 *
 * Admin session or x-ops-read-token via middleware.
 */
import { NextResponse } from "next/server";
import { warmGameIntelCache, getPreparedGameIntelPayload } from "@/lib/game-intel-cache";

export const dynamic = "force-dynamic";

export async function GET() {
  const result = await warmGameIntelCache("ops-route");
  const payload = await getPreparedGameIntelPayload();
  return NextResponse.json({
    ...result,
    cachedGameCount: payload?.gameCount ?? 0,
    cachedAt: payload?.refreshedAt ?? null,
  }, { status: result.ok === false ? 500 : 200 });
}
