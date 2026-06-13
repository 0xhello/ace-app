/**
 * Prepared game intelligence cache.
 *
 * Expensive research work belongs here/background jobs, not inside the game-page
 * request path. The page should read this cache synchronously-fast and render a
 * good partial state if a refresh has not populated it yet.
 */
import * as serverCache from "@/lib/server-cache";
import { fetchAllESPNNews } from "@/lib/espn";
import { fetchSoccerInjuries } from "@/lib/soccer-injuries";
import { fetchSoccerRecentForm, normTeamKey, type TeamRecentForm } from "@/lib/soccer-recent-form";
import { generateIntelMap, type GameSignal, type InjuryAlert } from "@/lib/live-signals";
import { sportTab } from "@/lib/sport-tab";
import type { Game } from "@/types/game";

const BOARD_KEY = "board-games";
const INTEL_KEY = "game-intel-v2";

export interface PreparedGameIntel {
  gameId: string;
  refreshedAt: string;
  stories: GameSignal[];
  injuryAlerts: InjuryAlert[];
  awayForm: TeamRecentForm | null;
  homeForm: TeamRecentForm | null;
}

export interface PreparedGameIntelPayload {
  refreshedAt: string;
  gameCount: number;
  games: Record<string, PreparedGameIntel>;
}

let warming = false;
let lastWarmAt = 0;

function isUsefulStory(s: GameSignal): boolean {
  if (s.type !== "news") return false;
  const title = (s.title || "").trim();
  const detail = (s.detail || "").trim();
  if (title.length < 12) return false;
  // A naked headline is exactly what made the page feel random. If ESPN has no
  // context, do not surface it in the game research page.
  if (detail.length < 35) return false;
  // Hard guard against the obvious cross-sport/general-feed leaks users noticed.
  const text = `${title} ${detail}`.toLowerCase();
  if (/\bmlb\b|baseball|trade deadline|jeff passan/.test(text)) return false;
  return true;
}

function compactStory(s: GameSignal): GameSignal {
  return {
    ...s,
    detail: (s.detail || "").trim(),
    title: (s.title || "").trim(),
  };
}

export async function getPreparedGameIntel(gameId: string): Promise<PreparedGameIntel | null> {
  const entry = await serverCache.get(INTEL_KEY);
  return (entry?.data as PreparedGameIntelPayload | undefined)?.games?.[gameId] ?? null;
}

export async function getPreparedGameIntelPayload(): Promise<PreparedGameIntelPayload | null> {
  const entry = await serverCache.get(INTEL_KEY);
  return (entry?.data as PreparedGameIntelPayload | undefined) ?? null;
}

export async function warmGameIntelCache(reason = "manual"): Promise<any> {
  if (warming) return { ok: true, skipped: "already warming" };
  // Avoid accidental tight loops from multiple boot/request triggers.
  if (Date.now() - lastWarmAt < 60_000) return { ok: true, skipped: "warmed recently" };

  warming = true;
  try {
    const boardEntry = await serverCache.get(BOARD_KEY);
    const board = boardEntry?.data as { games?: Game[]; movementMap?: Record<string, Record<string, "up" | "down" | null>> } | undefined;
    const games = board?.games ?? [];
    if (!games.length) return { ok: true, refreshed: 0, note: "no board games cached", reason };

    const [newsItems, soccerInjuryMap, recentFormMap] = await Promise.all([
      fetchAllESPNNews().catch(() => []),
      Promise.resolve(fetchSoccerInjuries()),
      Promise.resolve(fetchSoccerRecentForm()),
    ]);

    const intelMap = generateIntelMap(games, newsItems, new Map(), board?.movementMap ?? {}, [], soccerInjuryMap);
    const refreshedAt = new Date().toISOString();
    const prepared: Record<string, PreparedGameIntel> = {};

    for (const game of games) {
      const intel = intelMap[game.id];
      const isSoccer = sportTab(game.sport, game.sport_title) === "SOCCER";
      const stories = (intel?.signals ?? [])
        .filter(isUsefulStory)
        .map(compactStory)
        .slice(0, 6);

      prepared[game.id] = {
        gameId: game.id,
        refreshedAt,
        stories,
        injuryAlerts: intel?.injury_alerts ?? [],
        awayForm: isSoccer ? recentFormMap.get(normTeamKey(game.away_team)) ?? null : null,
        homeForm: isSoccer ? recentFormMap.get(normTeamKey(game.home_team)) ?? null : null,
      };
    }

    const payload: PreparedGameIntelPayload = {
      refreshedAt,
      gameCount: games.length,
      games: prepared,
    };
    // PERSISTENT (no TTL): this research layer (form/news/injuries) is refreshed
    // by the background scheduler every ~10min and changes slowly. The old
    // ttl-driven set() expired in 5min on live-game days — shorter than the
    // scheduler interval — leaving the game page with cold, empty form/news/
    // injuries for half of every window (the "random, refresh-fixes-it" bug).
    // Stale-but-present always beats blank; the scheduler overwrites each tick.
    await serverCache.setPersistent(INTEL_KEY, payload);
    lastWarmAt = Date.now();
    return {
      ok: true,
      reason,
      refreshed: games.length,
      stories: Object.values(prepared).reduce((n, g) => n + g.stories.length, 0),
      injuries: Object.values(prepared).reduce((n, g) => n + g.injuryAlerts.length, 0),
      refreshedAt,
    };
  } catch (e) {
    return { ok: false, reason, error: String(e).slice(0, 300) };
  } finally {
    warming = false;
  }
}

export function warmGameIntelCacheSoon(reason = "async"): void {
  setTimeout(() => {
    void warmGameIntelCache(reason).then((r) => {
      if (r?.ok === false) console.error("[game-intel-cache] warm failed", r);
      else console.log("[game-intel-cache]", JSON.stringify(r));
    });
  }, 0);
}
