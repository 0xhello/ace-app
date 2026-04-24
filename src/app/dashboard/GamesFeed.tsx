import { Game } from "@/types/game";
import DashboardShell from "@/components/dashboard/DashboardShell";
import { getMockGames } from "@/lib/mock-games";
import { fetchAllGames } from "@/lib/odds-api";
import { fetchAllESPNNews } from "@/lib/espn";
import { generateIntelMap } from "@/lib/live-signals";
import { generateLivePicks } from "@/lib/live-picks";
import * as serverCache from "@/lib/server-cache";

const CACHE_KEY = "board-games";

async function getGames(): Promise<{
  games: Game[];
  errors: string[];
  fetchedAt: string | null;
  feedMode: "live" | "demo";
}> {
  // Serve from server cache on initial render if still fresh
  const cached = serverCache.get(CACHE_KEY);
  const cachedGames = cached?.data?.games ?? [];
  if (cached && !serverCache.isStale(CACHE_KEY, cachedGames)) {
    const d = cached.data;
    return { games: d.games ?? [], errors: d.errors ?? [], fetchedAt: d.fetchedAt ?? null, feedMode: "live" };
  }

  try {
    const result = await fetchAllGames();

    if (!result.games.length && result.errors.length) {
      return { games: getMockGames(), errors: result.errors, fetchedAt: new Date().toISOString(), feedMode: "demo" };
    }

    const payload = {
      games: result.games,
      errors: result.errors,
      fetchedAt: result.fetchedAt,
      data_status: result.errors.length ? "degraded" : "ok",
    };
    serverCache.set(CACHE_KEY, payload);

    return { games: result.games, errors: result.errors, fetchedAt: result.fetchedAt, feedMode: "live" };
  } catch (e: any) {
    return {
      games: getMockGames(),
      errors: [e.message],
      fetchedAt: new Date().toISOString(),
      feedMode: "demo",
    };
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
  const { games, errors, fetchedAt, feedMode } = await getGames();

  // Fetch ESPN news for signal generation (free, no quota impact)
  const newsItems = await withTimeout(fetchAllESPNNews(), 5_000, []);

  // Generate intel map and top picks from real data
  const intelMap = generateIntelMap(games, newsItems);
  const topPicks = generateLivePicks(games, 5);

  if (games.length === 0) {
    const quotaIssue = errors.some((e) =>
      /quota|usage|401|429|invalid|expired/i.test(String(e))
    );
    return (
      <div className="text-center py-20 max-w-xl mx-auto px-6">
        <p className="text-lg font-medium text-white mb-2">
          {quotaIssue ? "Market data temporarily unavailable" : "No games right now"}
        </p>
        <p className="text-sm text-[#9ca39a]">
          {quotaIssue
            ? "The live odds provider is currently out of usage credits. ACE is still online — board market rows will return once quota is restored."
            : "Check back when games are scheduled."}
        </p>
        {errors.length > 0 && (
          <div className="mt-4 inline-flex flex-col items-start gap-1 rounded-lg border border-[#22251f] bg-[#121412] px-4 py-3 text-left">
            <span className="text-[11px] uppercase tracking-wider text-[#6b7068]">Data status</span>
            <span className="text-[12px] text-white">{errors[0]}</span>
            {fetchedAt && (
              <span className="text-[10px] text-[#6b7068]">
                Checked {new Date(fetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              </span>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <DashboardShell
      games={games}
      intelMap={intelMap}
      boardUpdatedAt={fetchedAt}
      topPicks={topPicks}
    />
  );
}
