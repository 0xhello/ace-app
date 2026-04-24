// Generates top Signal Feed picks from live Odds API data.
// Replaces the Python backend's /intel/picks endpoint.

import { Game } from "@/types/game";

// ── Helpers ────────────────────────────────────────────────────────────────────

function decimalOdds(american: number): number {
  return american > 0 ? american / 100 + 1 : 100 / Math.abs(american) + 1;
}

function impliedProb(american: number): number {
  return 1 / decimalOdds(american);
}

// Average a list of american odds prices across books
function avgPrice(prices: number[]): number | null {
  if (!prices.length) return null;
  return prices.reduce((a, b) => a + b, 0) / prices.length;
}

function bestPrice(prices: number[]): number | null {
  return prices.length ? Math.max(...prices) : null;
}

// Compute edge: difference between our implied prob estimate and market implied prob
// Here we use the best available odds (highest payout = lowest implied prob) as the "true" line
// and the consensus (average) as the market. Positive edge = best odds better than market.
function computeEdge(bestAmerican: number, avgAmerican: number): number {
  return (impliedProb(avgAmerican) - impliedProb(bestAmerican)) * 100;
}

function formatEdge(edge: number): string {
  return `${edge >= 0 ? "+" : ""}${edge.toFixed(1)}%`;
}

function formatOdds(american: number): string {
  return american > 0 ? `+${american}` : `${american}`;
}

function abbr(teamName: string): string {
  const parts = teamName.split(" ");
  return parts[parts.length - 1].toUpperCase().slice(0, 4);
}

type ConfTier = "high" | "medium" | "low";
function confidenceTier(edgePct: number, numBooks: number): { tier: ConfTier; pct: number } {
  const bookBonus = Math.min(numBooks / 6, 1); // more books = more confidence
  const rawPct = Math.min(95, Math.max(45, 55 + edgePct * 4 + bookBonus * 10));
  const pct = Math.round(rawPct);
  const tier: ConfTier = pct >= 72 ? "high" : pct >= 60 ? "medium" : "low";
  return { tier, pct };
}

// ── Pick generators ────────────────────────────────────────────────────────────

interface RawPick {
  score: number;  // higher = better candidate
  pick: any;
}

function tryMLPick(game: Game): RawPick | null {
  const awayPrices = game.bookmakers.flatMap((b) =>
    (b.markets.h2h ?? []).filter((o) => o.name === game.away_team).map((o) => o.price)
  );
  const homePrices = game.bookmakers.flatMap((b) =>
    (b.markets.h2h ?? []).filter((o) => o.name === game.home_team).map((o) => o.price)
  );
  if (awayPrices.length < 3 || homePrices.length < 3) return null;

  const awayBest = bestPrice(awayPrices)!;
  const homeAvg = avgPrice(homePrices)!;
  const awayAvg = avgPrice(awayPrices)!;
  const homeBest = bestPrice(homePrices)!;

  // Check both sides for +EV vs market average
  const awayEdge = computeEdge(awayBest, awayAvg);
  const homeEdge = computeEdge(homeBest, homeAvg);

  const [team, edge, best, avg] = awayEdge > homeEdge
    ? [game.away_team, awayEdge, awayBest, awayAvg]
    : [game.home_team, homeEdge, homeBest, homeAvg];

  if (edge < 1.5) return null; // not enough edge to feature

  const conf = confidenceTier(edge, game.num_books);
  const bestBook = game.bookmakers.find((b) =>
    (b.markets.h2h ?? []).some((o) => o.name === team && o.price === best)
  );

  return {
    score: edge * conf.pct,
    pick: {
      id: `pick-ml-${game.id}-${team.slice(0, 3)}`,
      gameId: game.id,
      type: "ML",
      pick: `${abbr(team)} ML`,
      game: `${abbr(game.away_team)} @ ${abbr(game.home_team)}`,
      odds: best,
      market: "Moneyline",
      reasoning: `Best available odds (${formatOdds(best)}) beat market consensus (${formatOdds(Math.round(avg))}) by ${edge.toFixed(1)}%. ${game.num_books} books tracked — genuine price discrepancy.`,
      tag: edge >= 3 ? "stable" : "watch",
      edge: formatEdge(edge),
      home: abbr(game.home_team),
      away: abbr(game.away_team),
      confidence: conf,
    },
  };
}

function tryTotalPick(game: Game): RawPick | null {
  const overPrices = game.bookmakers.flatMap((b) =>
    (b.markets.totals ?? []).filter((o) => o.name === "Over").map((o) => o.price)
  );
  const underPrices = game.bookmakers.flatMap((b) =>
    (b.markets.totals ?? []).filter((o) => o.name === "Under").map((o) => o.price)
  );
  if (overPrices.length < 3 || underPrices.length < 3) return null;

  const overBest = bestPrice(overPrices)!;
  const underBest = bestPrice(underPrices)!;
  const overAvg = avgPrice(overPrices)!;
  const underAvg = avgPrice(underPrices)!;

  const overEdge = computeEdge(overBest, overAvg);
  const underEdge = computeEdge(underBest, underAvg);

  const [side, edge, best] = overEdge > underEdge
    ? ["Over", overEdge, overBest]
    : ["Under", underEdge, underBest];

  if (edge < 1.2) return null;

  // Get the total line from any book
  const line = game.bookmakers.flatMap((b) =>
    (b.markets.totals ?? []).filter((o) => o.name === side).map((o) => o.point)
  ).find((p) => p !== undefined);

  if (!line) return null;

  const conf = confidenceTier(edge, game.num_books);

  return {
    score: edge * conf.pct * 0.9, // slight discount vs ML picks
    pick: {
      id: `pick-tot-${game.id}-${side}`,
      gameId: game.id,
      type: side === "Over" ? "OVER" : "UNDER",
      pick: `${side === "Over" ? "O" : "U"} ${line}`,
      game: `${abbr(game.away_team)} @ ${abbr(game.home_team)}`,
      odds: best,
      market: "Total",
      reasoning: `${side} ${line} at ${formatOdds(best)} offers ${edge.toFixed(1)}% edge vs market average. Book pricing inconsistency detected across ${game.num_books} sportsbooks.`,
      tag: edge >= 3 ? "stable" : "volatile",
      edge: formatEdge(edge),
      home: abbr(game.home_team),
      away: abbr(game.away_team),
      confidence: conf,
    },
  };
}

function trySpreadPick(game: Game): RawPick | null {
  const awayPrices = game.bookmakers.flatMap((b) =>
    (b.markets.spreads ?? []).filter((o) => o.name === game.away_team).map((o) => o.price)
  );
  const homePrices = game.bookmakers.flatMap((b) =>
    (b.markets.spreads ?? []).filter((o) => o.name === game.home_team).map((o) => o.price)
  );
  if (awayPrices.length < 3 || homePrices.length < 3) return null;

  const awayBest = bestPrice(awayPrices)!;
  const homeBest = bestPrice(homePrices)!;
  const awayAvg = avgPrice(awayPrices)!;
  const homeAvg = avgPrice(homePrices)!;

  const awayEdge = computeEdge(awayBest, awayAvg);
  const homeEdge = computeEdge(homeBest, homeAvg);

  const [team, edge, best] = awayEdge > homeEdge
    ? [game.away_team, awayEdge, awayBest]
    : [game.home_team, homeEdge, homeBest];

  if (edge < 1.8) return null;

  const point = game.bookmakers.flatMap((b) =>
    (b.markets.spreads ?? []).filter((o) => o.name === team).map((o) => o.point)
  ).find((p) => p !== undefined);

  if (point === undefined || point === null) return null;

  const conf = confidenceTier(edge, game.num_books);
  const spreadLabel = `${point > 0 ? "+" : ""}${point}`;

  return {
    score: edge * conf.pct * 0.85,
    pick: {
      id: `pick-sp-${game.id}-${team.slice(0, 3)}`,
      gameId: game.id,
      type: "SPREAD",
      pick: `${abbr(team)} ${spreadLabel}`,
      game: `${abbr(game.away_team)} @ ${abbr(game.home_team)}`,
      odds: best,
      market: "Spread",
      reasoning: `${abbr(team)} ${spreadLabel} at ${formatOdds(best)} — best spread price across ${game.num_books} books. ${edge.toFixed(1)}% implied edge vs consensus line.`,
      tag: "watch",
      edge: formatEdge(edge),
      home: abbr(game.home_team),
      away: abbr(game.away_team),
      confidence: conf,
    },
  };
}

// ── Main export ────────────────────────────────────────────────────────────────

export function generateLivePicks(games: Game[], limit = 5): any[] {
  const candidates: RawPick[] = [];

  for (const game of games) {
    // Skip completed games and games with no odds
    if (game.status === "final" || game.num_books < 3) continue;

    const ml = tryMLPick(game);
    const tot = tryTotalPick(game);
    const sp = trySpreadPick(game);

    if (ml) candidates.push(ml);
    if (tot) candidates.push(tot);
    if (sp) candidates.push(sp);
  }

  // Sort by score descending and return top picks (one per game max)
  const seen = new Set<string>();
  return candidates
    .sort((a, b) => b.score - a.score)
    .filter((c) => {
      if (seen.has(c.pick.gameId)) return false;
      seen.add(c.pick.gameId);
      return true;
    })
    .slice(0, limit)
    .map((c) => c.pick);
}
