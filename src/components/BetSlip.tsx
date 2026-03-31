"use client";

import { cn, formatAmericanOdds } from "@/lib/utils";
import { bookMeta } from "@/lib/books";
import { SlipLeg } from "@/components/dashboard/DashboardShell";
import { X, Plus, Share2, Copy, ExternalLink, ArrowRight, TrendingUp, AlertTriangle } from "lucide-react";
import { useState, useMemo } from "react";

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
  const [stake, setStake] = useState(25);
  const [selectedBook, setSelectedBook] = useState("fanduel");

  const dec = combinedDecimal(slip);
  const payout = stake * (dec - 1);
  const combinedAmerican = slip.length ? toAmerican(dec) : null;
  const impliedProb = slip.length ? (100 / dec).toFixed(1) : null;
  const bm = bookMeta(selectedBook);

  // Simulated routing: show a "better" book suggestion
  const routingSuggestion = useMemo(() => {
    if (slip.length === 0) return null;
    const delta = (Math.random() * 4 + 1).toFixed(2);
    const altBooks = TOP_BOOKS.filter((b) => b !== selectedBook);
    const suggested = altBooks[Math.floor(Math.random() * altBooks.length)];
    return { book: suggested, delta };
  }, [slip.length, selectedBook]);

  return (
    <div className="flex flex-col h-full overflow-hidden bg-[#08080a]">

      {/* Header */}
      <div className="shrink-0 h-12 border-b border-[#141417] flex items-center justify-between px-4">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-bold text-white">Slip</span>
          {slip.length > 0 && (
            <span className="text-[10px] font-mono text-[#00ff7f] bg-[#00ff7f]/8 px-1.5 py-0.5 rounded">
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
            {slip.map((leg, idx) => (
              <div key={leg.id} className="rounded-lg border border-[#141417] bg-[#0c0c0e] p-2.5 group/leg hover:border-[#1e1e24] transition-colors">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-semibold text-white truncate leading-tight">{leg.label}</p>
                    <p className="text-[9px] text-[#3f3f46] mt-0.5 truncate">{leg.matchup}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={cn("text-[12px] font-mono font-bold", leg.odds > 0 ? "text-[#00ff7f]" : "text-white")}>
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
                  {leg.book && (
                    <span className="text-[9px] text-[#3f3f46]">@ {leg.book}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Routing suggestion */}
      {slip.length > 0 && routingSuggestion && (
        <div className="shrink-0 mx-3 mb-2 rounded-lg border border-[#00ff7f]/10 bg-[#00ff7f]/[0.03] px-3 py-2">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-3 w-3 text-[#00ff7f] shrink-0" />
            <p className="text-[10px] text-[#71717a]">
              Save <span className="text-[#00ff7f] font-bold font-mono">${routingSuggestion.delta}</span> at{" "}
              <span className="text-white font-medium">{bookMeta(routingSuggestion.book).name}</span>
            </p>
            <button className="ml-auto text-[9px] text-[#00ff7f] font-bold hover:text-white transition-colors">
              Switch
            </button>
          </div>
        </div>
      )}

      {/* Book selector */}
      {slip.length > 0 && (
        <div className="shrink-0 border-t border-[#141417] px-3 py-2.5">
          <div className="flex items-center gap-1.5">
            {TOP_BOOKS.map((bk) => {
              const m = bookMeta(bk);
              return (
                <button
                  key={bk}
                  onClick={() => setSelectedBook(bk)}
                  title={m.name}
                  className={cn(
                    "flex items-center justify-center h-7 w-7 rounded-md border transition-all",
                    selectedBook === bk
                      ? "border-white/15 bg-white/5"
                      : "border-transparent hover:border-[#1e1e24] hover:bg-[#0f0f11]"
                  )}
                >
                  <span
                    className={cn("h-3 w-3 rounded-full transition-all", selectedBook === bk ? "scale-100" : "scale-75 opacity-40")}
                    style={{ background: m.color }}
                  />
                </button>
              );
            })}
            <span className="ml-2 text-[10px] text-[#52525b] font-medium">{bm.name}</span>
          </div>
        </div>
      )}

      {/* Stake + returns */}
      {slip.length > 0 && (
        <div className="shrink-0 border-t border-[#141417] px-3 py-3 space-y-2.5">
          {/* Stake */}
          <div className="flex items-center gap-1.5">
            {STAKE_PRESETS.map((p) => (
              <button
                key={p}
                onClick={() => setStake(p)}
                className={cn(
                  "flex-1 py-1.5 rounded-md text-[10px] font-bold transition-all",
                  stake === p
                    ? "bg-[#00ff7f]/10 text-[#00ff7f] border border-[#00ff7f]/20"
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

          {/* Return box */}
          <div className="rounded-xl bg-gradient-to-br from-[#00ff7f]/[0.06] to-[#00ff7f]/[0.02] border border-[#00ff7f]/15 p-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[9px] text-[#52525b] uppercase tracking-wider mb-0.5">Potential return</p>
                <p className="text-[10px] text-[#52525b]">
                  ${stake} → <span className="text-white font-mono font-medium">${payout.toFixed(2)}</span> profit
                </p>
              </div>
              <div className="text-right">
                <p className="text-[24px] font-black font-mono text-[#00ff7f] leading-none tracking-tight">
                  ${(stake + payout).toFixed(2)}
                </p>
              </div>
            </div>
          </div>

          {/* CTA */}
          <button className="w-full py-3 rounded-xl bg-[#00ff7f] hover:bg-[#00e570] active:bg-[#00cc5f] text-black text-[12px] font-extrabold transition-all flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(0,255,127,0.15)]">
            Open in {bm.name}
            <ArrowRight className="h-3.5 w-3.5" />
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
      )}
    </div>
  );
}
