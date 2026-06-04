/**
 * "What the line says" — translate the betting market into plain English.
 *
 * Pure function of the posted odds. NO advice, NO edge claims, NO model jargon —
 * it only states what the market is pricing: implied probabilities (de-vigged so
 * they sum to ~100%), favorite/underdog/draw context, and total/goals context.
 * This is research, not a tip.
 */
import type { Game } from "@/types/game";

export interface MarketReadSide {
  name: string;
  prob: number; // de-vigged fair probability, 0..1
}
export interface MarketRead {
  fav: MarketReadSide;
  dog: MarketReadSide;
  draw: number | null; // de-vigged draw prob (3-way soccer)
  favStrength: "pick'em" | "slight" | "clear" | "heavy";
  totalLine: number | null;
  goalsLean: "low" | "moderate" | "high" | null;
  overProb: number | null;
  headline: string; // one-line summary
  detail: string; // a second, contextual sentence
}

function americanToImplied(price: number): number {
  return price >= 0 ? 100 / (price + 100) : -price / (-price + 100);
}

/** Best (highest) price for a market outcome across all books. */
function bestPrice(game: Game, market: "h2h" | "totals", name: string): { price: number; point?: number } | null {
  let top: { price: number; point?: number } | null = null;
  for (const b of game.bookmakers)
    for (const o of b.markets[market] ?? [])
      if (o.name === name && (!top || o.price > top.price)) top = { price: o.price, point: o.point };
  return top;
}

/** Modal total line across books (the line the market has mostly settled on). */
function consensusTotalLine(game: Game): number | null {
  const counts = new Map<number, number>();
  for (const b of game.bookmakers)
    for (const o of b.markets.totals ?? [])
      if (o.point != null) counts.set(o.point, (counts.get(o.point) ?? 0) + 1);
  let best: { pt: number; n: number } | null = null;
  for (const [pt, n] of counts) if (!best || n > best.n) best = { pt, n };
  return best?.pt ?? null;
}

export function marketRead(game: Game): MarketRead | null {
  const home = game.home_team, away = game.away_team;
  const hi = bestPrice(game, "h2h", home), ai = bestPrice(game, "h2h", away);
  const di = bestPrice(game, "h2h", "Draw");
  if (!hi || !ai) return null;

  // de-vig across the available outcomes
  const raw: Array<{ name: string; p: number; isDraw?: boolean }> = [
    { name: home, p: americanToImplied(hi.price) },
    { name: away, p: americanToImplied(ai.price) },
  ];
  if (di) raw.push({ name: "Draw", p: americanToImplied(di.price), isDraw: true });
  const sum = raw.reduce((s, r) => s + r.p, 0);
  const fair = raw.map((r) => ({ ...r, p: r.p / sum }));

  const teams = fair.filter((r) => !r.isDraw).sort((a, b) => b.p - a.p);
  const drawProb = fair.find((r) => r.isDraw)?.p ?? null;
  const fav: MarketReadSide = { name: teams[0].name, prob: teams[0].p };
  const dog: MarketReadSide = { name: teams[1].name, prob: teams[1].p };

  const gap = fav.prob - dog.prob;
  const favStrength: MarketRead["favStrength"] =
    gap < 0.06 ? "pick'em" : fav.prob >= 0.6 ? "heavy" : fav.prob >= 0.48 ? "clear" : "slight";

  const totalLine = consensusTotalLine(game);
  const ov = totalLine != null ? bestPrice(game, "totals", "Over") : null;
  const un = totalLine != null ? bestPrice(game, "totals", "Under") : null;
  let overProb: number | null = null;
  if (ov && un) {
    const o = americanToImplied(ov.price), u = americanToImplied(un.price);
    overProb = o / (o + u);
  }
  const goalsLean: MarketRead["goalsLean"] =
    totalLine == null ? null : totalLine <= 2.0 ? "low" : totalLine >= 3.0 ? "high" : "moderate";

  const pct = (p: number) => `${Math.round(p * 100)}%`;
  // Headline — what the market is basically saying about the result.
  let headline: string;
  if (favStrength === "pick'em") {
    headline = drawProb != null
      ? `The market sees this near even — ${fav.name} ${pct(fav.prob)}, ${dog.name} ${pct(dog.prob)}, draw ${pct(drawProb)}.`
      : `The market sees this near even — ${fav.name} ${pct(fav.prob)} vs ${dog.name} ${pct(dog.prob)}.`;
  } else {
    const word = favStrength === "heavy" ? "a heavy favorite" : favStrength === "clear" ? "a clear favorite" : "a slight favorite";
    headline = `${fav.name} is ${word} — the market gives them about ${pct(fav.prob)}${drawProb != null ? `, with ${dog.name} at ${pct(dog.prob)} and a draw around ${pct(drawProb)}` : ` vs ${pct(dog.prob)} for ${dog.name}`}.`;
  }
  // Detail — goals / total context.
  let detail: string;
  if (totalLine == null) {
    detail = "No goals total is posted yet — books usually set it closer to kickoff.";
  } else {
    const leanWord = goalsLean === "high" ? "an open, higher-scoring game" : goalsLean === "low" ? "a tight, low-scoring game" : "a moderate-scoring game";
    const over = overProb != null && overProb > 0.5;
    const dirProb = overProb != null ? (over ? overProb : 1 - overProb) : 0;
    const tilt = overProb != null && Math.abs(overProb - 0.5) >= 0.04
      ? ` Pricing tilts ${over ? "over" : "under"} (about ${pct(dirProb)} chance the goals land ${over ? "above" : "below"} it).`
      : "";
    detail = `Books set the goals line at ${totalLine}, pointing to ${leanWord}.${tilt}`;
  }

  return { fav, dog, draw: drawProb, favStrength, totalLine, goalsLean, overProb, headline, detail };
}
