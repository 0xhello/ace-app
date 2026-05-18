import { Game } from "@/types/game";
import DashboardShell from "@/components/dashboard/DashboardShell";
import { fetchAllGames } from "@/lib/odds-api";
import { fetchAllESPNNews } from "@/lib/espn";
import { generateIntelMap } from "@/lib/live-signals";
import { generateLivePicks } from "@/lib/live-picks";
import { fetchWeatherForGames } from "@/lib/weather";
import { fetchModelSignals } from "@/lib/model-signals";
import { getMockGames } from "@/lib/mock-games";
import * as serverCache from "@/lib/server-cache";

const CACHE_KEY = "board-games";
const IS_DEV = process.env.NODE_ENV === "development";

async function getGames(): Promise<{
  games: Game[];
  errors: string[];
  fetchedAt: string | null;
}> {
  const entry = await serverCache.get(CACHE_KEY);
  const cachedGames = entry?.data?.games ?? [];
  if (entry && !serverCache.isStale(entry, cachedGames)) {
    const d = entry.data;
    return { games: d.games ?? [], errors: d.errors ?? [], fetchedAt: d.fetchedAt ?? null };
  }

  try {
    const result = await fetchAllGames();

    if (!result.games.length && result.errors.length) {
      return { games: [], errors: result.errors, fetchedAt: new Date().toISOString() };
    }

    const payload = {
      games: result.games,
      errors: result.errors,
      fetchedAt: result.fetchedAt,
      data_status: result.errors.length ? "degraded" : "ok",
    };
    await serverCache.set(CACHE_KEY, payload, result.games);

    return { games: result.games, errors: result.errors, fetchedAt: result.fetchedAt };
  } catch (e: any) {
    return { games: [], errors: [e.message], fetchedAt: new Date().toISOString() };
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([p, new Promise<T>((res) => { timer = setTimeout(() => res(fallback), ms); })]);
  } catch { return fallback; }
  finally { if (timer) clearTimeout(timer); }
}

export default async function GamesFeed() {
  let { games, errors, fetchedAt } = await getGames();

  // Local dev fallback: when the Odds API is unavailable / out of credits
  // we don't want to dead-end developers with the prod maintenance screen.
  // Drop in mock games instead so the dashboard is usable end-to-end on local.
  if (games.length === 0 && IS_DEV) {
    games = getMockGames();
    fetchedAt = fetchedAt ?? new Date().toISOString();
  }

  if (games.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[#0a0b0a]">
        <div className="text-center max-w-md px-8 py-12">
          <div className="mb-6 mx-auto h-14 w-14 rounded-2xl bg-[#121412] border border-[#22251f] flex items-center justify-center">
            <svg className="h-7 w-7 text-[#3ee68a]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17L17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437l1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008z" />
            </svg>
          </div>
          <p className="text-[20px] font-bold text-white mb-3 leading-tight">
            ACE is Temporarily Offline
          </p>
          <p className="text-[13px] text-[#6b7068] leading-relaxed mb-6">
            Our servers are currently under maintenance. We&apos;ll be back online shortly — please check back in a few minutes.
          </p>
          <div className="flex items-center justify-center gap-1.5 text-[10px] text-[#3a4033] uppercase tracking-widest font-semibold">
            <span className="h-1.5 w-1.5 rounded-full bg-[#f59e0b] animate-pulse" />
            Maintenance in progress
          </div>
        </div>
      </div>
    );
  }

  // Fetch ESPN news, weather, and model signals in parallel
  const [newsItems, weatherMap, modelSignals] = await Promise.all([
    withTimeout(fetchAllESPNNews(), 5_000, []),
    withTimeout(fetchWeatherForGames(games), 6_000, new Map()),
    withTimeout(Promise.resolve(fetchModelSignals()), 5_000, []),
  ]);

  // Pull server-side movement map from cache (populated by /api/board on each refresh)
  const cachedEntry = await serverCache.get(CACHE_KEY);
  const movementMap: Record<string, Record<string, "up" | "down" | null>> =
    cachedEntry?.data?.movementMap ?? {};

  const intelMap = generateIntelMap(games, newsItems, weatherMap, movementMap, modelSignals);
  const topPicks = generateLivePicks(games, 5);

  return (
    <DashboardShell
      games={games}
      intelMap={intelMap}
      boardUpdatedAt={fetchedAt}
      topPicks={topPicks}
    />
  );
}
