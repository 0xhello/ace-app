/**
 * Sharp Lens — soft-book vs sharp-reference divergence on the 3-way moneyline.
 *
 * Pinnacle (low-hold, sharp-action book) is the reference: de-vig its 1X2 to a
 * "sharp fair" probability per outcome, then flag bettable-book prices whose
 * implied probability sits meaningfully BELOW that fair (i.e. the soft book is
 * paying more than the sharp consensus says the outcome is worth).
 *
 * This is the documented ACE edge (soft-book inefficiency vs the sharp line) —
 * surfaced as RESEARCH, not advice. Honesty constraints baked in:
 *   • conservative threshold (≥2pp) — small gaps are noise/timing;
 *   • fair-prob floor (≥6%) — proportional de-vig is least reliable on extreme
 *     longshots (favourite–longshot bias), so we don't flag +2000 lottery legs;
 *   • the UI copy must say gaps are most meaningful near kickoff and that the
 *     sharp line is a reference, not ground truth.
 *
 * Every flag should later be graded vs the sharp CLOSING line (EDGE-3) — that
 * ledger, not this screen, is the proof of whether the lens works.
 */
import type { Game } from "@/types/game";
import { SHARP_BOOKS } from "@/lib/books";

export interface SharpDivergence {
  selection: string;      // outcome name (team or "Draw")
  book: string;           // soft book key offering the price
  price: number;          // american odds at the soft book
  fairProb: number;       // sharp de-vigged probability, 0..1
  softProb: number;       // implied probability at the soft price, 0..1
  edgePp: number;         // (fairProb − softProb) × 100, percentage points
}

export interface SharpLens {
  sharpBook: string;
  divergences: SharpDivergence[]; // sorted by edge, best first
}

const MIN_EDGE_PP = 2.0;
const MIN_FAIR_PROB = 0.06;

function implied(price: number): number {
  return price >= 0 ? 100 / (price + 100) : -price / (-price + 100);
}

export function sharpLens(game: Game): SharpLens | null {
  // locate the sharp book's 3-way prices
  const sharp = game.bookmakers.find((b) => SHARP_BOOKS.has(b.sportsbook));
  const sharpH2h = sharp?.markets.h2h ?? [];
  if (!sharp || sharpH2h.length < 2) return null;

  // de-vig (proportional) → sharp fair per outcome
  const raw = sharpH2h.map((o) => ({ name: o.name, p: implied(o.price) }));
  const sum = raw.reduce((s, r) => s + r.p, 0);
  if (sum <= 0) return null;
  const fair = new Map(raw.map((r) => [r.name, r.p / sum]));

  // scan bettable books for prices sitting below sharp fair
  const out: SharpDivergence[] = [];
  for (const b of game.bookmakers) {
    if (SHARP_BOOKS.has(b.sportsbook)) continue;
    for (const o of b.markets.h2h ?? []) {
      const f = fair.get(o.name);
      if (f == null || f < MIN_FAIR_PROB) continue;
      const soft = implied(o.price);
      const edgePp = (f - soft) * 100;
      if (edgePp >= MIN_EDGE_PP) {
        out.push({ selection: o.name, book: b.sportsbook, price: o.price, fairProb: f, softProb: soft, edgePp });
      }
    }
  }
  if (out.length === 0) return null;

  // keep only the best price per selection (the others are dominated), sort by edge
  const bestPer = new Map<string, SharpDivergence>();
  for (const d of out) {
    const cur = bestPer.get(d.selection);
    if (!cur || d.edgePp > cur.edgePp) bestPer.set(d.selection, d);
  }
  const divergences = [...bestPer.values()].sort((a, b) => b.edgePp - a.edgePp);
  return { sharpBook: sharp.sportsbook, divergences };
}
