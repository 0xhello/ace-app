import { Game } from "@/types/game";
import DashboardShell from "@/components/dashboard/DashboardShell";
import { fetchAllGames } from "@/lib/odds-api";
import { fetchAllESPNNews } from "@/lib/espn";
import { generateIntelMap } from "@/lib/live-signals";
import { generateLivePicks } from "@/lib/live-picks";
import { fetchWeatherForGames } from "@/lib/weather";
import { fetchModelSignals } from "@/lib/model-signals";
// fetchWCSignals intentionally not imported — soccer picks are paused on
// the user-facing dashboard while the model-driven intelligence layer is
// built. The CLV-divergence engine still runs in the background as data
// collection. Re-import when soccer picks pass the model bar.
// import { fetchWCSignals } from "@/lib/wc-signals";
import { fetchMLBSignals } from "@/lib/mlb-signals";
import { fetchSoccerInjuries } from "@/lib/soccer-injuries";
import { getMatchTakesPayload, getAgentTakesPayload, type GameTakes } from "@/lib/match-takes";
import * as serverCache from "@/lib/server-cache";

const TIER_RANK: Record<string, number> = { Strong: 0, Lean: 1, Slight: 2, Pass: 3 };

/** Headline take for a game (best non-Pass by tier) + a play count, for the
 * board's ACE Take chip. */
function headlineTake(t: GameTakes | undefined) {
  if (!t?.takes?.length) return null;
  const sorted = [...t.takes].sort((a, b) => (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9));
  const top = sorted.find((x) => x.tier !== "Pass") ?? sorted[0];
  if (!top) return null;
  const plays = t.takes.filter((x) => x.tier !== "Pass").length;
  return { tier: top.tier, selection: top.selection, market_label: top.market_label, source: t.source ?? "cache", plays };
}

const CACHE_KEY = "board-games";
const BOARD_INTEL_KEY = "board-generated-intel-v2";

function gameIdsKey(games: Game[]): string {
  return games.map((g) => g.id).sort().join("|");
}

interface BoardGeneratedIntelCache {
  gameIdsKey: string;
  intelMap: any;
  topPicks: any[];
  generatedAt: string;
}


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
            Live board data is unavailable
          </p>
          <p className="text-[13px] text-[#6b7068] leading-relaxed mb-6">
            ACE could not load current odds or schedule data. We&apos;re not showing fallback games because that could be mistaken for real betting intelligence.
          </p>
          <div className="flex items-center justify-center gap-1.5 text-[10px] text-[#3a4033] uppercase tracking-widest font-semibold">
            <span className="h-1.5 w-1.5 rounded-full bg-[#f59e0b] animate-pulse" />
            Real data required
          </div>
        </div>
      </div>
    );
  }

  // Pull server-side movement map from cache (populated by /api/board on each refresh)
  const cachedEntry = await serverCache.get(CACHE_KEY);
  const movementMap: Record<string, Record<string, "up" | "down" | null>> =
    cachedEntry?.data?.movementMap ?? {};

  const idsKey = gameIdsKey(games);
  const cachedIntelEntry = await serverCache.get(BOARD_INTEL_KEY);
  const cachedIntel = cachedIntelEntry?.data as BoardGeneratedIntelCache | undefined;
  let intelMap = cachedIntel?.gameIdsKey === idsKey ? cachedIntel.intelMap : null;
  let topPicks = cachedIntel?.gameIdsKey === idsKey ? cachedIntel.topPicks : null;

  if (!intelMap || !topPicks) {
    // Fetch ESPN news, weather, signals across all sports, and WC injuries in parallel.
    // This is expensive enough that it should be cached for navigation. The board
    // remains usable from odds cache immediately while this layer refreshes on TTL.
    const [newsItems, weatherMap, nbaSignals, mlbSignals, soccerInjuryMap] = await Promise.all([
      withTimeout(fetchAllESPNNews(), 5_000, []),
      withTimeout(fetchWeatherForGames(games), 6_000, new Map()),
      withTimeout(Promise.resolve(fetchModelSignals()), 5_000, []),
      withTimeout(Promise.resolve(fetchMLBSignals()),   4_000, []),
      // General Sportmonks injury feed (all soccer — WC nations + clubs).
      // Read-only; populated by /api/ops/soccer/refresh-injuries.
      withTimeout(Promise.resolve(fetchSoccerInjuries()), 8_000, new Map()),
    ]);
    // Cross-sport signal stream — soccer intentionally excluded until model ships.
    const modelSignals = [...nbaSignals, ...mlbSignals];

    intelMap = generateIntelMap(games, newsItems, weatherMap, movementMap, modelSignals, soccerInjuryMap);
    topPicks = generateLivePicks(games, 5);
    await serverCache.set(BOARD_INTEL_KEY, { gameIdsKey: idsKey, intelMap, topPicks, generatedAt: new Date().toISOString() }, games);
  }

  // Inject the grounded ACE Take per game (agent override preferred, rule-engine
  // fallback). Read-only overlay on the intel map — a cheap pair of Redis GETs,
  // never persisted, so it stays fresh as takes update independently of intel.
  const [agentTakes, engineTakes] = await Promise.all([
    getAgentTakesPayload().catch(() => null),
    getMatchTakesPayload().catch(() => null),
  ]);
  const takeIntel: Record<string, any> = { ...intelMap };
  for (const g of games) {
    const t = agentTakes?.games?.[g.id] ?? engineTakes?.games?.[g.id];
    const head = headlineTake(t);
    if (head) takeIntel[g.id] = { ...(takeIntel[g.id] ?? {}), ace_take: head };
  }

  return (
    <DashboardShell
      games={games}
      intelMap={takeIntel}
      boardUpdatedAt={fetchedAt}
      topPicks={topPicks}
    />
  );
}
