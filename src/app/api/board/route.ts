import { NextResponse } from "next/server";
import * as cache from "@/lib/server-cache";

const BACKEND = process.env.ODDS_API_URL || "http://localhost:8000";
const CACHE_KEY = "board-games";

async function fetchFromBackend() {
  const res = await fetch(`${BACKEND}/games`, {
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Backend ${res.status}`);
  return res.json();
}

export async function GET() {
  const entry = cache.get(CACHE_KEY);
  const games = entry?.data?.games ?? [];

  // Serve from cache if still fresh
  if (!cache.isStale(CACHE_KEY, games)) {
    return NextResponse.json({
      ...entry!.data,
      cached: true,
      cacheAge: Math.round(cache.age(CACHE_KEY) / 1000),
    });
  }

  // Fetch fresh data
  try {
    const data = await fetchFromBackend();
    cache.set(CACHE_KEY, data);
    return NextResponse.json({ ...data, cached: false, cacheAge: 0 });
  } catch {
    // Return stale cache rather than an error — never flash the board empty
    if (entry) {
      return NextResponse.json({
        ...entry.data,
        cached: true,
        stale: true,
        cacheAge: Math.round(cache.age(CACHE_KEY) / 1000),
      });
    }
    return NextResponse.json({ games: [], fetchedAt: null }, { status: 503 });
  }
}
