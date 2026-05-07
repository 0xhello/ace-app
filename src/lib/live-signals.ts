// Generates the intelMap passed to DashboardShell from real ESPN news + odds data.
// Replaces the Python backend's /intel/board endpoint.

import { Game } from "@/types/game";
import { ESPNNewsItem, extractInjuryContext, InjuryStatus } from "@/lib/espn";
import { WeatherData } from "@/lib/weather";
import { computeConfidence, computeRecommendation, ConfidenceResult, RecommendationResult } from "@/lib/confidence";
import { ModelSignal } from "@/lib/model-signals";
import { noVigProb } from "@/lib/edge";
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

// Match ESPN news items to a game using team nicknames, not word fragments.
// Word-fragment matching ("york" from "New York X") leaks across same-city teams.
function matchNewsToGame(game: Game, items: ESPNNewsItem[]): ESPNNewsItem[] {
  const homeFull = game.home_team.toLowerCase();
  const awayFull = game.away_team.toLowerCase();
  const homeNick = teamNickname(game.home_team);
  const awayNick = teamNickname(game.away_team);

  return items.filter((item) => {
    if (game.sport.split("_")[0] !== item.sport_key.split("_")[0]) return false;

    // Primary: match via ESPN's team category tags (full name or unique nickname)
    if (item.teams.length > 0) {
      return item.teams.some((t) => {
        const full = t.toLowerCase();
        const nick = teamNickname(t);
        return full === homeFull || full === awayFull || nick === homeNick || nick === awayNick;
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

const SIGNAL_TYPE_LABELS: Record<string, { title: string; detail: (s: ModelSignal) => string }> = {
  soft_book_divergence: {
    title: "ACE: Soft-book divergence from Pinnacle",
    detail: (s) => `Model flagged a line discrepancy versus Pinnacle on the ${s.bet_side} spread${s.line_at_signal != null ? ` (line: ${s.line_at_signal > 0 ? "+" : ""}${s.line_at_signal})` : ""}.${s.edge_vs_pinnacle != null ? ` Edge vs Pinnacle: ${s.edge_vs_pinnacle.toFixed(1)}%.` : ""}${s.kelly_fraction != null && s.kelly_fraction > 0 ? ` Kelly: ${(s.kelly_fraction * 100).toFixed(1)}%.` : ""}`,
  },
  line_movement: {
    title: "ACE: Line movement detected",
    detail: (s) => `Model detected significant line movement on the ${s.bet_side} side${s.line_at_signal != null ? ` (signal line: ${s.line_at_signal > 0 ? "+" : ""}${s.line_at_signal})` : ""}.`,
  },
  steam_move: {
    title: "ACE: Steam move — sharp action",
    detail: (s) => `Rapid line movement consistent with sharp/syndicate betting on the ${s.bet_side}${s.line_at_signal != null ? ` at ${s.line_at_signal > 0 ? "+" : ""}${s.line_at_signal}` : ""}.`,
  },
};

function modelSignalToGameSignal(s: ModelSignal): GameSignal {
  const edge = s.edge_vs_pinnacle ?? 0;
  const tmpl = SIGNAL_TYPE_LABELS[s.signal_type] ?? {
    title: `ACE: ${s.signal_type.replace(/_/g, " ")}`,
    detail: (ms: ModelSignal) => `Model signal on ${ms.bet_side} side${ms.line_at_signal != null ? ` at line ${ms.line_at_signal}` : ""}.`,
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

  // Sort: out > doubtful > questionable > game-time > day-to-day
  const ORDER: InjuryStatus[] = ["out", "doubtful", "questionable", "game-time", "day-to-day"];
  return alerts.sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
}

// ── Main export ────────────────────────────────────────────────────────────────

export function generateIntelMap(
  games: Game[],
  newsItems: ESPNNewsItem[],
  weatherMap: Map<string, WeatherData>,
  movementMap: Record<string, Record<string, "up" | "down" | null>>,
  modelSignals: ModelSignal[] = []
): Record<string, GameIntel> {
  const result: Record<string, GameIntel> = {};

  for (const game of games) {
    if (game.status === "final") continue;

    const signals: GameSignal[] = [];
    const weather = weatherMap.get(game.id) ?? null;
    const movement = movementMap[game.id];

    // 1. ESPN news signals — enriched with player name extraction
    const matched = matchNewsToGame(game, newsItems);
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

    // Compute real confidence + recommendation
    const confidence = computeConfidence(game, signals, weather, movement);
    const recommendation = computeRecommendation(game, signals, weather, movement, confidence);

    // Only include games that have at least some signal OR meaningful odds
    const hasOdds = game.bookmakers.length >= 2;
    if (signals.length === 0 && !hasOdds) continue;

    const hasHigh = signals.some((s) => s.severity === "high");
    const hasNew = signals.some((s) => s.time === "now" || (s.time.endsWith("m") && parseInt(s.time) < 120));
    const recentNews = matched.filter((n) => isRecent(n.published, 6));

    // Prefer non-injury signals for top_signal — injuries are already shown as badges
    const nonInjury = signals.filter((s) => s.type !== "injury");
    const topGs = nonInjury.find((s) => s.severity === "high")
      ?? nonInjury.find((s) => s.severity === "medium")
      ?? nonInjury[0]
      ?? signals.find((s) => s.severity === "high")
      ?? signals[0]
      ?? null;

    result[game.id] = {
      game_id: game.id,
      signals_count: signals.length,
      has_high_severity: hasHigh,
      is_volatile: hasHigh || signals.length >= 3,
      has_new_signal: hasNew || recentNews.length > 0,
      signals,
      top_signal: topGs ? gameSignalToSignal(topGs, game.id, 0) : null,
      injury_alerts: buildInjuryAlerts(matched, game),
      top_model_signal: topModelSignal,
      no_vig_home_prob: computeNoVigHomeProb(game),
      confidence,
      recommendation,
      weather,
      movement,
    };
  }

  return result;
}
