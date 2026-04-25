// Real confidence scoring for ACE.
// Replaces the deterministic hash-based mock in signals.ts.
// Inputs: live odds (no-vig prob), ESPN injury signals, weather, line movement.

import { Game } from "@/types/game";
import { WeatherData } from "@/lib/weather";
import { GameSignal } from "@/lib/live-signals";

export type ConfTier = "high" | "medium" | "low";

export interface ConfidenceResult {
  pct: number;
  tier: ConfTier;
  label: string;
  components: {
    base_prob: number;
    injury_modifier: number;
    weather_modifier: number;
    movement_modifier: number;
  };
}

export type MarketRec = "ml-away" | "ml-home" | "sp-away" | "sp-home" | "ov" | "un";

export interface RecommendationResult {
  market: MarketRec;
  confidence: number;
  reason: string;
}

// ── No-vig probability ──────────────────────────────────────────────────────

function toDecimal(american: number): number {
  return american > 0 ? american / 100 + 1 : 100 / Math.abs(american) + 1;
}

function impliedProb(american: number): number {
  return 1 / toDecimal(american);
}

// Remove the bookmaker vig to get true win probability
function noVigProb(awayOdds: number, homeOdds: number): [number, number] {
  const rawAway = impliedProb(awayOdds);
  const rawHome = impliedProb(homeOdds);
  const total = rawAway + rawHome;
  return [(rawAway / total) * 100, (rawHome / total) * 100];
}

function bestOddsForTeam(game: Game, team: string): number | null {
  const prices = game.bookmakers.flatMap((b) =>
    (b.markets.h2h ?? []).filter((o) => o.name === team).map((o) => o.price)
  );
  return prices.length ? Math.max(...prices) : null;
}

// ── Injury modifier ─────────────────────────────────────────────────────────

function injuryModifier(signals: GameSignal[], favoredTeam: string): number {
  let mod = 0;
  for (const sig of signals) {
    if (sig.type !== "injury" && sig.type !== "lineup") continue;
    const affectsFavored = sig.title.toLowerCase().includes(favoredTeam.split(" ").pop()!.toLowerCase());
    if (sig.severity === "high") {
      mod += affectsFavored ? -8 : +4;
    } else if (sig.severity === "medium") {
      mod += affectsFavored ? -3 : +2;
    }
  }
  return Math.max(-15, Math.min(10, mod));
}

// ── Movement modifier ───────────────────────────────────────────────────────

function movementModifier(
  movement: Record<string, "up" | "down" | null> | undefined,
  favoredMarket: "ml-away" | "ml-home"
): number {
  if (!movement) return 0;
  const favKey = favoredMarket === "ml-away" ? "ml-away" : "ml-home";
  const dir = movement[favKey];
  // Line moving up = odds shortening = market gaining confidence in this side
  // Line moving down = odds lengthening = market losing confidence
  if (dir === "up") return 4;
  if (dir === "down") return -4;
  return 0;
}

// ── Main export ─────────────────────────────────────────────────────────────

export function computeConfidence(
  game: Game,
  signals: GameSignal[],
  weather: WeatherData | null,
  movement: Record<string, "up" | "down" | null> | undefined
): ConfidenceResult {
  const awayOdds = bestOddsForTeam(game, game.away_team);
  const homeOdds = bestOddsForTeam(game, game.home_team);

  // If we don't have odds for both sides, return a low-confidence neutral read
  if (!awayOdds || !homeOdds) {
    return {
      pct: 50,
      tier: "low",
      label: "Insufficient odds data",
      components: { base_prob: 50, injury_modifier: 0, weather_modifier: 0, movement_modifier: 0 },
    };
  }

  const [awayProb, homeProb] = noVigProb(awayOdds, homeOdds);
  const favoredTeam = awayProb >= homeProb ? game.away_team : game.home_team;
  const base_prob = Math.max(awayProb, homeProb); // 50-70 typically

  const injury_modifier = injuryModifier(signals, favoredTeam);
  const weather_modifier = weather ? weather.ml_modifier : 0;
  const movement_modifier = movementModifier(
    movement,
    awayProb >= homeProb ? "ml-away" : "ml-home"
  );

  const raw = base_prob + injury_modifier + weather_modifier + movement_modifier;
  const pct = Math.round(Math.max(45, Math.min(95, raw)));
  const tier: ConfTier = pct >= 72 ? "high" : pct >= 60 ? "medium" : "low";

  const label =
    tier === "high" ? `High conviction — ${favoredTeam.split(" ").pop()} favored`
    : tier === "medium" ? `Moderate read — ${favoredTeam.split(" ").pop()} leaning`
    : "Low confidence — signals mixed or insufficient";

  return {
    pct,
    tier,
    label,
    components: { base_prob: Math.round(base_prob), injury_modifier, weather_modifier, movement_modifier },
  };
}

export function computeRecommendation(
  game: Game,
  signals: GameSignal[],
  weather: WeatherData | null,
  movement: Record<string, "up" | "down" | null> | undefined,
  confidence: ConfidenceResult
): RecommendationResult | null {
  const awayOdds = bestOddsForTeam(game, game.away_team);
  const homeOdds = bestOddsForTeam(game, game.home_team);
  if (!awayOdds || !homeOdds) return null;

  const [awayProb] = noVigProb(awayOdds, homeOdds);
  const favoredIsAway = awayProb >= 50;
  const favoredTeam = favoredIsAway ? game.away_team : game.home_team;
  const favoredAbbr = favoredTeam.split(" ").pop()!;

  // Weather-driven total recommendation takes priority when impact is meaningful
  if (weather && weather.impact !== "none" && weather.total_modifier <= -4) {
    const reasons = [
      `${weather.detail} — historically suppresses scoring in outdoor games.`,
      `Wind and conditions favor the Under at current total.`,
      `${weather.wind_mph.toFixed(0)} mph winds reduce offensive efficiency — Under value.`,
    ];
    return {
      market: "un",
      confidence: Math.min(confidence.pct + 5, 90),
      reason: reasons[Math.floor(Math.random() * reasons.length)],
    };
  }

  // Moneyline recommendation when confidence is high enough
  if (confidence.pct >= 62) {
    const market: MarketRec = favoredIsAway ? "ml-away" : "ml-home";
    const components = confidence.components;
    const parts: string[] = [`No-vig model gives ${favoredAbbr} ${components.base_prob.toFixed(0)}% win probability.`];
    if (components.injury_modifier > 0) parts.push(`Opponent injury situation adds ${components.injury_modifier}pts.`);
    if (components.injury_modifier < 0) parts.push(`Injury concern narrows edge — monitor lineup.`);
    if (components.movement_modifier > 0) parts.push(`Line movement supports ${favoredAbbr} side.`);
    if (weather && weather.impact !== "none") parts.push(`Weather: ${weather.detail}.`);

    return { market, confidence: confidence.pct, reason: parts.join(" ") };
  }

  // Spread recommendation when there is clear line movement but weak ML signal
  const movDir = movement?.["sp-away"] ?? movement?.["sp-home"] ?? null;
  if (movDir === "up" && confidence.pct >= 55) {
    const movingTeam = movement?.["sp-away"] === "up" ? game.away_team : game.home_team;
    const market: MarketRec = movement?.["sp-away"] === "up" ? "sp-away" : "sp-home";
    return {
      market,
      confidence: confidence.pct,
      reason: `Spread line moving toward ${movingTeam.split(" ").pop()} — sharp action detected. Market conviction building.`,
    };
  }

  return null;
}
