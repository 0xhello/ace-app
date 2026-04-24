"use client";

import { cn, formatAmericanOdds } from "@/lib/utils";
import { bookMeta, bookLogoUrl } from "@/lib/books";
import { bookDeepLink } from "@/lib/deeplinks";
import { saveBets } from "@/lib/bet-history";
import { SlipLeg } from "@/components/dashboard/DashboardShell";
import { getConfidenceForGame } from "@/lib/signals";
import { Game } from "@/types/game";
import { X, Plus, Share2, Copy, ArrowRight, Check } from "lucide-react";
import { useState, useMemo } from "react";

const STAKE_PRESETS = [10, 25, 50, 100];
const TOP_BOOKS = ["fanduel", "draftkings", "betmgm", "caesars", "pointsbet", "bet365"];

// ── Math ──────────────────────────────────────────────────────────────────────

function decimalOdds(american: number) {
  return american > 0 ? american / 100 + 1 : 100 / Math.abs(american) + 1;
}

function combinedDecimal(legs: SlipLeg[]) {
  return legs.reduce((acc, l) => acc * decimalOdds(l.odds), 1);
}

function toAmerican(dec: number) {
  if (dec >= 2) return Math.round((dec - 1) * 100);
  return Math.round(-100 / (dec - 1));
}

// ── Best book detection ───────────────────────────────────────────────────────

function getBookOddsForLeg(game: Game, legId: string, bookKey: string): number | null {
  const book = game.bookmakers.find((b) => b.sportsbook === bookKey);
  if (!book) return null;
  if (legId.endsWith("-ml-away"))
    return (book.markets.h2h || []).find((o) => o.name === game.away_team)?.price ?? null;
  if (legId.endsWith("-ml-home"))
    return (book.markets.h2h || []).find((o) => o.name === game.home_team)?.price ?? null;
  if (legId.endsWith("-sp-away"))
    return (book.markets.spreads || []).find((o) => o.name === game.away_team)?.price ?? null;
  if (legId.endsWith("-sp-home"))
    return (book.markets.spreads || []).find((o) => o.name === game.home_team)?.price ?? null;
  if (legId.endsWith("-ov"))
    return (book.markets.totals || []).find((o) => o.name === "Over")?.price ?? null;
  if (legId.endsWith("-un"))
    return (book.markets.totals || []).find((o) => o.name === "Under")?.price ?? null;
  return null;
}

function findBestBook(legs: SlipLeg[], games: Game[]): string | null {
  if (!legs.length || !games.length) return null;
  const allBooks = Array.from(new Set(games.flatMap((g) => g.bookmakers.map((b) => b.sportsbook))));
  let best: { bookKey: string; combined: number } | null = null;

  for (const bookKey of allBooks) {
    let combined = 1;
    let ok = true;
    for (const leg of legs) {
      const game = games.find((g) => g.id === leg.gameId);
      if (!game) { ok = false; break; }
      const price = getBookOddsForLeg(game, leg.id, bookKey);
      if (price === null) { ok = false; break; }
      combined *= decimalOdds(price);
    }
    if (ok && (!best || combined > best.combined)) {
      best = { bookKey, combined };
    }
  }
  return best?.bookKey ?? null;
}

// ── Confidence label ──────────────────────────────────────────────────────────

const TIER_LABEL: Record<string, string> = {
  high: "High Confidence",
  medium: "Medium Confidence",
  low: "Low Confidence",
};
const TIER_COLOR: Record<string, string> = {
  high: "#4ade80",
  medium: "#f59e0b",
  low: "#ef4444",
};

function confidenceForLeg(leg: SlipLeg) {
  const parts = leg.matchup.split(" @ ");
  const away = parts[0] ?? "";
  const home = parts[1] ?? "";
  return getConfidenceForGame(leg.gameId, home, away);
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function BetSlip({
  slip,
  onRemove,
  onClear,
  games = [],
}: {
  slip: SlipLeg[];
  onRemove: (id: string) => void;
  onClear: () => void;
  games?: Game[];
}) {
  const [stake, setStake] = useState(25);
  const [selectedBook, setSelectedBook] = useState<string | null>(null);
  const [placed, setPlaced] = useState(false);

  const bestBook = useMemo(() => findBestBook(slip, games), [slip, games]);
  const activeBook = selectedBook ?? bestBook ?? "fanduel";

  function handleOpenInBook() {
    const sport = games.find((g) => g.id === slip[0]?.gameId)?.sport_title ?? "";
    const url = bookDeepLink(activeBook, sport);
    const newBets = slip.map((leg) => {
      const conf = confidenceForLeg(leg);
      return {
        id: `${leg.id}-${Date.now()}`,
        gameId: leg.gameId,
        matchup: leg.matchup,
        market: leg.market,
        label: leg.label,
        odds: leg.odds,
        book: activeBook,
        stake,
        confidenceTier: conf.tier as "high" | "medium" | "low",
        status: "pending" as const,
        placedAt: new Date().toISOString(),
      };
    });
    saveBets(newBets);
    setPlaced(true);
    setTimeout(() => setPlaced(false), 2000);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }
  const bm = bookMeta(activeBook);

  const dec = combinedDecimal(slip);
  const payout = stake * (dec - 1);
  const combinedAmerican = slip.length ? toAmerican(dec) : null;
  const impliedProb = slip.length ? (100 / dec).toFixed(1) : null;

  return (
    <div className="flex flex-col h-full overflow-hidden bg-[#08080a]">

      {/* Header */}
      <div className="shrink-0 h-12 border-b border-[#141417] flex items-center justify-between px-4">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-bold text-white">Betslip</span>
          {slip.length > 0 && (
            <span className="text-[10px] font-mono text-[#4ade80] bg-[#4ade80]/8 px-1.5 py-0.5 rounded">
              {slip.length}
            </span>
          )}
        </div>
        {slip.length > 0 && (
          <button onClick={onClear} className="text-[10px] text-[#3f3f46] hover:text-[#71717a] transition-colors">
            Clear
          </button>
        )}
      </div>

      {/* Legs */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {slip.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full px-6 gap-3 text-center">
            <div className="h-10 w-10 rounded-xl border border-dashed border-[#1e1e24] bg-[#0c0c0e] flex items-center justify-center">
              <Plus className="h-4 w-4 text-[#1e1e24]" />
            </div>
            <div>
              <p className="text-[13px] font-semibold text-[#71717a] mb-0.5">Build your slip</p>
              <p className="text-[10px] text-[#3f3f46] leading-relaxed">
                Click odds on the board to add legs.
              </p>
            </div>
          </div>
        ) : (
          <div className="p-2 space-y-1">
            {slip.map((leg) => {
              const conf = confidenceForLeg(leg);
              return (
                <div key={leg.id} className="rounded-lg border border-[#141417] bg-[#0c0c0e] p-2.5 group/leg hover:border-[#1e1e24] transition-colors">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-semibold text-white truncate leading-tight">{leg.label}</p>
                      <p className="text-[9px] text-[#3f3f46] mt-0.5 truncate">{leg.matchup}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={cn("text-[12px] font-mono font-bold", leg.odds > 0 ? "text-[#4ade80]" : "text-white")}>
                        {formatAmericanOdds(leg.odds)}
                      </span>
                      <button
                        onClick={() => onRemove(leg.id)}
                        className="text-[#1e1e24] hover:text-[#52525b] transition-colors opacity-0 group-hover/leg:opacity-100"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mt-1.5">
                    <span className="text-[8px] font-bold text-[#3f3f46] uppercase tracking-widest bg-[#111113] px-1.5 py-[2px] rounded">
                      {leg.market}
                    </span>
                    <span
                      className="text-[8px] font-semibold uppercase tracking-wide"
                      style={{ color: TIER_COLOR[conf.tier] }}
                    >
                      {TIER_LABEL[conf.tier]}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Bottom — only shown when slip has legs */}
      {slip.length > 0 && (
        <div className="shrink-0 border-t border-[#141417]">

          {/* Book selector */}
          <div className="px-3 pt-3 pb-2">
            {bestBook && bestBook !== selectedBook && (
              <div className="flex items-center gap-1.5 mb-2">
                <span className="text-[9px] text-[#52525b]">Best price</span>
                <img src={bookLogoUrl(bestBook)} alt={bookMeta(bestBook).name} className="h-3 w-3 rounded-sm opacity-70" />
                <span className="text-[9px] font-medium text-[#a1a1aa]">{bookMeta(bestBook).name}</span>
                <button
                  onClick={() => setSelectedBook(null)}
                  className="ml-auto text-[9px] text-[#4ade80] font-semibold hover:text-white transition-colors"
                >
                  Use best
                </button>
              </div>
            )}
            <div className="flex items-center gap-1.5">
              {TOP_BOOKS.map((bk) => {
                const m = bookMeta(bk);
                const isActive = bk === activeBook;
                const isBest = bk === bestBook;
                return (
                  <button
                    key={bk}
                    onClick={() => setSelectedBook(bk === bestBook && !selectedBook ? null : bk)}
                    title={m.name}
                    className={cn(
                      "relative flex items-center justify-center h-7 w-7 rounded-md border transition-all",
                      isActive
                        ? "border-white/15 bg-white/5"
                        : "border-transparent hover:border-[#1e1e24] hover:bg-[#0f0f11]"
                    )}
                  >
                    <img
                      src={bookLogoUrl(bk)}
                      alt={m.name}
                      className={cn("h-4 w-4 rounded-sm transition-all", isActive ? "opacity-100" : "opacity-30 hover:opacity-60")}
                    />
                    {isBest && (
                      <span className="absolute -top-[3px] -right-[3px] h-2 w-2 rounded-full bg-[#4ade80] border border-[#08080a]" />
                    )}
                  </button>
                );
              })}
              <span className="ml-1.5 text-[10px] text-[#52525b] font-medium">{bm.name}</span>
            </div>
          </div>

          {/* Stake + returns */}
          <div className="px-3 pb-3 space-y-2 border-t border-[#141417] pt-3">
            <div className="flex items-center gap-1.5">
              {STAKE_PRESETS.map((p) => (
                <button
                  key={p}
                  onClick={() => setStake(p)}
                  className={cn(
                    "flex-1 py-1.5 rounded-md text-[10px] font-bold transition-all",
                    stake === p
                      ? "bg-[#22c55e]/10 text-[#4ade80] border border-[#22c55e]/20"
                      : "bg-[#0c0c0e] text-[#3f3f46] border border-[#141417] hover:text-[#71717a]"
                  )}
                >
                  ${p}
                </button>
              ))}
            </div>

            <div className="flex items-center bg-[#0c0c0e] border border-[#141417] rounded-lg overflow-hidden focus-within:border-[#1e1e24]">
              <span className="pl-3 text-[#3f3f46] text-[11px] font-mono">$</span>
              <input
                type="number"
                value={stake}
                onChange={(e) => setStake(Math.max(1, Number(e.target.value)))}
                className="flex-1 bg-transparent outline-none text-white text-[11px] font-mono py-2 px-1.5"
              />
              <div className="pr-3 flex items-center gap-2 text-[10px] text-[#3f3f46] font-mono">
                <span>{combinedAmerican !== null ? formatAmericanOdds(combinedAmerican) : "—"}</span>
                <span>·</span>
                <span>{impliedProb}%</span>
              </div>
            </div>

            <div className="rounded-xl bg-gradient-to-br from-[#22c55e]/[0.06] to-[#22c55e]/[0.02] border border-[#22c55e]/15 p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[9px] text-[#52525b] uppercase tracking-wider mb-0.5">Potential return</p>
                  <p className="text-[10px] text-[#52525b]">
                    ${stake} → <span className="text-white font-mono font-medium">${payout.toFixed(2)}</span> profit
                  </p>
                </div>
                <p className="text-[24px] font-black font-mono text-[#4ade80] leading-none tracking-tight">
                  ${(stake + payout).toFixed(2)}
                </p>
              </div>
            </div>

            <button
              onClick={handleOpenInBook}
              className={cn(
                "w-full py-3 rounded-xl text-white text-[12px] font-extrabold transition-all flex items-center justify-center gap-2",
                placed ? "bg-[#166534]" : "bg-[#16a34a] hover:bg-[#15803d] active:bg-[#166534]"
              )}
            >
              {placed ? (
                <><Check className="h-3.5 w-3.5" /> Placed — check Tracked</>
              ) : (
                <>Open in {bm.name}<ArrowRight className="h-3.5 w-3.5" /></>
              )}
            </button>

            <div className="flex gap-1.5">
              <button className="flex-1 py-1.5 rounded-md border border-[#141417] text-[9px] text-[#3f3f46] hover:text-[#71717a] flex items-center justify-center gap-1 transition-colors">
                <Copy className="h-2.5 w-2.5" /> Copy
              </button>
              <button className="flex-1 py-1.5 rounded-md border border-[#141417] text-[9px] text-[#3f3f46] hover:text-[#71717a] flex items-center justify-center gap-1 transition-colors">
                <Share2 className="h-2.5 w-2.5" /> Share
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
