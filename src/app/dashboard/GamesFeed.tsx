import { Game } from "@/types/game";
import DashboardShell from "@/components/dashboard/DashboardShell";
import { fetchBoardIntel, fetchTopPicks } from "@/lib/intel-data";

async function getGames(): Promise<{ games: Game[]; errors: any[]; dataStatus: string; fetchedAt: string | null }> {
  const url = `${process.env.ODDS_API_URL || "http://localhost:8000"}/games`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return { games: [], errors: [{ detail: "Backend unavailable" }], dataStatus: "degraded", fetchedAt: null };
  const data = await res.json();
  return {
    games: data.games || [],
    errors: data.errors || [],
    dataStatus: data.data_status || "ok",
    fetchedAt: data.fetched_at || null,
  };
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
  const { games, errors, dataStatus, fetchedAt } = gamesResult;

  const [boardIntel, topPicks] = await Promise.all([
    withTimeout(fetchBoardIntel(40), 4500, { count: 0, items: [], updated_at: null }),
    withTimeout(fetchTopPicks(4), 2000, { count: 0, items: [], updated_at: null }),
  ]);

  if (games.length === 0) {
    const quotaIssue = errors.some((e: any) => String(e?.detail || "").toLowerCase().includes("quota") || String(e?.detail || "").toLowerCase().includes("usage") || e?.status_code === 401 || e?.status_code === 429);
    return (
      <div className="text-center py-20 text-ace-muted max-w-xl mx-auto px-6">
        <p className="text-lg font-medium text-white mb-2">{quotaIssue ? "Market data temporarily unavailable" : "No games right now"}</p>
        <p className="text-sm text-[#71717a]">
          {quotaIssue
            ? "The live odds provider is currently out of usage credits. ACE is still online, but board market rows will return once provider quota is restored."
            : "Check back when games are scheduled."}
        </p>
        {dataStatus === "degraded" && errors.length > 0 && (
          <div className="mt-4 inline-flex flex-col items-start gap-1 rounded-lg border border-[#1e1e24] bg-[#0c0c0e] px-4 py-3 text-left">
            <span className="text-[11px] uppercase tracking-wider text-[#52525b]">Data status</span>
            <span className="text-[12px] text-white">{errors[0]?.detail || "Source degraded"}</span>
            {fetchedAt && <span className="text-[10px] text-[#52525b]">Checked {new Date(fetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>}
          </div>
        )}
      </div>
    );
  }

  const intelMap = Object.fromEntries((boardIntel.items || []).map((item: any) => [item.game_id, item]));

  return <DashboardShell games={games} intelMap={intelMap} boardUpdatedAt={boardIntel.updated_at} topPicks={topPicks.items || []} />;
}
