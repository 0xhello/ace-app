/**
 * Live (in-play) win probability — a transparent, standard "win-probability
 * graphic" for the live match module. NOT a betting model and not a pick: it's
 * the broadcast-style read of "who's winning right now, given the score and time
 * left."
 *
 * Model (simple + explainable):
 *   • Expected remaining goals = (goals total line) × (minutes left / 90).
 *   • Split between the two sides by their PRE-MATCH market strength
 *     (de-vigged 1X2), so the favorite is expected to score a bit more.
 *   • Each side's remaining goals ~ Poisson(λ); add to the current score and
 *     sum the outcomes → P(home win) / P(draw) / P(away win).
 *
 * At kickoff (0-0, 90' left) it approximates the pre-match market; as the score
 * and clock move, it shifts the way you'd expect (a 1-0 lead late → high).
 */
export interface LiveWinProbInput {
  homePrior: number; // de-vigged pre-match P(home win), 0..1
  awayPrior: number; // de-vigged pre-match P(away win), 0..1
  homeScore: number;
  awayScore: number;
  minute: number | null;
  totalLine: number | null; // goals line (e.g. 2.5)
  finished?: boolean;
}
export interface LiveWinProb { home: number; draw: number; away: number }

const DEFAULT_TOTAL = 2.7;
const GOAL_CAP = 9;

function poissonPmf(lambda: number, k: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logp = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logp -= Math.log(i);
  return Math.exp(logp);
}

export function liveWinProb(input: LiveWinProbInput): LiveWinProb {
  const { homeScore, awayScore } = input;

  // Match over (or effectively over): settle on the actual scoreline.
  if (input.finished) {
    return homeScore > awayScore ? { home: 1, draw: 0, away: 0 }
      : homeScore < awayScore ? { home: 0, draw: 0, away: 1 }
      : { home: 0, draw: 1, away: 0 };
  }

  const minute = Math.max(0, Math.min(input.minute ?? 0, 90));
  const remaining = Math.max(0, 90 - minute);
  const total = input.totalLine && input.totalLine > 0 ? input.totalLine : DEFAULT_TOTAL;
  const expRemaining = total * (remaining / 90);

  // attacking share from the pre-match prior, damped toward even so the draw
  // mass doesn't all accrue to the favorite.
  const h = input.homePrior > 0 ? input.homePrior : 0.4;
  const a = input.awayPrior > 0 ? input.awayPrior : 0.35;
  let homeShare = (h + a) > 0 ? h / (h + a) : 0.5;
  homeShare = 0.5 + (homeShare - 0.5) * 0.8;

  const lamH = expRemaining * homeShare;
  const lamA = expRemaining * (1 - homeShare);

  const pmfH: number[] = [], pmfA: number[] = [];
  for (let k = 0; k <= GOAL_CAP; k++) { pmfH.push(poissonPmf(lamH, k)); pmfA.push(poissonPmf(lamA, k)); }

  let pHome = 0, pDraw = 0, pAway = 0, mass = 0;
  for (let i = 0; i <= GOAL_CAP; i++) {
    for (let j = 0; j <= GOAL_CAP; j++) {
      const p = pmfH[i] * pmfA[j];
      mass += p;
      const hf = homeScore + i, af = awayScore + j;
      if (hf > af) pHome += p; else if (hf < af) pAway += p; else pDraw += p;
    }
  }
  if (mass > 0) { pHome /= mass; pDraw /= mass; pAway /= mass; }
  return { home: pHome, draw: pDraw, away: pAway };
}
