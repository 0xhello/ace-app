import { NextResponse } from "next/server";
import { fetchAllGames } from "@/lib/odds-api";
import * as cache from "@/lib/server-cache";

const CACHE_KEY = "board-games";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const sport = searchParams.get("sport");

  const entry = await cache.get(CACHE_KEY);
  const cachedGames = entry?.data?.games ?? [];

  if (sport) {
    // Per-sport filter — serve from cache if warm, otherwise fetch
    if (entry && !cache.isStale(entry, cachedGames)) {
      const filtered = cachedGames.filter((g: any) => g.sport === sport);
      return NextResponse.json({ games: filtered, cached: true });
    }
    const result = await fetchAllGames();
    await cache.set(CACHE_KEY, { games: result.games, errors: result.errors, fetchedAt: result.fetchedAt }, result.games);
    return NextResponse.json({ games: result.games.filter((g) => g.sport === sport) });
  }

  if (entry && !cache.isStale(entry, cachedGames)) {
    return NextResponse.json({ games: cachedGames, cached: true });
  }

  try {
    const result = await fetchAllGames();
    await cache.set(CACHE_KEY, { games: result.games, errors: result.errors, fetchedAt: result.fetchedAt }, result.games);
    return NextResponse.json({ games: result.games, errors: result.errors });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
