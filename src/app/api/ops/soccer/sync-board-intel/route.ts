/**
 * /api/ops/soccer/sync-board-intel — safe board-level controller for soccer game intel.
 *
 * Thin ops wrapper around ml.soccer.intel_sync. GET is status-only:
 * reads local DB/cache and spends no provider credits. Mutating work must use POST:
 *   - POST ?map=true   maps unmapped games, up to ?limit=N
 *   - POST ?sync=true  syncs already-mapped games, up to ?limit=N
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

async function boardGames(): Promise<{ games: Game[]; source: string }> {
  try {
    const entry = await serverCache.get(BOARD_KEY);
    const games = (entry?.data?.games ?? []) as Game[];
    if (games.length) return { games, source: "board-cache" };
  } catch { /* ignore */ }

  try {
    const result = await fetchAllGames();
    if (result.games?.length) return { games: result.games, source: "odds-refresh" };
  } catch { /* ignore */ }

  if (IS_DEV) return { games: getMockGames(), source: "dev-mock" };
  return { games: [], source: "none" };
}

function boundedInt(value: string | null, fallback: number, min: number, max: number): number {
  const raw = Number(value ?? fallback);
  return Number.isFinite(raw) ? Math.max(min, Math.min(max, Math.floor(raw))) : fallback;
}

async function runBoardIntel(req: NextRequest, opts?: { allowMutating?: boolean }) {
  const shouldMap = req.nextUrl.searchParams.get("map") === "true";
  const shouldSync = req.nextUrl.searchParams.get("sync") === "true";
  if ((shouldMap || shouldSync) && !opts?.allowMutating) {
    return NextResponse.json(
      { ok: false, error: "map/sync mutate data and must be called with POST by an admin session" },
      { status: 405, headers: { Allow: "GET, POST" } },
    );
  }
  const limit = boundedInt(req.nextUrl.searchParams.get("limit"), 12, 1, 24);
  const horizonHours = boundedInt(req.nextUrl.searchParams.get("horizonHours"), 240, 1, 720);

  const { games, source } = await boardGames();
  const now = Date.now();
  const soccerGames = games
    .filter((g) => g.sport.startsWith("soccer"))
    .filter((g) => {
      const t = new Date(g.commence_time).getTime();
      if (!Number.isFinite(t)) return false;
      const hours = (t - now) / 3_600_000;
      return hours >= -6 && hours <= horizonHours;
    })
    .sort((a, b) => new Date(a.commence_time).getTime() - new Date(b.commence_time).getTime())
    .slice(0, limit);

  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
  const script = `
import json, sys
from ml.soccer.intel_sync import sync_board_intel
try:
    games = ${JSON.stringify(soccerGames)}
    print(json.dumps(sync_board_intel(games, map=${shouldMap ? "True" : "False"}, sync=${shouldSync ? "True" : "False"}), ensure_ascii=False, default=str))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)[:400]})); sys.exit(1)
`;

  const result = spawnSync("python3", ["-c", script], {
    cwd: appRoot,
    encoding: "utf-8",
    timeout: shouldSync || shouldMap ? 180_000 : 20_000,
  });

  try {
    return NextResponse.json({ ...JSON.parse(result.stdout), board_source: source, limit, horizonHours, exitCode: result.status ?? -1 });
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: "sync-board-intel subprocess failed to return JSON",
        board_source: source,
        exitCode: result.status ?? -1,
        stderr_tail: (result.stderr ?? "").slice(-800),
        stdout_tail: (result.stdout ?? "").slice(-800),
      },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  return runBoardIntel(req, { allowMutating: false });
}

export async function POST(req: NextRequest) {
  return runBoardIntel(req, { allowMutating: true });
}
