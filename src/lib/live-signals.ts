// Generates the intelMap passed to DashboardShell from real ESPN news + odds data.
// Replaces the Python backend's /intel/board endpoint.

import { Game } from "@/types/game";
import { ESPNNewsItem } from "@/lib/espn";
import { WeatherData } from "@/lib/weather";
import { computeConfidence, computeRecommendation, ConfidenceResult, RecommendationResult } from "@/lib/confidence";

export interface GameSignal {
  type: "injury" | "lineup" | "market" | "news" | "trade" | "weather" | "model";
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  time: string;
  benefits?: string[];
  harms?: string[];
}

export interface GameIntel {
  game_id: string;
  signals_count: number;
  has_high_severity: boolean;
  is_volatile: boolean;
  has_new_signal: boolean;
  signals: GameSignal[];
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

// Match ESPN news items to a game by team name word overlap
function matchNewsToGame(game: Game, items: ESPNNewsItem[]): ESPNNewsItem[] {
  const teamWords = [game.home_team, game.away_team].flatMap((name) =>
    name.split(" ").filter((w) => w.length > 3)
  );

  return items.filter((item) => {
    const isSameSport = game.sport.split("_")[0] === item.sport_key.split("_")[0];
    if (!isSameSport) return false;
    const text = `${item.headline} ${item.description} ${item.teams.join(" ")}`.toLowerCase();
    return teamWords.some((w) => text.includes(w.toLowerCase()));
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

// ── Main export ────────────────────────────────────────────────────────────────

export function generateIntelMap(
  games: Game[],
  newsItems: ESPNNewsItem[],
  weatherMap: Map<string, WeatherData>,
  movementMap: Record<string, Record<string, "up" | "down" | null>>
): Record<string, GameIntel> {
  const result: Record<string, GameIntel> = {};

  for (const game of games) {
    if (game.status === "final") continue;

    const signals: GameSignal[] = [];
    const weather = weatherMap.get(game.id) ?? null;
    const movement = movementMap[game.id];

    // 1. ESPN news signals
    const matched = matchNewsToGame(game, newsItems);
    for (const item of matched) {
      signals.push({
        type: item.type === "trade" ? "news" : item.type,
        severity: item.severity,
        title: item.headline,
        detail: item.description,
        time: timeAgo(item.published),
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

    // Compute real confidence + recommendation
    const confidence = computeConfidence(game, signals, weather, movement);
    const recommendation = computeRecommendation(game, signals, weather, movement, confidence);

    // Only include games that have at least some signal OR meaningful odds
    const hasOdds = game.bookmakers.length >= 2;
    if (signals.length === 0 && !hasOdds) continue;

    const hasHigh = signals.some((s) => s.severity === "high");
    const hasNew = signals.some((s) => s.time === "now" || (s.time.endsWith("m") && parseInt(s.time) < 120));
    const recentNews = matched.filter((n) => isRecent(n.published, 6));

    result[game.id] = {
      game_id: game.id,
      signals_count: signals.length,
      has_high_severity: hasHigh,
      is_volatile: hasHigh || signals.length >= 3,
      has_new_signal: hasNew || recentNews.length > 0,
      signals,
      confidence,
      recommendation,
      weather,
      movement,
    };
  }

  return result;
}
