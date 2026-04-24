import { Game } from "@/types/game";
import DashboardShell from "@/components/dashboard/DashboardShell";
import { fetchBoardIntel, fetchLiveBoardIntel, fetchTopPicks } from "@/lib/intel-data";
import { getMockGames } from "@/lib/mock-games";
import * as serverCache from "@/lib/server-cache";

const BACKEND = process.env.ODDS_API_URL || "http://localhost:8000";
const CACHE_KEY = "board-games";

async function getGames(): Promise<{
  games: Game[];
  errors: any[];
  dataStatus: string;
  fetchedAt: string | null;
  feedMode: "live" | "demo";
}> {
  // Serve from cache on the server render if fresh — avoids hitting the backend
  const cached = serverCache.get(CACHE_KEY);
  const cachedGames = cached?.data?.games ?? [];
  if (cached && !serverCache.isStale(CACHE_KEY, cachedGames)) {
    const d = cached.data;
    return { games: d.games || [], errors: d.errors || [], dataStatus: d.data_status || "ok", fetchedAt: d.fetched_at || null, feedMode: "live" };
  }

  const url = `${BACKEND}/games`;

  try {
    const res = await fetch(url, { cache: "no-store" });

    if (!res.ok) {
      return {
        games: getMockGames(),
        errors: [{ detail: "Live feed unavailable — showing demo board." }],
        dataStatus: "demo",
        fetchedAt: new Date().toISOString(),
        feedMode: "demo",
      };
    }

    const data = await res.json();
    serverCache.set(CACHE_KEY, data); // populate cache for client pollers
    const games = data.games || [];

    return {
      games,
      errors: data.errors || [],
      dataStatus: data.data_status || "ok",
      fetchedAt: data.fetched_at || null,
      feedMode: "live",
    };
  } catch {
    return {
      games: getMockGames(),
      errors: [{ detail: "Backend offline — using local demo slate." }],
      dataStatus: "demo",
      fetchedAt: new Date().toISOString(),
      feedMode: "demo",
    };
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export default async function GamesFeed() {
  const gamesResult = await getGames();
  const { games, errors, dataStatus, fetchedAt, feedMode } = gamesResult;

  const liveGameCount = games.filter((g) => g.status === "live").length;
  const boardLimit = 24;

  const [liveBoardIntel, boardIntel, topPicks] = await Promise.all([
    liveGameCount > 0
      ? withTimeout(fetchLiveBoardIntel(liveGameCount + 4), 5000, { count: 0, items: [], updated_at: null })
      : Promise.resolve({ count: 0, items: [], updated_at: null }),
    withTimeout(fetchBoardIntel(boardLimit), 4000, { count: 0, items: [], updated_at: null }),
    withTimeout(fetchTopPicks(4), 1200, { count: 0, items: [], updated_at: null }),
  ]);

  if (games.length === 0) {
    const quotaIssue = errors.some(
      (e: any) =>
        String(e?.detail || "").toLowerCase().includes("quota") ||
        String(e?.detail || "").toLowerCase().includes("usage") ||
        e?.status_code === 401 ||
        e?.status_code === 429
    );

    return (
      <div className="text-center py-20 text-ace-muted max-w-xl mx-auto px-6">
        <p className="text-lg font-medium text-white mb-2">
          {quotaIssue ? "Market data temporarily unavailable" : "No games right now"}
        </p>
        <p className="text-sm text-[#71717a]">
          {quotaIssue
            ? "The live odds provider is currently out of usage credits. ACE is still online, but board market rows will return once provider quota is restored."
            : "Check back when games are scheduled."}
        </p>
        {dataStatus === "degraded" && errors.length > 0 && (
          <div className="mt-4 inline-flex flex-col items-start gap-1 rounded-lg border border-[#2e332a] bg-[#121412] px-4 py-3 text-left">
            <span className="text-[11px] uppercase tracking-wider text-[#52525b]">Data status</span>
            <span className="text-[12px] text-white">{errors[0]?.detail || "Source degraded"}</span>
            {fetchedAt && (
              <span className="text-[10px] text-[#52525b]">
                Checked {new Date(fetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              </span>
            )}
          </div>
        )}
      </div>
    );
  }

  const mergedItems: any[] = [...((boardIntel.items || []) as any[])];
  for (const liveItem of (liveBoardIntel.items || []) as any[]) {
    const idx = mergedItems.findIndex((item: any) => item.game_id === liveItem.game_id);
    if (idx >= 0) mergedItems[idx] = { ...mergedItems[idx], ...liveItem };
    else mergedItems.push(liveItem);
  }

  const intelMap = Object.fromEntries(mergedItems.map((item: any) => [item.game_id, item]));
  const boardUpdatedAt = liveBoardIntel.updated_at || boardIntel.updated_at || fetchedAt;

  return (
    <DashboardShell
      games={games}
      intelMap={intelMap}
      boardUpdatedAt={boardUpdatedAt}
      topPicks={topPicks.items || []}
    />
  );
}
