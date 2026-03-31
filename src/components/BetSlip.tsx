"use client";

import { cn, formatAmericanOdds } from "@/lib/utils";
import { bookMeta } from "@/lib/books";
import { SlipLeg } from "@/components/dashboard/DashboardShell";
import { X, Plus, BookOpen, Share2, Copy } from "lucide-react";
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

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="shrink-0 h-14 border-b border-[#1e1e24] flex items-center justify-between px-4">
        <div>
          <h2 className="text-[13px] font-semibold text-white">Bet Calculator</h2>
          <p className="text-[10px] text-[#52525b]">{slip.length} leg{slip.length !== 1 ? "s" : ""} added</p>
        </div>
        {slip.length > 0 && (
          <button onClick={onClear} className="text-[11px] text-[#52525b] hover:text-white transition-colors">
            Clear
          </button>
        )}
      </div>

      {/* Slip body */}
      <div className="flex-1 overflow-y-auto">
        {slip.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-5 py-10 gap-3 text-center">
            <div className="h-10 w-10 rounded-xl border border-dashed border-[#27272a] flex items-center justify-center">
              <Plus className="h-5 w-5 text-[#3f3f46]" />
            </div>
            <p className="text-[13px] font-medium text-white">No legs added</p>
            <p className="text-[11px] text-[#52525b] leading-relaxed">
              Click any odds button on the board to start building your slip.
            </p>
          </div>
        ) : (
          <div className="p-3 space-y-2">
            {slip.map((leg) => {
              const b = leg.book ? Object.entries(bookMeta).find(([_, v]) => v.short === leg.book)?.[1] : null;
              return (
                <div key={leg.id} className="rounded-lg border border-[#1e1e24] bg-[#111113] p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="text-[9px] font-semibold text-[#52525b] uppercase tracking-wider">{leg.market}</span>
                        <span className="text-[#27272a]">·</span>
                        <span className="text-[9px] text-[#52525b] truncate">{leg.matchup}</span>
                      </div>
                      <p className="text-[12px] font-semibold text-white truncate">{leg.label}</p>
                      {leg.book && (
                        <p className="text-[10px] text-[#52525b] mt-0.5">@ {leg.book}</p>
                      )}
                    </div>
                    <button onClick={() => onRemove(leg.id)} className="text-[#3f3f46] hover:text-white shrink-0">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className={cn("mt-2 text-[14px] font-mono font-bold", leg.odds > 0 ? "text-[#00ff7f]" : "text-white")}>
                    {formatAmericanOdds(leg.odds)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Book selector */}
      {slip.length > 0 && (
        <div className="shrink-0 border-t border-[#1e1e24] px-4 py-3">
          <p className="text-[10px] font-semibold text-[#52525b] uppercase tracking-wider mb-2">Choose sportsbook</p>
          <div className="flex flex-wrap gap-2">
            {TOP_BOOKS.map((bk) => {
              const m = bookMeta(bk);
              return (
                <button
                  key={bk}
                  onClick={() => setSelectedBook(bk)}
                  className={cn(
                    "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] font-medium transition-all",
                    selectedBook === bk
                      ? "border-white/20 bg-white/8 text-white"
                      : "border-[#1e1e24] text-[#71717a] hover:text-white"
                  )}
                >
                  <span className="h-2 w-2 rounded-full shrink-0" style={{ background: m.color }} />
                  {m.short}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Stake + payout */}
      {slip.length > 0 && (
        <div className="shrink-0 border-t border-[#1e1e24] px-4 py-3 space-y-3">
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-[#71717a]">Combined odds</span>
            <span className="text-white font-mono font-semibold">{combinedAmerican !== null ? formatAmericanOdds(combinedAmerican) : "—"}</span>
          </div>
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-[#71717a]">Implied probability</span>
            <span className="text-white font-mono">{impliedProb}%</span>
          </div>

          {/* Stake presets */}
          <div>
            <p className="text-[10px] font-semibold text-[#52525b] uppercase tracking-wider mb-1.5">Stake</p>
            <div className="flex items-center gap-2 mb-2">
              {STAKE_PRESETS.map((p) => (
                <button
                  key={p}
                  onClick={() => setStake(p)}
                  className={cn(
                    "flex-1 py-1.5 rounded-md border text-[12px] font-semibold transition-colors",
                    stake === p ? "border-[#00ff7f]/40 bg-[#00ff7f]/10 text-[#00ff7f]" : "border-[#1e1e24] text-[#71717a] hover:text-white"
                  )}
                >
                  ${p}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 bg-[#111113] border border-[#1e1e24] rounded-lg px-3 py-2">
              <span className="text-[#52525b] text-[12px]">$</span>
              <input
                type="number"
                value={stake}
                onChange={(e) => setStake(Math.max(1, Number(e.target.value)))}
                className="bg-transparent outline-none text-white text-[12px] font-mono w-full"
              />
            </div>
          </div>

          {/* Potential return */}
          <div className="rounded-xl bg-[#111113] border border-[#1e1e24] p-3">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-[#71717a]">${stake} stake at {bookMeta(selectedBook).name}</span>
              <span className="text-[18px] font-bold font-mono text-[#00ff7f]">
                ${(stake + payout).toFixed(2)}
              </span>
            </div>
            <p className="text-[10px] text-[#52525b] mt-1">Potential return · profit ${payout.toFixed(2)}</p>
          </div>

          {/* CTA */}
          <button className="w-full py-2.5 rounded-xl bg-[#00ff7f] text-black text-[13px] font-bold hover:bg-[#00e570] transition-colors flex items-center justify-center gap-2">
            Open in {bookMeta(selectedBook).name}
          </button>

          <div className="flex gap-2">
            <button className="flex-1 py-2 rounded-lg border border-[#1e1e24] text-[11px] text-[#71717a] hover:text-white flex items-center justify-center gap-1.5 transition-colors">
              <Copy className="h-3 w-3" /> Copy
            </button>
            <button className="flex-1 py-2 rounded-lg border border-[#1e1e24] text-[11px] text-[#71717a] hover:text-white flex items-center justify-center gap-1.5 transition-colors">
              <Share2 className="h-3 w-3" /> Share
            </button>
            <button className="flex-1 py-2 rounded-lg border border-[#1e1e24] text-[11px] text-[#71717a] hover:text-white flex items-center justify-center gap-1.5 transition-colors">
              <BookOpen className="h-3 w-3" /> Save
            </button>
          </div>

          <p className="text-[9px] text-[#3f3f46] text-center">ACE is a research tool. Place actual bets on your preferred sportsbook.</p>
        </div>
      )}
    </div>
  );
}
