// ESPN public API — no auth required.
// Used for live scores and news/injury signals.

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports";

// Odds API sport key → ESPN sport/league path
const SPORT_MAP: Record<string, { sport: string; league: string }> = {
  basketball_nba:        { sport: "basketball",  league: "nba" },
  baseball_mlb:          { sport: "baseball",    league: "mlb" },
  icehockey_nhl:         { sport: "hockey",      league: "nhl" },
  americanfootball_nfl:  { sport: "football",    league: "nfl" },
  basketball_ncaab:      { sport: "basketball",  league: "mens-college-basketball" },
  americanfootball_ncaaf:{ sport: "football",    league: "college-football" },
};

async function espnFetch(url: string): Promise<any> {
  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
      headers: { "Accept": "application/json" },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

// ── News ───────────────────────────────────────────────────────────────────────

export interface ESPNNewsItem {
  headline: string;
  description: string;
  published: string;
  sport_key: string;
  teams: string[];        // team display names from categories
  type: "injury" | "lineup" | "trade" | "news";
  severity: "high" | "medium" | "low";
}

function classifyArticle(headline: string, desc: string): { type: ESPNNewsItem["type"]; severity: ESPNNewsItem["severity"] } {
  const text = `${headline} ${desc}`.toLowerCase();
  if (/\bruled? out\b|season[- ]ending|placed on il|placed on ir|out indefinitely/.test(text))
    return { type: "injury", severity: "high" };
  if (/\binjur|doubtful|questionable|status|concussion|knee|ankle|hamstring/.test(text))
    return { type: "injury", severity: "medium" };
  if (/\blineup|starter|starting|sits out|benched|recalled|activated|demoted/.test(text))
    return { type: "lineup", severity: "medium" };
  if (/\btrade|sign|release|waive|cut|deal/.test(text))
    return { type: "trade", severity: "low" };
  return { type: "news", severity: "low" };
}

export async function fetchESPNNews(sportKey: string, limit = 12): Promise<ESPNNewsItem[]> {
  const config = SPORT_MAP[sportKey];
  if (!config) return [];

  const url = `${ESPN_BASE}/${config.sport}/${config.league}/news?limit=${limit}`;
  const data = await espnFetch(url);
  if (!data?.articles) return [];

  return data.articles.slice(0, limit).map((a: any): ESPNNewsItem => {
    const headline = a.headline ?? a.title ?? "";
    const desc = a.description ?? a.summary ?? "";
    const { type, severity } = classifyArticle(headline, desc);

    const teams: string[] = (a.categories ?? [])
      .filter((c: any) => c.type === "team" && c.description)
      .map((c: any) => c.description as string);

    return { headline, description: desc, published: a.published ?? new Date().toISOString(), sport_key: sportKey, teams, type, severity };
  });
}

export async function fetchAllESPNNews(): Promise<ESPNNewsItem[]> {
  const results = await Promise.all(
    Object.keys(SPORT_MAP).map((k) => fetchESPNNews(k, 10))
  );
  return results
    .flat()
    .sort((a, b) => new Date(b.published).getTime() - new Date(a.published).getTime());
}

// ── Scoreboard (live scores supplement) ────────────────────────────────────────

export interface ESPNScore {
  id: string;          // ESPN event ID (not the Odds API ID — used for matching by team name)
  homeTeam: string;
  awayTeam: string;
  homeScore: number | null;
  awayScore: number | null;
  status: "pre" | "in" | "post";
  clock: string | null;
  period: number | null;
  sport_key: string;
}

function parseESPNCompetitor(c: any) {
  return {
    team: c.team?.displayName ?? c.team?.shortDisplayName ?? "",
    score: c.score !== undefined ? Number(c.score) : null,
    homeAway: c.homeAway as "home" | "away",
  };
}

export async function fetchESPNScoreboard(sportKey: string): Promise<ESPNScore[]> {
  const config = SPORT_MAP[sportKey];
  if (!config) return [];

  const url = `${ESPN_BASE}/${config.sport}/${config.league}/scoreboard`;
  const data = await espnFetch(url);
  if (!data?.events) return [];

  return data.events.map((event: any): ESPNScore => {
    const comp = event.competitions?.[0];
    const competitors = (comp?.competitors ?? []).map(parseESPNCompetitor);
    const home = competitors.find((c: any) => c.homeAway === "home");
    const away = competitors.find((c: any) => c.homeAway === "away");

    const statusType = comp?.status?.type?.name ?? "STATUS_SCHEDULED";
    let status: ESPNScore["status"] = "pre";
    if (statusType.includes("IN_PROGRESS") || statusType.includes("HALFTIME")) status = "in";
    else if (statusType.includes("FINAL") || statusType.includes("COMPLETE")) status = "post";

    return {
      id: event.id,
      homeTeam: home?.team ?? "",
      awayTeam: away?.team ?? "",
      homeScore: home?.score ?? null,
      awayScore: away?.score ?? null,
      status,
      clock: comp?.status?.displayClock ?? null,
      period: comp?.status?.period ?? null,
      sport_key: sportKey,
    };
  });
}
