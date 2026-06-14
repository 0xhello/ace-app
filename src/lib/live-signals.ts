// Generates the intelMap passed to DashboardShell from real ESPN news + odds data.
// Replaces the Python backend's /intel/board endpoint.

import { Game } from "@/types/game";
import { ESPNNewsItem, extractInjuryContext, InjuryStatus } from "@/lib/espn";
import { WeatherData } from "@/lib/weather";
import { computeConfidence, computeRecommendation, ConfidenceResult, RecommendationResult } from "@/lib/confidence";
import { ModelSignal } from "@/lib/model-signals";
import { noVigProb } from "@/lib/edge";
import { type AceLean } from "@/lib/ace-leans";
import type { Signal } from "@/types/signal";

export interface GameSignal {
  type: "injury" | "lineup" | "market" | "news" | "trade" | "weather" | "model";
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  time: string;
  benefits?: string[];
  harms?: string[];
  // Injury-specific enrichment
  playerName?: string | null;
  playerStatus?: InjuryStatus | null;
  teamAffected?: "home" | "away" | null;
}

export interface InjuryAlert {
  playerName: string;
  status: InjuryStatus;
  teamAffected: "home" | "away";
  teamName: string;
  published: string;
}

export interface GameIntel {
  game_id: string;
  signals_count: number;
  has_high_severity: boolean;
  is_volatile: boolean;
  has_new_signal: boolean;
  signals: GameSignal[];
  top_signal: Signal | null;
  // Pre-extracted injury alerts with player names
  injury_alerts: InjuryAlert[];
  // Python model signal context (if any)
  top_model_signal: {
    signal_type: string;
    bet_side: "home" | "away";
    edge_vs_pinnacle: number | null;
    line_at_signal: number | null;
    kelly_fraction: number | null;
  } | null;
  // No-vig true probability for home team (market consensus, juice stripped)
  no_vig_home_prob: number | null;
  // Real confidence + recommendation from confidence.ts
  confidence: ConfidenceResult;
  recommendation: RecommendationResult | null;
  // Weather (null for indoor sports)
  weather: WeatherData | null;
  // Server-side line movement for this game
  movement: Record<string, "up" | "down" | null> | undefined;
  // ACE Signal (lean): price-gap-triggered + evidence-corroborated, or null.
  // Scarce by design — most games have none. Confidence is empirical (tier
  // records graded by the CLV ledger), never cosmetic.
  ace_lean: AceLean | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}

function isRecent(iso: string, withinHours = 6): boolean {
  return Date.now() - new Date(iso).getTime() < withinHours * 3_600_000;
}

// Returns the unique team nickname (last word, e.g. "Yankees", "Lakers")
function teamNickname(name: string): string {
  return name.split(" ").pop()!.toLowerCase();
}

// Reconcile nation-name differences between the board (Odds API) and ESPN —
// e.g. board "USA" vs ESPN "United States" — so news still attaches. Both
// variants map to one canonical key. (normTeam is hoisted, defined below.)
const NEWS_ALIASES: Record<string, string> = {
  "usa": "usa", "united states": "usa",
  "south korea": "korea republic", "korea republic": "korea republic",
  "ivory coast": "cote d'ivoire", "cote d'ivoire": "cote d'ivoire",
  "turkey": "turkiye", "turkiye": "turkiye",
  "czechia": "czech republic", "czech republic": "czech republic",
};
function newsAlias(name: string): string {
  const k = normTeam(name);
  return NEWS_ALIASES[k] ?? k;
}

// Match ESPN news items to a game using team nicknames, not word fragments.
// Word-fragment matching ("york" from "New York X") leaks across same-city teams.
function matchNewsToGame(game: Game, items: ESPNNewsItem[]): ESPNNewsItem[] {
  const homeFull = game.home_team.toLowerCase();
  const awayFull = game.away_team.toLowerCase();
  const homeNick = teamNickname(game.home_team);
  const awayNick = teamNickname(game.away_team);
  const homeAlias = newsAlias(game.home_team);
  const awayAlias = newsAlias(game.away_team);

  return items.filter((item) => {
    if (game.sport.split("_")[0] !== item.sport_key.split("_")[0]) return false;

    // Primary: match via ESPN's team category tags (full name, nickname, or
    // reconciled nation alias).
    if (item.teams.length > 0) {
      return item.teams.some((t) => {
        const full = t.toLowerCase();
        const nick = teamNickname(t);
        const al = newsAlias(t);
        return full === homeFull || full === awayFull || nick === homeNick || nick === awayNick
            || al === homeAlias || al === awayAlias;
      });
    }

    // Fallback: whole-word nickname search in headline/description only
    const text = `${item.headline} ${item.description}`.toLowerCase();
    return (homeNick.length >= 4 && new RegExp(`\\b${homeNick}\\b`).test(text)) ||
           (awayNick.length >= 4 && new RegExp(`\\b${awayNick}\\b`).test(text));
  });
}

// Detect spread disagreement across books — proxy for sharp / delayed line movement
function detectSpreadDisagreement(game: Game): GameSignal | null {
  const spreads = game.bookmakers.flatMap((b) =>
    (b.markets.spreads ?? [])
      .filter((o) => o.name === game.away_team && o.point !== undefined)
      .map((o) => o.point as number)
  );
  if (spreads.length < 2) return null;
  const range = Math.max(...spreads) - Math.min(...spreads);
  if (range < 1.5) return null;

  return {
    type: "market",
    severity: range >= 3 ? "high" : "medium",
    title: `Book disagreement on ${game.away_team} spread (${range.toFixed(1)} pts)`,
    detail: `${game.bookmakers.length} books show spread range of ${Math.min(...spreads)} to ${Math.max(...spreads)} — possible sharp action or delayed update.`,
    time: "now",
  };
}

// Detect heavy ML consensus across books
function detectMLConsensus(game: Game): GameSignal | null {
  const awayPrices = game.bookmakers.flatMap((b) =>
    (b.markets.h2h ?? []).filter((o) => o.name === game.away_team).map((o) => o.price)
  );
  const homePrices = game.bookmakers.flatMap((b) =>
    (b.markets.h2h ?? []).filter((o) => o.name === game.home_team).map((o) => o.price)
  );
  if (!awayPrices.length || !homePrices.length) return null;

  const avgAway = awayPrices.reduce((a, b) => a + b, 0) / awayPrices.length;
  const avgHome = homePrices.reduce((a, b) => a + b, 0) / homePrices.length;
  const favoredPrice = Math.min(avgAway, avgHome);
  if (favoredPrice > -200) return null;

  const favoredTeam = avgAway < avgHome ? game.away_team : game.home_team;
  const impliedPct = Math.round((Math.abs(favoredPrice) / (Math.abs(favoredPrice) + 100)) * 100);

  return {
    type: "model",
    severity: "medium",
    title: `${favoredTeam} implied at ${impliedPct}% across ${game.bookmakers.length} books`,
    detail: "Heavy consensus across all major sportsbooks. Market confidence is high — monitor for line movement closer to tip.",
    time: "now",
    benefits: [favoredTeam],
  };
}

// Convert weather data into a signal
function weatherSignal(weather: WeatherData): GameSignal | null {
  if (weather.impact === "none") return null;
  return {
    type: "weather",
    severity: weather.impact === "high" ? "high" : weather.impact === "moderate" ? "medium" : "low",
    title: `${weather.impact === "high" ? "Severe" : weather.impact === "moderate" ? "Moderate" : "Minor"} weather conditions`,
    detail: `${weather.detail}${weather.total_modifier <= -4 ? " — significant under pressure." : "."}`,
    time: "now",
    benefits: weather.total_modifier <= -3 ? ["Under total", "Defense-first teams"] : [],
    harms: weather.total_modifier <= -3 ? ["Over total", "High-scoring offenses"] : [],
  };
}

function gameSignalToSignal(gs: GameSignal, gameId: string, idx: number): Signal {
  return {
    id: `live-${gameId}-${idx}`,
    gameId,
    type: gs.type as Signal["type"],
    severity: gs.severity,
    certainty: "confirmed",
    affectedTeam: "neutral",
    direction: gs.severity === "high" ? "negative" : "uncertain",
    summary: gs.title,
    details: gs.detail,
    benefits: gs.benefits ?? [],
    harms: gs.harms ?? [],
    sourceCategory: gs.type === "model" ? "market" : gs.type === "weather" ? "weather" : gs.type === "news" ? "ai" : "market",
    isForced: false,
    isDemo: false,
    createdAt: new Date().toISOString(),
  };
}

function modelSignalLineValue(s: ModelSignal): number | null {
  if (s.line_at_signal == null) return null;
  return s.bet_side === "home" ? s.line_at_signal : -s.line_at_signal;
}

function modelSignalSideLabel(s: ModelSignal): string {
  return s.bet_side === "home" ? s.home_team : s.away_team;
}

function formatModelSignalLine(s: ModelSignal): string | null {
  const line = modelSignalLineValue(s);
  if (line == null) return null;
  return `${line > 0 ? "+" : ""}${line}`;
}

function formatEdgePct(edge: number | null | undefined): string | null {
  if (edge == null) return null;
  return `${edge >= 0 ? "+" : ""}${(edge * 100).toFixed(1)}%`;
}

const SIGNAL_TYPE_LABELS: Record<string, { title: string; detail: (s: ModelSignal) => string }> = {
  soft_book_divergence: {
    title: "ACE: Soft-book divergence from Pinnacle",
    detail: (s) => `Model flagged a line discrepancy versus Pinnacle on ${modelSignalSideLabel(s)} spread${formatModelSignalLine(s) ? ` (${formatModelSignalLine(s)})` : ""}.${formatEdgePct(s.edge_vs_pinnacle) ? ` Edge vs Pinnacle: ${formatEdgePct(s.edge_vs_pinnacle)}.` : ""}${s.kelly_fraction != null && s.kelly_fraction > 0 ? ` Kelly: ${(s.kelly_fraction * 100).toFixed(1)}%.` : ""}`,
  },
  line_movement: {
    title: "ACE: Line movement detected",
    detail: (s) => `Model detected significant line movement on ${modelSignalSideLabel(s)}${formatModelSignalLine(s) ? ` (signal line: ${formatModelSignalLine(s)})` : ""}.`,
  },
  steam_move: {
    title: "ACE: Steam move — sharp action",
    detail: (s) => `Rapid line movement consistent with sharp/syndicate betting on ${modelSignalSideLabel(s)}${formatModelSignalLine(s) ? ` at ${formatModelSignalLine(s)}` : ""}.`,
  },
};

function modelSignalToGameSignal(s: ModelSignal): GameSignal {
  const edge = s.edge_vs_pinnacle ?? 0;
  const tmpl = SIGNAL_TYPE_LABELS[s.signal_type] ?? {
    title: `ACE: ${s.signal_type.replace(/_/g, " ")}`,
    detail: (ms: ModelSignal) => `Model signal on ${modelSignalSideLabel(ms)}${formatModelSignalLine(ms) ? ` at line ${formatModelSignalLine(ms)}` : ""}.`,
  };
  return {
    type: "model",
    severity: edge >= 3 ? "high" : edge >= 1 ? "medium" : "low",
    title: tmpl.title,
    detail: tmpl.detail(s),
    time: "now",
    benefits: [s.bet_side === "home" ? "home" : "away"],
  };
}

// Determine which team (home/away) an ESPN news item is about.
// Uses full name or unique nickname — never partial words like "york".
function matchTeamAffected(itemTeams: string[], homeTeam: string, awayTeam: string): "home" | "away" | null {
  if (!itemTeams.length) return null;
  const homeFull = homeTeam.toLowerCase();
  const awayFull = awayTeam.toLowerCase();
  const homeNick = teamNickname(homeTeam);
  const awayNick = teamNickname(awayTeam);
  for (const t of itemTeams) {
    const full = t.toLowerCase();
    const nick = teamNickname(t);
    if (full === homeFull || nick === homeNick) return "home";
    if (full === awayFull || nick === awayNick) return "away";
  }
  return null;
}

// Compute no-vig home win probability averaged across all books
function computeNoVigHomeProb(game: Game): number | null {
  const probs: number[] = [];
  for (const bm of game.bookmakers) {
    const homeOdds = bm.markets.h2h?.find((o) => o.name === game.home_team)?.price;
    const awayOdds = bm.markets.h2h?.find((o) => o.name === game.away_team)?.price;
    if (homeOdds == null || awayOdds == null) continue;
    const [homeProb] = noVigProb(homeOdds, awayOdds);
    probs.push(homeProb);
  }
  if (!probs.length) return null;
  return Math.round((probs.reduce((a, b) => a + b, 0) / probs.length) * 10) / 10;
}

// Extract structured injury alerts from matched ESPN items
function buildInjuryAlerts(matched: ESPNNewsItem[], game: Game): InjuryAlert[] {
  const alerts: InjuryAlert[] = [];
  const seen = new Set<string>();

  for (const item of matched) {
    if (item.type !== "injury") continue;
    const ctx = extractInjuryContext(item.headline, item.description);
    if (!ctx.playerName || !ctx.status) continue;

    const key = `${ctx.playerName}-${ctx.status}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const teamAffected = matchTeamAffected(item.teams, game.home_team, game.away_team);
    if (!teamAffected) continue;

    alerts.push({
      playerName: ctx.playerName,
      status: ctx.status,
      teamAffected,
      teamName: teamAffected === "home" ? game.home_team : game.away_team,
      published: item.published,
    });
  }

  // Sort: out > suspended > doubtful > questionable > game-time > day-to-day
  const ORDER: InjuryStatus[] = ["out", "suspended", "doubtful", "questionable", "game-time", "day-to-day"];
  return alerts.sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
}

// ── WC injury merge ───────────────────────────────────────────────────────────

function isSoccerGame(game: Game): boolean {
  return (game.sport || "").toLowerCase().startsWith("soccer")
    || (game.sport_title || "").toLowerCase().includes("world cup");
}

// Normalize a team name the same way ml/soccer/injuries.py `_norm` does, so
// loader keys (name_norm) line up with the board's team names regardless of
// accents / casing / ampersands.
function normTeam(s: string): string {
  return (s || "")
    .normalize("NFKD").replace(new RegExp("[\\u0300-\\u036f]", "g"), "")
    .toLowerCase().replace(/&/g, "and")
    .split(/\s+/).filter(Boolean).join(" ");
}

// Merge the general soccer injury feed (Sportmonks `sidelined`, any soccer
// team — WC nations + clubs) onto a soccer game's injury alerts.
function mergeSoccerInjuries(
  base: InjuryAlert[],
  game: Game,
  soccerInjuryMap: Map<string, Array<{ team_name: string; player_name: string; status: "out" | "suspended" | "questionable"; reason: string | null }>> | null,
): InjuryAlert[] {
  if (!soccerInjuryMap || !isSoccerGame(game)) return base;

  const home = normTeam(game.home_team);
  const away = normTeam(game.away_team);
  const homeInj = soccerInjuryMap.get(home) || [];
  const awayInj = soccerInjuryMap.get(away) || [];

  const wcAlerts: InjuryAlert[] = [];
  for (const i of homeInj) {
    wcAlerts.push({
      playerName: i.player_name,
      status: i.status as InjuryStatus,
      teamAffected: "home",
      teamName: game.home_team,
      published: new Date().toISOString(),
    });
  }
  for (const i of awayInj) {
    wcAlerts.push({
      playerName: i.player_name,
      status: i.status as InjuryStatus,
      teamAffected: "away",
      teamName: game.away_team,
      published: new Date().toISOString(),
    });
  }

  const ORDER: InjuryStatus[] = ["out", "suspended", "doubtful", "questionable", "game-time", "day-to-day"];
  return [...base, ...wcAlerts].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
}

// ── Main export ────────────────────────────────────────────────────────────────

export function generateIntelMap(
  games: Game[],
  newsItems: ESPNNewsItem[],
  weatherMap: Map<string, WeatherData>,
  movementMap: Record<string, Record<string, "up" | "down" | null>>,
  modelSignals: ModelSignal[] = [],
  soccerInjuryMap: Map<string, Array<{ team_name: string; player_name: string; status: "out" | "suspended" | "questionable"; reason: string | null }>> | null = null,
): Record<string, GameIntel> {
  const result: Record<string, GameIntel> = {};

  for (const game of games) {
    if (game.status === "final") continue;

    const signals: GameSignal[] = [];
    const weather = weatherMap.get(game.id) ?? null;
    const movement = movementMap[game.id];

    // 1. ESPN news signals — enriched with player name extraction.
    // Rank for the hook: SPECIFIC, recent stories win. A story tagged to many
    // teams ("Squad lists for all 48 teams" = 48 tags) is generic/league-wide —
    // demote it and never let it become the hook. Verified: ~29/40 WC articles
    // are specific (1-2 teams); only the few generic ones blanket the board.
    const matched = matchNewsToGame(game, newsItems);
    const GENERIC_NEWS_TEAMS = 4;
    const genericHeadlines = new Set(
      matched.filter((m) => (m.teams?.length ?? 0) >= GENERIC_NEWS_TEAMS).map((m) => m.headline),
    );
    matched.sort((a, b) => {
      const ta = a.teams?.length || 99, tb = b.teams?.length || 99;
      const ga = ta >= GENERIC_NEWS_TEAMS ? 1 : 0, gb = tb >= GENERIC_NEWS_TEAMS ? 1 : 0;
      if (ga !== gb) return ga - gb;                 // non-generic first
      if (ta !== tb) return ta - tb;                 // fewer teams = more specific
      return new Date(b.published).getTime() - new Date(a.published).getTime(); // then most recent
    });
    for (const item of matched) {
      const isInjury = item.type === "injury";
      const injCtx = isInjury ? extractInjuryContext(item.headline, item.description) : null;
      const teamAffected = matchTeamAffected(item.teams, game.home_team, game.away_team);

      const title = injCtx?.playerName
        ? `${injCtx.playerName} — ${injCtx.status === "out" ? "OUT" : injCtx.status === "doubtful" ? "Doubtful" : injCtx.status === "questionable" ? "Questionable" : injCtx.status === "game-time" ? "Game-time decision" : "Day-to-day"}`
        : item.headline;

      signals.push({
        type: item.type === "trade" ? "news" : item.type,
        severity: item.severity,
        title,
        detail: item.description,
        time: timeAgo(item.published),
        playerName: injCtx?.playerName ?? null,
        playerStatus: injCtx?.status ?? null,
        teamAffected: teamAffected ?? null,
        benefits: teamAffected ? [teamAffected === "home" ? game.away_team : game.home_team] : [],
        harms: teamAffected ? [teamAffected === "home" ? game.home_team : game.away_team] : [],
      });
    }

    // 2. Weather signal
    if (weather) {
      const ws = weatherSignal(weather);
      if (ws) signals.push(ws);
    }

    // 3. Spread disagreement (market movement proxy)
    const spreadSignal = detectSpreadDisagreement(game);
    if (spreadSignal) signals.push(spreadSignal);

    // 4. Heavy ML consensus
    const mlSignal = detectMLConsensus(game);
    if (mlSignal) signals.push(mlSignal);

    // 5. Python backend model signals (signal_log.db — soft_book_divergence, line_movement, steam_move)
    const homeNorm = game.home_team.toLowerCase().trim();
    const awayNorm = game.away_team.toLowerCase().trim();
    let topModelSignal: GameIntel["top_model_signal"] = null;
    for (const ms of modelSignals) {
      if (ms.home_team.toLowerCase().trim() === homeNorm && ms.away_team.toLowerCase().trim() === awayNorm) {
        signals.push(modelSignalToGameSignal(ms));
        // Keep highest-edge model signal as top_model_signal
        if (!topModelSignal || (ms.edge_vs_pinnacle ?? 0) > (topModelSignal.edge_vs_pinnacle ?? 0)) {
          topModelSignal = {
            signal_type: ms.signal_type,
            bet_side: ms.bet_side,
            edge_vs_pinnacle: ms.edge_vs_pinnacle,
            line_at_signal: ms.line_at_signal,
            kelly_fraction: ms.kelly_fraction,
          };
        }
      }
    }

    // ACE Signal (lean): price-gap trigger + evidence corroboration, tiered.
    // Computed before top-signal selection so it can lead the feed. Injuries
    // are passed per side so the engine can credit opposing-team absences.
    const mergedInjuryAlerts = mergeSoccerInjuries(buildInjuryAlerts(matched, game), game, soccerInjuryMap);
    // ACE picks on the board now come from the grounded takes engine/agent
    // (ace_take, injected in GamesFeed), not the retired de-vig ACE Signal.

    // Compute real confidence + recommendation
    const confidence = computeConfidence(game, signals, weather, movement);
    const recommendation = computeRecommendation(game, signals, weather, movement, confidence);

    // Only include games that have at least some signal OR meaningful odds
    const hasOdds = game.bookmakers.length >= 2;
    if (signals.length === 0 && !hasOdds) continue;

    const hasHigh = signals.some((s) => s.severity === "high");
    const hasNew = signals.some((s) => s.time === "now" || (s.time.endsWith("m") && parseInt(s.time) < 120));
    const recentNews = matched.filter((n) => isRecent(n.published, 6));

    // Prefer non-injury signals for the hook — injuries are shown as badges.
    // Never let a generic league-wide news article be the hook (better to show
    // nothing than "Squad lists for all 48 teams" on every game). Signals are
    // already ordered specific-first by the news ranking above.
    const eligible = signals.filter((s) => !(s.type === "news" && genericHeadlines.has(s.title)));
    const nonInjury = eligible.filter((s) => s.type !== "injury");
    const topGs = nonInjury.find((s) => s.severity === "high")
      ?? nonInjury.find((s) => s.severity === "medium")
      ?? nonInjury[0]
      ?? eligible.find((s) => s.severity === "high")
      ?? eligible[0]
      ?? null;

    result[game.id] = {
      game_id: game.id,
      signals_count: signals.length,
      has_high_severity: hasHigh,
      is_volatile: hasHigh || signals.length >= 3,
      has_new_signal: hasNew || recentNews.length > 0,
      signals,
      top_signal: topGs ? gameSignalToSignal(topGs, game.id, 0) : null,
      injury_alerts: mergedInjuryAlerts,
      top_model_signal: topModelSignal,
      no_vig_home_prob: computeNoVigHomeProb(game),
      confidence,
      recommendation,
      weather,
      movement,
      ace_lean: null,
    };
  }

  return result;
}
