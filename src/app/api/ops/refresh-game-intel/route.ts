/**
 * /api/ops/refresh-game-intel — warm the prepared expanded-game bundles used by
 * /dashboard/game/[gameId]. This keeps expensive ESPN/news + Sportmonks reads
 * out of user click/navigation paths.
 *
 * GET /api/ops/refresh-game-intel
 *
 * Admin session or x-ops-read-token via middleware.
 */
import { NextResponse } from "next/server";
import { warmGameViewBundles, getGameViewBundlePayload } from "@/lib/game-view-bundle";

export const dynamic = "force-dynamic";

export async function GET() {
  const result = await warmGameViewBundles("ops-route");
  const payload = await getGameViewBundlePayload();
  return NextResponse.json({
    ...result,
    cachedGameCount: payload?.gameCount ?? 0,
    completeGameCount: payload?.completeCount ?? 0,
    cachedAt: payload?.refreshedAt ?? null,
  }, { status: result.ok === false ? 500 : 200 });
}
