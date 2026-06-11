/**
 * Precomputed expanded-game view bundle.
 *
 * Production rule: user navigation should read this cache, not assemble ESPN /
 * Sportmonks / Python-backed match intelligence in the request path. A worker or
 * ops cron warms these bundles ahead of clicks; the page renders a safe partial
 * state if the bundle is cold.
 */
import * as serverCache from "@/lib/server-cache";
import type { Game } from "@/types/game";
import { fetchAllGames } from "@/lib/odds-api";
import { marketRead, type MarketRead } from "@/lib/market-read";
import { getPreparedGameIntel, warmGameIntelCache, type PreparedGameIntel } from "@/lib/game-intel-cache";
import { getMatchAlphaDigest, type MatchAlphaDigest } from "@/lib/match-alpha";
import { buildSoccerMatchRead, type MatchRead } from "@/lib/match-read";

const BUNDLE_KEY = "game-view-bundles-v3";
const BOARD_KEY = "board-games";

export interface GameViewBundle {
  gameId: string;
  refreshedAt: string;
  complete: boolean;
  game: Game;
  prepared: PreparedGameIntel | null;
  read: MarketRead | null;
  alpha: MatchAlphaDigest | null;
  matchRead: MatchRead | null;
}

export interface GameViewBundlePayload {
  refreshedAt: string;
  gameCount: number;
  completeCount: number;
  games: Record<string, GameViewBundle>;
}

let warming = false;
let lastWarmAt = 0;

async function readPayload(): Promise<GameViewBundlePayload | null> {
  const entry = await serverCache.get(BUNDLE_KEY);
  return (entry?.data as GameViewBundlePayload | undefined) ?? null;
}

/**
 * Cache-only read for the page. If the full bundle is cold but prepared intel is
 * available, return a partial bundle without doing Sportmonks/Python work.
 */
export async function getGameViewBundle(game: Game): Promise<GameViewBundle> {
  const payload = await readPayload();
  const cached = payload?.games?.[game.id];
  if (cached) return cached;

  const prepared = await getPreparedGameIntel(game.id).catch(() => null);
  return {
    gameId: game.id,
    refreshedAt: prepared?.refreshedAt ?? new Date(0).toISOString(),
    complete: false,
    game,
    prepared,
    read: marketRead(game),
    alpha: null,
    matchRead: null,
  };
}

async function buildBundle(game: Game): Promise<GameViewBundle> {
  const prepared = await getPreparedGameIntel(game.id).catch(() => null);
  const read = marketRead(game);
  const isSoccer = game.sport.startsWith("soccer");
  const alpha = isSoccer ? await getMatchAlphaDigest(game, prepared) : null;
  const matchRead = isSoccer && alpha ? buildSoccerMatchRead(game, prepared, alpha) : null;
  return {
    gameId: game.id,
    refreshedAt: new Date().toISOString(),
    complete: true,
    game,
    prepared,
    read,
    alpha,
    matchRead,
  };
}

export async function warmGameViewBundles(reason = "manual"): Promise<any> {
  if (warming) return { ok: true, skipped: "already warming" };
  if (Date.now() - lastWarmAt < 60_000) return { ok: true, skipped: "warmed recently" };

  warming = true;
  try {
    const boardEntry = await serverCache.get(BOARD_KEY);
    let games = ((boardEntry?.data as { games?: Game[] } | undefined)?.games ?? []) as Game[];
    let source: "board-cache" | "odds-api" = "board-cache";
    if (!games.length) {
      const fresh = await fetchAllGames().catch(() => ({ games: [] as Game[] }));
      games = fresh.games ?? [];
      source = "odds-api";
      if (games.length) {
        await serverCache.set(BOARD_KEY, {
          games,
          errors: [],
          fetchedAt: new Date().toISOString(),
          data_status: "ok",
          movementMap: {},
        }, games);
      }
    }

    // Refresh the lighter prepared-intel layer after the board cache is known.
    // It is internally guarded against tight loops, so this is safe from cron/ops triggers.
    const intel = await warmGameIntelCache(`game-view:${reason}`);

    if (!games.length) {
      return { ok: true, reason, refreshed: 0, note: "no games available", source, intel };
    }

    const built: Record<string, GameViewBundle> = {};
    // Deliberately serialize: Sportmonks/Python-backed reads can be bursty and
    // provider/API limits matter more than shaving seconds off a background job.
    for (const game of games) built[game.id] = await buildBundle(game);

    const refreshedAt = new Date().toISOString();
    const payload: GameViewBundlePayload = {
      refreshedAt,
      gameCount: games.length,
      completeCount: Object.values(built).filter((b) => b.complete).length,
      games: built,
    };
    await serverCache.set(BUNDLE_KEY, payload, games);
    lastWarmAt = Date.now();

    return {
      ok: true,
      reason,
      refreshed: games.length,
      complete: payload.completeCount,
      soccer: games.filter((g) => g.sport.startsWith("soccer")).length,
      cachedAt: refreshedAt,
      source,
      intel,
    };
  } catch (e) {
    return { ok: false, reason, error: String(e).slice(0, 300) };
  } finally {
    warming = false;
  }
}

export function warmGameViewBundlesSoon(reason = "async"): void {
  setTimeout(() => {
    void warmGameViewBundles(reason).then((r) => {
      if (r?.ok === false) console.error("[game-view-bundle] warm failed", r);
      else console.log("[game-view-bundle]", JSON.stringify(r));
    });
  }, 0);
}

export async function getGameViewBundlePayload(): Promise<GameViewBundlePayload | null> {
  return readPayload();
}
