import { Game, BookOdds, MarketOutcome } from "@/types/game";

const BASE = "https://api.the-odds-api.com/v4";

// Books to pull — ordered by priority
const BOOKS = "fanduel,draftkings,betmgm,caesars,pointsbet,bet365";
const MARKETS = "h2h,spreads,totals";

// All sports ACE monitors. The API returns [] for off-season sports — no wasted credits.
export const SPORT_KEYS = [
  "basketball_nba",
  "baseball_mlb",
  "icehockey_nhl",
  "americanfootball_nfl",
  "basketball_ncaab",
  "americanfootball_ncaaf",
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
  if (remaining) console.log(`[odds-api] quota: ${used} used, ${remaining} remaining`);

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
  const sports = [...SPORT_KEYS];

  // Fetch odds + scores for all sports in parallel
  const [oddsResults, scoreResults] = await Promise.all([
    Promise.all(sports.map((s) => fetchOddsForSportSafe(s))),
    Promise.all(sports.map((s) => fetchScoresForSport(s))),
  ]);

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

  for (const result of oddsResults) {
    for (const raw of result.data) {
      try {
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
