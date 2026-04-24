export function impliedProbability(americanOdds: number): number {
  if (americanOdds > 0) return (100 / (americanOdds + 100)) * 100;
  return (Math.abs(americanOdds) / (Math.abs(americanOdds) + 100)) * 100;
}

// Remove vig from a two-sided market — returns true probabilities for each side
export function noVigProb(oddsA: number, oddsB: number): [number, number] {
  const rawA = impliedProbability(oddsA);
  const rawB = impliedProbability(oddsB);
  const total = rawA + rawB;
  return [(rawA / total) * 100, (rawB / total) * 100];
}

export function edgePct(confidencePct: number, americanOdds: number): number {
  return confidencePct - impliedProbability(americanOdds);
}
