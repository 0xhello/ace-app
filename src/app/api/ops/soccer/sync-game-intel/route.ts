/**
 * /api/ops/soccer/sync-game-intel — targeted soccer game → Sportmonks mapping/sync.
 *
 * Thin ops wrapper around ml.soccer.intel_sync. Default is status-only;
 * ?map=true and ?sync=true explicitly trigger provider work.
 */
import { NextRequest, NextResponse } from "next/server";
import { spawnSync } from "child_process";
import * as serverCache from "@/lib/server-cache";
import { fetchAllGames } from "@/lib/odds-api";
import { getMockGames } from "@/lib/mock-games";
import type { Game } from "@/types/game";

export const dynamic = "force-dynamic";

const BOARD_KEY = "board-games";
const IS_DEV = process.env.NODE_ENV !== "production";

async function getGameForOps(gameId: string): Promise<{ game: Game | null; source: string }> {
  try {
    const entry = await serverCache.get(BOARD_KEY);
    const hit = ((entry?.data?.games ?? []) as Game[]).find((g) => g.id === gameId);
    if (hit) return { game: hit, source: "board-cache" };
  } catch { /* ignore */ }

  try {
    const result = await fetchAllGames();
    const hit = (result.games ?? []).find((g) => g.id === gameId) ?? null;
    if (hit) return { game: hit, source: "odds-refresh" };
  } catch { /* ignore */ }

  if (IS_DEV) {
    const hit = getMockGames().find((g) => g.id === gameId) ?? null;
    if (hit) return { game: hit, source: "dev-mock" };
  }

  return { game: null, source: "none" };
}

export async function GET(req: NextRequest) {
  const gameId = req.nextUrl.searchParams.get("game_id")?.trim();
  const shouldMap = req.nextUrl.searchParams.get("map") === "true";
  const shouldSync = req.nextUrl.searchParams.get("sync") === "true";

  if (!gameId) {
    return NextResponse.json({ ok: false, error: "Missing required ?game_id" }, { status: 400 });
  }

  const { game, source: gameSource } = await getGameForOps(gameId);
  if (!game) {
    return NextResponse.json({ ok: false, error: "Game not found", game_id: gameId }, { status: 404 });
  }
  if (!game.sport.startsWith("soccer")) {
    return NextResponse.json({ ok: false, error: "sync-game-intel is soccer-only", game_id: gameId, sport: game.sport }, { status: 400 });
  }

  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
  const script = `
import json, sys
from ml.soccer.intel_sync import sync_game_intel
try:
    game = ${JSON.stringify(game)}
    print(json.dumps(sync_game_intel(game, game_source=${JSON.stringify(gameSource)}, map=${shouldMap ? "True" : "False"}, sync=${shouldSync ? "True" : "False"}), ensure_ascii=False, default=str))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)[:400], "game_id": ${JSON.stringify(gameId)}})); sys.exit(1)
`;

  const result = spawnSync("python3", ["-c", script], {
    cwd: appRoot,
    encoding: "utf-8",
    timeout: shouldSync || shouldMap ? 60_000 : 8_000,
  });

  try {
    return NextResponse.json({ ...JSON.parse(result.stdout), exitCode: result.status ?? -1 });
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: "sync-game-intel subprocess failed to return JSON",
        exitCode: result.status ?? -1,
        stderr_tail: (result.stderr ?? "").slice(-600),
        stdout_tail: (result.stdout ?? "").slice(-400),
      },
      { status: 500 },
    );
  }
}
