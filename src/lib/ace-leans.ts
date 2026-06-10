/**
 * ACE Signals (leans) — evidence-backed, scarce, honestly-confident.
 *
 * HARD RULE (project history): news/injuries alone are NOT edge — books reprice
 * news in minutes, and our own model failed to beat the market in clean
 * backtests (SOCCER_MODEL_BACKTEST_V2). The only measurable trigger we trust is
 * a PRICE that lags the sharp consensus (Sharp Lens gap). Everything else is
 * corroboration that explains WHY the price may be lagging:
 *
 *   trigger        soft price ≥2.5pp better than Pinnacle de-vigged fair
 *   corroborators  (1) systematic gap — ≥2 bettable books each ≥1.5pp cheap
 *                  (2) injury/suspension context on the opposing side
 *                  (3) line movement toward the selection since last snapshot
 *
 *   Tier A  gap ≥3.0pp AND ≥2 corroborators
 *   Tier B  gap ≥2.5pp AND ≥1 corroborator
 *   (anything weaker stays in the Sharp Lens card — it is not a signal)
 *
 * Confidence is EMPIRICAL, never cosmetic: the displayed win probability is the
 * sharp fair (the best-calibrated number that exists — better than our model),
 * and each tier shows its own graded record from the CLV ledger ("Calibrating ·
 * beat close X of Y"). Scarcity is intentional: most games — most days — have
 * no signal, and the UI says so plainly.
 */
import type { Game } from "@/types/game";
import { sharpFair, sharpLens, implied } from "@/lib/sharp-lens";
import { SHARP_BOOKS } from "@/lib/books";

export type LeanTier = "A" | "B";

export interface LeanEvidence {
  type: "gap" | "systematic" | "injury" | "movement";
  text: string;
}

export interface AceLean {
  gameId: string;
  matchup: string;
  selection: string;       // team name or "Draw"
  book: string;            // best bettable book offering the flagged price
  price: number;           // american odds at that book
  gapPp: number;           // soft vs sharp-fair gap, percentage points
  winProb: number;         // sharp fair prob (0..1) — the honest win estimate
  tier: LeanTier;
  evidence: LeanEvidence[];
  ledgerId: string;        // matches the CLV ledger flag id for tier grading
}

const TIER_A_GAP = 3.0;
const TIER_B_GAP = 2.5;
const SYSTEMATIC_MIN_PP = 1.5;
const SYSTEMATIC_MIN_BOOKS = 2;

export interface LeanInputs {
  /** injuries per side: out/suspended players currently flagged for each team */
  injuries?: { home: string[]; away: string[] };
  /** board movement map row for this game (ml_away / ml_home: "up"|"down"|null) */
  movement?: Record<string, "up" | "down" | null> | null;
}

export function computeAceLean(game: Game, inputs: LeanInputs = {}): AceLean | null {
  // pre-match only: a signal is a price you can still take, judged against a
  // pre-match fair. In-play prices need an in-play fair we don't have.
  if (game.status !== "upcoming") return null;
  const lens = sharpLens(game);
  const ref = sharpFair(game);
  if (!lens || !ref) return null;

  // strongest divergence is the candidate; below B floor → no signal.
  const top = lens.divergences[0];
  if (!top || top.edgePp < TIER_B_GAP) return null;

  const evidence: LeanEvidence[] = [{
    type: "gap",
    text: `Price is ${top.edgePp.toFixed(1)} points better than the sharp market's fair value (${Math.round(top.fairProb * 100)}%)`,
  }];

  // corroborator 1 — systematic gap (not one stale outlier book)
  const fair = ref.fair.get(top.selection);
  let cheapBooks = 0;
  if (fair != null) {
    for (const b of game.bookmakers) {
      if (SHARP_BOOKS.has(b.sportsbook)) continue;
      for (const o of b.markets.h2h ?? []) {
        if (o.name !== top.selection) continue;
        if ((fair - implied(o.price)) * 100 >= SYSTEMATIC_MIN_PP) cheapBooks++;
      }
    }
  }
  if (cheapBooks >= SYSTEMATIC_MIN_BOOKS) {
    evidence.push({ type: "systematic", text: `${cheapBooks} books are paying above sharp fair — a market-wide lag, not one stale price` });
  }

  // corroborator 2 — injury/suspension context on the opposing side
  // (only meaningful for team selections; a Draw lean gets no injury credit)
  const isHomeSel = top.selection === game.home_team;
  const isAwaySel = top.selection === game.away_team;
  if (isHomeSel || isAwaySel) {
    const opposing = isHomeSel ? (inputs.injuries?.away ?? []) : (inputs.injuries?.home ?? []);
    if (opposing.length > 0) {
      const names = opposing.slice(0, 2).join(", ");
      evidence.push({
        type: "injury",
        text: `${isHomeSel ? game.away_team : game.home_team} missing ${opposing.length}: ${names}${opposing.length > 2 ? ` +${opposing.length - 2}` : ""}`,
      });
    }
  }

  // corroborator 3 — line moved toward the selection since the last snapshot
  // ("down" = price shortening = money on that side)
  if (isHomeSel || isAwaySel) {
    const key = isHomeSel ? "ml_home" : "ml_away";
    if (inputs.movement?.[key] === "down") {
      evidence.push({ type: "movement", text: "Line has moved toward this side since the last odds refresh" });
    }
  }

  const corroborators = evidence.length - 1; // gap is the trigger, not a corroborator
  let tier: LeanTier | null = null;
  if (top.edgePp >= TIER_A_GAP && corroborators >= 2) tier = "A";
  else if (top.edgePp >= TIER_B_GAP && corroborators >= 1) tier = "B";
  if (!tier) return null;

  return {
    gameId: game.id,
    matchup: `${game.away_team} @ ${game.home_team}`,
    selection: top.selection,
    book: top.book,
    price: top.price,
    gapPp: top.edgePp,
    winProb: top.fairProb,
    tier,
    evidence,
    ledgerId: `${game.id}|${top.selection}|${top.book}`,
  };
}

/** Tier record line for honest display, from CLV-ledger-graded flags.
 * Returns e.g. "Calibrating · Tier B has beaten the close 3 of 4 so far". */
export function tierRecordLine(
  tier: LeanTier,
  graded: Array<{ tier?: LeanTier; clvPp?: number }>,
): string {
  const ofTier = graded.filter((f) => f.tier === tier && f.clvPp != null);
  if (ofTier.length === 0) return `Calibrating — no graded Tier ${tier} signals yet`;
  const beat = ofTier.filter((f) => (f.clvPp ?? 0) > 0).length;
  const label = ofTier.length < 20 ? "Calibrating · " : "";
  return `${label}Tier ${tier} has beaten the close ${beat} of ${ofTier.length}`;
}
