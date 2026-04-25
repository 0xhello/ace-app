import { NextResponse } from "next/server";
import { fetchAllGames } from "@/lib/odds-api";
import * as cache from "@/lib/server-cache";
import type { OddsSnapshot } from "@/lib/server-cache";
import { Game } from "@/types/game";

const CACHE_KEY = "board-games";

function buildOddsSnapshot(games: Game[]): OddsSnapshot {
  const snap: OddsSnapshot = {};
  for (const g of games) {
    const get = (market: "h2h" | "spreads" | "totals", side: string) => {
      const prices = g.bookmakers.flatMap((b) =>
        (b.markets[market] ?? []).filter((o) => o.name === side).map((o) => o.price)
      );
      return prices.length ? Math.max(...prices) : null;
    };
    snap[g.id] = {
      ml_away:  get("h2h",     g.away_team),
      ml_home:  get("h2h",     g.home_team),
      sp_away:  get("spreads", g.away_team),
      sp_home:  get("spreads", g.home_team),
      ov:       get("totals",  "Over"),
      un:       get("totals",  "Under"),
    };
  }
  return snap;
}

function computeMovement(
  prev: OddsSnapshot,
  curr: OddsSnapshot
): Record<string, Record<string, "up" | "down" | null>> {
  const result: Record<string, Record<string, "up" | "down" | null>> = {};
  for (const gameId of Object.keys(curr)) {
    const p = prev[gameId];
    const c = curr[gameId];
    if (!p) continue;
    const moves: Record<string, "up" | "down" | null> = {};
    for (const key of Object.keys(c)) {
      const pv = p[key], cv = c[key];
      if (pv == null || cv == null) { moves[key] = null; continue; }
      moves[key] = cv > pv ? "up" : cv < pv ? "down" : null;
    }
    result[gameId] = moves;
  }
  return result;
}

export async function GET() {
  const entry = cache.get(CACHE_KEY);
  const cachedGames = entry?.data?.games ?? [];

  // Serve from cache if still fresh
  if (!cache.isStale(CACHE_KEY, cachedGames)) {
    return NextResponse.json({
      ...entry!.data,
      cached: true,
      cacheAge: Math.round(cache.age(CACHE_KEY) / 1000),
    });
  }

  // Fetch fresh from Odds API
  try {
    const result = await fetchAllGames();

    // Build movement map by comparing to previous odds snapshot
    const currSnap = buildOddsSnapshot(result.games);
    const prevSnap = cache.getPrevOddsSnapshot();
    const movementMap = computeMovement(prevSnap, currSnap);
    cache.setPrevOddsSnapshot(currSnap);

    const payload = {
      games: result.games,
      errors: result.errors,
      fetchedAt: result.fetchedAt,
      data_status: result.errors.length ? "degraded" : "ok",
      movementMap,
    };
    cache.set(CACHE_KEY, payload);
    return NextResponse.json({ ...payload, cached: false, cacheAge: 0 });
  } catch (e: any) {
    if (entry) {
      return NextResponse.json({
        ...entry.data,
        cached: true,
        stale: true,
        cacheAge: Math.round(cache.age(CACHE_KEY) / 1000),
      });
    }
    return NextResponse.json(
      { games: [], errors: [e.message], fetchedAt: null, data_status: "error" },
      { status: 503 }
    );
  }
}
