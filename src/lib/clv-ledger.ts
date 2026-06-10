/**
 * CLV ledger — the proof (or disproof) of the Sharp Lens.
 *
 * Every divergence the lens flags is snapshotted the FIRST time it's seen (the
 * price a user could actually have taken when we surfaced it). Each scheduler
 * tick re-reads the cached board (zero extra API cost) and updates the flag's
 * latest sharp-fair. Once kickoff passes, the last sharp-fair seen pre-kickoff
 * stands as the close, and the flag is graded:
 *
 *   CLV pp = sharp fair at close − implied prob of the flagged soft price
 *
 * Positive = the flagged price beat the closing sharp consensus — the standard
 * long-run evidence of +EV. Negative = the gap was noise / the market moved
 * against the flag. The aggregate ledger (hit rate, avg CLV) is the ONLY claim
 * ACE makes about whether the lens works — receipts, not promises.
 *
 * Persistence: Redis via setPersistent (no TTL — survives redeploys). Scale is
 * tiny (hundreds of flags over the WC), one JSON document is plenty.
 */
import * as serverCache from "@/lib/server-cache";
import { sharpLens, sharpFair } from "@/lib/sharp-lens";
import type { Game } from "@/types/game";

const LEDGER_KEY = "clv-ledger-v1";

export interface ClvFlag {
  id: string;            // gameId|selection|book
  gameId: string;
  matchup: string;
  sport: string;
  selection: string;
  book: string;          // soft book whose price was flagged
  price: number;         // american odds at flag time (first sight — immutable)
  softProb: number;      // implied prob of that price
  fairAtFlag: number;    // sharp fair when first flagged
  edgeAtFlagPp: number;
  firstSeen: string;
  kickoff: string;
  lastFair: number;      // latest sharp fair seen pre-kickoff (becomes the close)
  lastFairAt: string;
  graded: boolean;
  clvPp?: number;        // (lastFair − softProb) × 100, set at grading
  gradedAt?: string;
}

export interface ClvSummary {
  total: number;
  open: number;
  graded: number;
  beatClose: number;     // graded flags with clvPp > 0
  avgClvPp: number | null;
}

type Ledger = Record<string, ClvFlag>;

async function load(): Promise<Ledger> {
  try {
    const entry = await serverCache.get(LEDGER_KEY);
    return (entry?.data as Ledger) ?? {};
  } catch {
    return {};
  }
}

async function save(ledger: Ledger): Promise<void> {
  await serverCache.setPersistent(LEDGER_KEY, ledger);
}

/** One tick: record new lens flags, refresh sharp-fair on open flags, grade
 * anything past kickoff. Pure function of the passed board games. */
export async function clvLedgerTick(games: Game[]): Promise<{ newFlags: number; updated: number; graded: number; total: number }> {
  const ledger = await load();
  const now = new Date();
  const nowIso = now.toISOString();
  let newFlags = 0, updated = 0, graded = 0;

  for (const game of games) {
    const kickoff = new Date(game.commence_time);
    const preKick = kickoff.getTime() > now.getTime();
    const ref = sharpFair(game);

    // 1. Record new flags (pre-kickoff only — a "flag" is only meaningful as a
    //    price you could still take).
    if (preKick) {
      const lens = sharpLens(game);
      for (const d of lens?.divergences ?? []) {
        const id = `${game.id}|${d.selection}|${d.book}`;
        if (!ledger[id]) {
          ledger[id] = {
            id, gameId: game.id,
            matchup: `${game.away_team} @ ${game.home_team}`,
            sport: game.sport,
            selection: d.selection, book: d.book,
            price: d.price, softProb: d.softProb,
            fairAtFlag: d.fairProb, edgeAtFlagPp: d.edgePp,
            firstSeen: nowIso, kickoff: game.commence_time,
            lastFair: d.fairProb, lastFairAt: nowIso,
            graded: false,
          };
          newFlags++;
        }
      }
    }

    // 2. Refresh sharp-fair on this game's open flags (pre-kickoff only).
    if (preKick && ref) {
      for (const f of Object.values(ledger)) {
        if (f.gameId !== game.id || f.graded) continue;
        const fair = ref.fair.get(f.selection);
        if (fair != null) { f.lastFair = fair; f.lastFairAt = nowIso; updated++; }
      }
    }
  }

  // 3. Grade flags whose kickoff has passed (the last pre-kickoff fair = close).
  for (const f of Object.values(ledger)) {
    if (f.graded) continue;
    if (new Date(f.kickoff).getTime() <= now.getTime()) {
      f.clvPp = (f.lastFair - f.softProb) * 100;
      f.graded = true;
      f.gradedAt = nowIso;
      graded++;
    }
  }

  await save(ledger);
  return { newFlags, updated, graded, total: Object.keys(ledger).length };
}

export async function clvLedgerRead(): Promise<{ summary: ClvSummary; flags: ClvFlag[] }> {
  const ledger = await load();
  const flags = Object.values(ledger).sort((a, b) => b.firstSeen.localeCompare(a.firstSeen));
  const gradedFlags = flags.filter((f) => f.graded && f.clvPp != null);
  const summary: ClvSummary = {
    total: flags.length,
    open: flags.filter((f) => !f.graded).length,
    graded: gradedFlags.length,
    beatClose: gradedFlags.filter((f) => (f.clvPp ?? 0) > 0).length,
    avgClvPp: gradedFlags.length
      ? gradedFlags.reduce((s, f) => s + (f.clvPp ?? 0), 0) / gradedFlags.length
      : null,
  };
  return { summary, flags };
}

/** Tick off the cached board (no API spend). Used by the scheduler + ops route. */
export async function clvLedgerTickFromCache(): Promise<any> {
  try {
    const entry = await serverCache.get("board-games"); // must match api/board route
    const games: Game[] = entry?.data?.games ?? [];
    if (!games.length) return { skipped: "board cache empty" };
    return await clvLedgerTick(games);
  } catch (e) {
    return { error: String(e).slice(0, 200) };
  }
}
