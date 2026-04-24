import { NextResponse } from "next/server";
import { fetchAllGames } from "@/lib/odds-api";
import * as cache from "@/lib/server-cache";

const CACHE_KEY = "board-games";

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
    const payload = {
      games: result.games,
      errors: result.errors,
      fetchedAt: result.fetchedAt,
      data_status: result.errors.length ? "degraded" : "ok",
    };
    cache.set(CACHE_KEY, payload);
    return NextResponse.json({ ...payload, cached: false, cacheAge: 0 });
  } catch (e: any) {
    // Return stale cache over an error — never flash the board empty
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
