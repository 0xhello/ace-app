"use client";

import { cn, formatAmericanOdds } from "@/lib/utils";
import { bookMeta } from "@/lib/books";
import { SlipLeg } from "@/components/dashboard/DashboardShell";
import { X, Plus, Share2, Copy, ExternalLink, Calculator } from "lucide-react";
import { useState } from "react";

const STAKE_PRESETS = [10, 25, 50, 100];
const TOP_BOOKS = ["fanduel", "draftkings", "betmgm", "caesars", "pointsbet", "bet365"];

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

export default function BetSlip({
  slip,
  onRemove,
  onClear,
}: {
  slip: SlipLeg[];
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  const [stake, setStake] = useState(10);
  const [selectedBook, setSelectedBook] = useState("fanduel");

  const dec = combinedDecimal(slip);
  const payout = stake * (dec - 1);
  const combinedAmerican = slip.length ? toAmerican(dec) : null;
  const impliedProb = slip.length ? (100 / dec).toFixed(1) : null;
  const bm = bookMeta(selectedBook);

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* Header */}
      <div className="shrink-0 h-14 border-b border-[#1e1e24] flex items-center justify-between px-4">
        <div className="flex items-center gap-2.5">
          <Calculator className="h-4 w-4 text-[#00ff7f]" />
          <div>
            <h2 className="text-[13px] font-semibold text-white leading-tight">Bet Calculator</h2>
            <p className="text-[10px] text-[#52525b] leading-tight">
              {slip.length > 0 ? `${slip.length} leg${slip.length !== 1 ? "s" : ""} · click odds to add` : "Click odds to build your slip"}
            </p>
          </div>
        </div>
        {slip.length > 0 && (
          <button onClick={onClear} className="text-[11px] text-[#52525b] hover:text-[#a1a1aa] transition-colors">
            Clear all
          </button>
        )}
      </div>

      {/* Legs */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {slip.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full px-6 gap-4 text-center py-12">
            <div className="h-12 w-12 rounded-2xl border border-dashed border-[#252528] bg-[#0d0d10] flex items-center justify-center">
              <Plus className="h-5 w-5 text-[#2a2a35]" />
            </div>
            <div>
              <p className="text-[14px] font-semibold text-white mb-1">Build your slip</p>
              <p className="text-[11px] text-[#52525b] leading-relaxed">
                Click any odds button on the board to add legs to your parlay.
              </p>
            </div>
          </div>
        ) : (
          <div className="p-3 space-y-2">
            {slip.map((leg) => (
              <div key={leg.id} className="rounded-xl border border-[#1e1e24] bg-[#0f0f11] p-3 hover:border-[#252528] transition-colors">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className="text-[9px] font-bold text-[#52525b] uppercase tracking-wider bg-[#18181b] px-1.5 py-0.5 rounded">
                        {leg.market}
                      </span>
                    </div>
                    <p className="text-[12px] font-semibold text-white truncate leading-tight">{leg.label}</p>
                    <p className="text-[10px] text-[#52525b] mt-0.5 truncate">{leg.matchup}</p>
                  </div>
                  <button
                    onClick={() => onRemove(leg.id)}
                    className="text-[#2a2a35] hover:text-[#71717a] shrink-0 p-0.5 rounded transition-colors"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="flex items-center justify-between">
                  <span className={cn("text-[14px] font-mono font-bold", leg.odds > 0 ? "text-[#00ff7f]" : "text-white")}>
                    {formatAmericanOdds(leg.odds)}
                  </span>
                  {leg.book && (
                    <span className="text-[10px] text-[#52525b]">@ {leg.book}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Book selector */}
      {slip.length > 0 && (
        <div className="shrink-0 border-t border-[#1e1e24] px-4 py-3">
          <p className="text-[10px] font-semibold text-[#52525b] uppercase tracking-wider mb-2.5">Sportsbook</p>
          <div className="grid grid-cols-3 gap-2">
            {TOP_BOOKS.map((bk) => {
              const m = bookMeta(bk);
              return (
                <button
                  key={bk}
                  onClick={() => setSelectedBook(bk)}
                  className={cn(
                    "flex flex-col items-center gap-1 px-2 py-2 rounded-lg border text-center transition-all",
                    selectedBook === bk
                      ? "border-white/20 bg-white/8 text-white"
                      : "border-[#1e1e24] text-[#52525b] hover:text-white hover:border-[#252528]"
                  )}
                >
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: m.color }} />
                  <span className="text-[10px] font-semibold leading-none">{m.short}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Stake + returns */}
      {slip.length > 0 && (
        <div className="shrink-0 border-t border-[#1e1e24] px-4 py-3 space-y-3">
          {/* Stats row */}
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg bg-[#0f0f11] border border-[#1e1e24] px-3 py-2">
              <p className="text-[9px] text-[#52525b] uppercase tracking-wider mb-0.5">Combined odds</p>
              <p className="text-[13px] font-mono font-bold text-white">
                {combinedAmerican !== null ? formatAmericanOdds(combinedAmerican) : "—"}
              </p>
            </div>
            <div className="rounded-lg bg-[#0f0f11] border border-[#1e1e24] px-3 py-2">
              <p className="text-[9px] text-[#52525b] uppercase tracking-wider mb-0.5">Implied prob.</p>
              <p className="text-[13px] font-mono font-bold text-white">{impliedProb}%</p>
            </div>
          </div>

          {/* Stake */}
          <div>
            <p className="text-[10px] font-semibold text-[#52525b] uppercase tracking-wider mb-1.5">Stake</p>
            <div className="grid grid-cols-4 gap-1.5 mb-2">
              {STAKE_PRESETS.map((p) => (
                <button
                  key={p}
                  onClick={() => setStake(p)}
                  className={cn(
                    "py-1.5 rounded-md border text-[11px] font-bold transition-colors",
                    stake === p
                      ? "border-[#00ff7f]/30 bg-[#00ff7f]/10 text-[#00ff7f]"
                      : "border-[#1e1e24] text-[#52525b] hover:text-white hover:border-[#252528]"
                  )}
                >
                  ${p}
                </button>
              ))}
            </div>
            <div className="flex items-center bg-[#0f0f11] border border-[#1e1e24] rounded-lg overflow-hidden focus-within:border-[#2a2a35]">
              <span className="pl-3 pr-1 text-[#52525b] text-[12px] font-mono">$</span>
              <input
                type="number"
                value={stake}
                onChange={(e) => setStake(Math.max(1, Number(e.target.value)))}
                className="flex-1 bg-transparent outline-none text-white text-[12px] font-mono py-2 pr-3"
              />
            </div>
          </div>

          {/* Return box */}
          <div className="rounded-xl bg-[#0a0f0a] border border-[#00ff7f]/20 p-3.5">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] text-[#52525b]">${stake} at {bm.short}</span>
              <div className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: bm.color }} />
                <span className="text-[22px] font-bold font-mono text-[#00ff7f] leading-none">
                  ${(stake + payout).toFixed(2)}
                </span>
              </div>
            </div>
            <p className="text-[10px] text-[#52525b]">To win <span className="text-white font-mono">${payout.toFixed(2)}</span></p>
          </div>

          {/* CTA */}
          <button className="w-full py-3 rounded-xl bg-[#00ff7f] hover:bg-[#00e570] text-black text-[13px] font-bold transition-colors flex items-center justify-center gap-2">
            <ExternalLink className="h-4 w-4" />
            Open in {bm.name}
          </button>

          <div className="flex gap-2">
            <button className="flex-1 py-2 rounded-lg border border-[#1e1e24] hover:border-[#252528] text-[10px] text-[#52525b] hover:text-white flex items-center justify-center gap-1.5 transition-colors">
              <Copy className="h-3 w-3" /> Copy slip
            </button>
            <button className="flex-1 py-2 rounded-lg border border-[#1e1e24] hover:border-[#252528] text-[10px] text-[#52525b] hover:text-white flex items-center justify-center gap-1.5 transition-colors">
              <Share2 className="h-3 w-3" /> Share
            </button>
          </div>

          <p className="text-[9px] text-[#2a2a35] text-center">
            ACE is a research tool. Bets are placed directly on sportsbooks.
          </p>
        </div>
      )}
    </div>
  );
}
