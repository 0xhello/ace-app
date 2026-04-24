// Generates the intelMap passed to DashboardShell from real ESPN news + odds data.
// Replaces the Python backend's /intel/board endpoint.

import { Game } from "@/types/game";
import { ESPNNewsItem } from "@/lib/espn";

export interface GameIntel {
  game_id: string;
  signals_count: number;
  has_high_severity: boolean;
  is_volatile: boolean;
  has_new_signal: boolean;
  signals: GameSignal[];
}

export interface GameSignal {
  type: "injury" | "lineup" | "market" | "news" | "trade" | "weather" | "model";
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  time: string;
  benefits?: string[];
  harms?: string[];
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

// Match ESPN news items to a game by checking if any team name word appears in headline
function matchNewsToGame(game: Game, items: ESPNNewsItem[]): ESPNNewsItem[] {
  const teamWords = [game.home_team, game.away_team].flatMap((name) =>
    name.split(" ").filter((w) => w.length > 3)
  );
  const sportKey = game.sport;

  return items.filter((item) => {
    if (item.sport_key && !game.sport.startsWith(item.sport_key.split("_")[0])) {
      // Quick sport filter — basketball_nba vs basketball_ncaab both start with "basketball"
      const isSameSport = game.sport.split("_")[0] === item.sport_key.split("_")[0];
      if (!isSameSport) return false;
    }
    const text = `${item.headline} ${item.description} ${item.teams.join(" ")}`.toLowerCase();
    return teamWords.some((w) => text.includes(w.toLowerCase()));
  });
}

// Detect book spread disagreement — a proxy for sharp / delayed line movement
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

// Detect ML consensus — when 80%+ of books heavily favor one side it's notable
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

  // Only flag heavy favorites (implied prob > 70%)
  const favoredPrice = Math.min(avgAway, avgHome);
  if (favoredPrice > -200) return null;

  const favoredTeam = avgAway < avgHome ? game.away_team : game.home_team;
  const impliedPct = Math.round((100 / (100 + Math.abs(favoredPrice))) * 100);

  return {
    type: "model",
    severity: "medium",
    title: `${favoredTeam} implied at ${impliedPct}% across ${game.bookmakers.length} books`,
    detail: "Heavy consensus across all major sportsbooks. Market confidence is high — monitor for line movement closer to tip.",
    time: "now",
    benefits: [favoredTeam],
  };
}

// ── Main export ────────────────────────────────────────────────────────────────

export function generateIntelMap(
  games: Game[],
  newsItems: ESPNNewsItem[]
): Record<string, GameIntel> {
  const result: Record<string, GameIntel> = {};

  for (const game of games) {
    if (game.status === "final") continue;

    const signals: GameSignal[] = [];

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

    // 2. Spread disagreement (market movement proxy)
    const spreadSignal = detectSpreadDisagreement(game);
    if (spreadSignal) signals.push(spreadSignal);

    // 3. Heavy ML consensus
    const mlSignal = detectMLConsensus(game);
    if (mlSignal) signals.push(mlSignal);

    if (signals.length === 0) continue;

    const hasHigh = signals.some((s) => s.severity === "high");
    const hasNew = signals.some((s) => s.time === "now" || (s.time.endsWith("m") && parseInt(s.time) < 120));
    const newsSignals = matched.filter((n) => isRecent(n.published, 6));

    result[game.id] = {
      game_id: game.id,
      signals_count: signals.length,
      has_high_severity: hasHigh,
      is_volatile: hasHigh || signals.length >= 3,
      has_new_signal: hasNew || newsSignals.length > 0,
      signals,
    };
  }

  return result;
}
