import { Game, BookOdds, MarketOutcome } from "@/types/game";
import { getActiveSports, setActiveSports, set as cacheSet, writeOddsQuota } from "@/lib/server-cache";

const BASE = "https://api.the-odds-api.com/v4";

// Books to pull — ordered by priority
const BOOKS = "fanduel,draftkings,betmgm,caesars,pointsbet,bet365";
const MARKETS = "h2h,spreads,totals";

// All sports ACE monitors. The API returns [] for off-season sports — no wasted credits.
// Soccer set is intentionally narrow during the WC window: the tournament itself
// plus two leagues that overlap (UCL final, MLS regular season). Expand post-WC
// if we want full year-round soccer coverage.
export const SPORT_KEYS = [
  "basketball_nba",
  "baseball_mlb",
  "icehockey_nhl",
  "americanfootball_nfl",
  "basketball_ncaab",
  "americanfootball_ncaaf",
  "soccer_fifa_world_cup",
  "soccer_uefa_champs_league",
  "soccer_usa_mls",
  // European Big 5 — added for the pre-WC pipeline. Active-sports cache
  // (60-min refresh) will silently drop those that are off-season; off-season
  // sport keys return 422 from Odds API at zero credit cost.
  "soccer_epl",
  "soccer_spain_la_liga",
  "soccer_germany_bundesliga",
  "soccer_italy_serie_a",
  "soccer_france_ligue_one",
] as const;

export type SportKey = (typeof SPORT_KEYS)[number];

// ── Core fetch ─────────────────────────────────────────────────────────────────

async function apiFetch(path: string, extra?: Record<string, string>): Promise<any> {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) throw new Error("ODDS_API_KEY not configured");

  const url = new URL(`${BASE}${path}`);
  url.searchParams.set("apiKey", apiKey);
  if (extra) Object.entries(extra).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString(), {
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  });

  if (res.status === 401) throw new Error("ODDS_API_KEY is invalid or expired");
  if (res.status === 422) return []; // sport not found / off season
  if (res.status === 429) throw new Error("Odds API quota exceeded");
  if (!res.ok) throw new Error(`Odds API ${res.status} on ${path}`);

  // Log remaining quota from headers
  const remaining = res.headers.get("x-requests-remaining");
  const used = res.headers.get("x-requests-used");
  const last = res.headers.get("x-requests-last");
  if (remaining) console.log(`[odds-api] quota: ${used} used, ${remaining} remaining`);

  // Persist latest quota to Redis so /api/ops/odds-quota can surface it
  // without an extra paid call. Best-effort — never block the caller.
  if (remaining && used) {
    writeOddsQuota({
      remaining: parseInt(remaining, 10),
      used:      parseInt(used, 10),
      last_cost: last ? parseInt(last, 10) : null,
      source:    "nextjs",
      endpoint:  path,
      seen_at:   Date.now(),
    }).catch(() => {});
  }

  return res.json();
}

// ── Per-sport fetchers ─────────────────────────────────────────────────────────

export async function fetchOddsForSport(sportKey: string): Promise<any[]> {
  return (await fetchOddsForSportSafe(sportKey)).data;
}

export async function fetchScoresForSport(sportKey: string): Promise<any[]> {
  try {
    return await apiFetch(`/sports/${sportKey}/scores`, { daysFrom: "1" });
  } catch (e: any) {
    console.error(`[odds-api] scores fetch failed for ${sportKey}:`, e.message);
    return [];
  }
}

// ── Transform ──────────────────────────────────────────────────────────────────

function transformBookmaker(b: any): BookOdds {
  const markets: BookOdds["markets"] = {};
  for (const m of (b.markets ?? [])) {
    const outcomes: MarketOutcome[] = (m.outcomes ?? []).map((o: any) => ({
      name: o.name,
      price: o.price,
      ...(o.point !== undefined ? { point: o.point } : {}),
    }));
    if (m.key === "h2h") markets.h2h = outcomes;
    else if (m.key === "spreads") markets.spreads = outcomes;
    else if (m.key === "totals") markets.totals = outcomes;
  }
  return { sportsbook: b.key, title: b.title, last_update: b.last_update, markets };
}

function bestPrice(bookmakers: BookOdds[], team: string): number | null {
  const prices = bookmakers.flatMap((b) =>
    (b.markets.h2h ?? []).filter((o) => o.name === team).map((o) => o.price)
  );
  return prices.length ? Math.max(...prices) : null;
}

export function transformGame(raw: any, scoreMap: Map<string, any>): Game {
  const score = scoreMap.get(raw.id);
  const now = Date.now();
  const startMs = new Date(raw.commence_time).getTime();

  let status: Game["status"] = "upcoming";
  if (score?.completed) {
    status = "final";
  } else if (score?.scores && startMs <= now) {
    status = "live";
  } else if (startMs <= now) {
    // Game has started but no score data available — estimate from elapsed time
    status = (now - startMs > 4 * 3_600_000) ? "final" : "live";
  }

  const bookmakers = (raw.bookmakers ?? []).map(transformBookmaker);

  const awayBest = bestPrice(bookmakers, raw.away_team);
  const homeBest = bestPrice(bookmakers, raw.home_team);
  const best_moneyline: Record<string, number> = {};
  if (awayBest !== null) best_moneyline[raw.away_team] = awayBest;
  if (homeBest !== null) best_moneyline[raw.home_team] = homeBest;

  let scoreboard: Game["scoreboard"] | undefined;
  if (score?.scores) {
    const find = (name: string) => score.scores?.find((s: any) => s.name === name)?.score ?? null;
    scoreboard = {
      state: score.completed ? "post" : "in",
      away_score: find(raw.away_team),
      home_score: find(raw.home_team),
    };
  }

  return {
    id: raw.id,
    sport: raw.sport_key,
    sport_title: raw.sport_title,
    home_team: raw.home_team,
    away_team: raw.away_team,
    commence_time: raw.commence_time,
    status,
    bookmakers,
    best_moneyline,
    num_books: bookmakers.length,
    fetched_at: new Date().toISOString(),
    scoreboard,
  };
}

// ── Main export ────────────────────────────────────────────────────────────────

// Returns { data, error } — error is null on success
async function fetchOddsForSportSafe(sportKey: string): Promise<{ data: any[]; error: string | null }> {
  try {
    const data = await apiFetch(`/sports/${sportKey}/odds`, {
      regions: "us",
      markets: MARKETS,
      oddsFormat: "american",
      bookmakers: BOOKS,
    });
    return { data, error: null };
  } catch (e: any) {
    console.error(`[odds-api] odds fetch failed for ${sportKey}:`, e.message);
    return { data: [], error: e.message };
  }
}

export async function fetchAllGames(): Promise<{
  games: Game[];
  errors: string[];
  fetchedAt: string;
}> {
  // Step 1: resolve which sports to fetch.
  // Track which sports returned games; only re-fetch those until an hourly full refresh.
  // During NBA playoffs this cuts fetches from 6 sports (18 credits) down to 1-2 (3-6 credits).
  const FULL_REFRESH_INTERVAL = 60 * 60_000; // 1 hour
  let sports: string[];
  try {
    const cached = await getActiveSports();
    if (cached && cached.sports.length > 0 && Date.now() - cached.setAt < FULL_REFRESH_INTERVAL) {
      sports = cached.sports;
    } else {
      sports = [...SPORT_KEYS];
    }
  } catch {
    sports = [...SPORT_KEYS];
  }

  const oddsResults = await Promise.all(sports.map((s) => fetchOddsForSportSafe(s)));

  // Update the active-sports list with whatever returned games this round
  try {
    const active = sports.filter((_, i) => oddsResults[i].data.length > 0);
    // Always keep at least the sports we just checked that had games;
    // if nothing came back (off-season?), fall back to full list next time
    await setActiveSports(active.length > 0 ? active : [...SPORT_KEYS]);
  } catch {}


  // Step 2: only call the scores endpoint for sports that have games within the last 4 hours.
  // The scores endpoint costs 1 credit per sport — skipping it when no games are live saves 6
  // credits per refresh (25% of total). Off-season sports already return 422 at zero cost.
  const now = Date.now();
  const LIVE_WINDOW_MS = 4 * 60 * 60 * 1000;
  const sportsNeedingScores = new Set<string>();
  for (let i = 0; i < sports.length; i++) {
    for (const raw of oddsResults[i].data) {
      const startMs = new Date(raw.commence_time).getTime();
      if (startMs <= now && startMs > now - LIVE_WINDOW_MS) {
        sportsNeedingScores.add(sports[i]);
        break;
      }
    }
  }

  const scoreResults = await Promise.all(
    sports.map((s) => sportsNeedingScores.has(s) ? fetchScoresForSport(s) : Promise.resolve([]))
  );

  // Write raw odds + scores to Redis so the Python workers can read them
  // without making their own API calls. Fire-and-forget — workers fall back
  // to a direct fetch if Redis is missing or stale (>25 min).
  //
  // Generic pattern: every sport key gets a `__raw_odds_<sport_key>__` entry.
  // The legacy short aliases (nba / wc / mlb) are kept so the existing Python
  // readers continue working without code changes. The Python soccer-leagues
  // module reads the long form directly (e.g. __raw_odds_soccer_epl__).
  const legacyAliases: Record<string, string> = {
    basketball_nba:         "__raw_odds_nba__",
    soccer_fifa_world_cup:  "__raw_odds_wc__",
    baseball_mlb:           "__raw_odds_mlb__",
  };
  const legacyScores: Record<string, string> = {
    basketball_nba:         "__raw_scores_nba__",
    soccer_fifa_world_cup:  "__raw_scores_wc__",
    baseball_mlb:           "__raw_scores_mlb__",
  };
  for (let i = 0; i < sports.length; i++) {
    const sportKey = sports[i];
    const data = oddsResults[i]?.data;
    if (data && data.length > 0) {
      // Generic key (the new pattern)
      cacheSet(`__raw_odds_${sportKey}__`, data).catch(() => {});
      // Legacy alias for backward compat with existing Python readers
      const alias = legacyAliases[sportKey];
      if (alias) cacheSet(alias, data).catch(() => {});
    }
    const scores = scoreResults[i];
    if (scores && scores.length > 0) {
      cacheSet(`__raw_scores_${sportKey}__`, scores).catch(() => {});
      const aliasS = legacyScores[sportKey];
      if (aliasS) cacheSet(aliasS, scores).catch(() => {});
    }
  }

  // Build score lookup
  const scoreMap = new Map<string, any>();
  for (const batch of scoreResults) {
    for (const s of batch) scoreMap.set(s.id, s);
  }

  // Transform + collect
  const games: Game[] = [];
  const errors: string[] = [];

  // Surface any fetch-level errors (quota, auth, network)
  for (const result of oddsResults) {
    if (result.error) errors.push(result.error);
  }

  // Horizon filter — drop games more than HORIZON_DAYS out unless they're
  // live or recently completed. The Odds API surfaces full-season schedules
  // months in advance for NFL/MLB once published; showing September NFL
  // games on the May board is confusing UX. We still pay one API credit
  // either way (the response is the same), but the dashboard is cleaner.
  // Past games (live/final within 12h) are kept.
  const HORIZON_DAYS = 14;
  const horizonMs    = Date.now() + HORIZON_DAYS * 24 * 60 * 60 * 1000;
  const pastWindowMs = Date.now() - 12 * 60 * 60 * 1000;

  for (const result of oddsResults) {
    for (const raw of result.data) {
      try {
        const startMs = new Date(raw.commence_time).getTime();
        if (startMs > horizonMs)    continue; // too far in the future
        if (startMs < pastWindowMs) continue; // too far in the past
        games.push(transformGame(raw, scoreMap));
      } catch (e: any) {
        errors.push(e.message);
      }
    }
  }

  // Sort: live first, then ascending by start time
  games.sort((a, b) => {
    if (a.status === "live" && b.status !== "live") return -1;
    if (b.status === "live" && a.status !== "live") return 1;
    return new Date(a.commence_time).getTime() - new Date(b.commence_time).getTime();
  });

  return { games, errors, fetchedAt: new Date().toISOString() };
}
