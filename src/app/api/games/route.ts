import { NextResponse } from "next/server";
import { fetchAllGames } from "@/lib/odds-api";
import * as cache from "@/lib/server-cache";

const CACHE_KEY = "board-games";

// Always read from the shared board cache — never hit the Odds API directly.
// If the cache is empty (cold start), delegate to fetchAllGames once to warm it.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const sport = searchParams.get("sport");

  // Per-sport requests bypass cache (rare, internal-only usage)
  if (sport) {
    const { games } = await fetchAllGames();
    const filtered = games.filter((g) => g.sport === sport);
    return NextResponse.json({ games: filtered });
  }

  // Serve from the same cache /api/board uses — zero extra API credits
  const entry = cache.get(CACHE_KEY);
  if (entry && !cache.isStale(CACHE_KEY, entry.data?.games ?? [])) {
    return NextResponse.json({ games: entry.data?.games ?? [], cached: true });
  }

  try {
    const result = await fetchAllGames();
    cache.set(CACHE_KEY, { games: result.games, errors: result.errors, fetchedAt: result.fetchedAt });
    return NextResponse.json({ games: result.games, errors: result.errors });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
