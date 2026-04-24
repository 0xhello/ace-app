"use client";

import { cn } from "@/lib/utils";
import { Sparkles, Plus, TrendingUp } from "lucide-react";
import { SlipLeg } from "@/components/dashboard/DashboardShell";
import { generateAIPicks } from "@/lib/signals";

const TYPE_COLOR: Record<string, { text: string; bg: string }> = {
  TOTAL:  { text: "text-[#3b82f6]",  bg: "bg-[#3b82f6]/10" },
  ML:     { text: "text-[#8b5cf6]",  bg: "bg-[#8b5cf6]/10" },
  PROP:   { text: "text-[#f59e0b]",  bg: "bg-[#f59e0b]/10" },
  SPREAD: { text: "text-[#3ee68a]",  bg: "bg-[#3ee68a]/10" },
};

const TIER_COLOR: Record<string, string> = {
  high:   "#3ee68a",
  medium: "#f59e0b",
  low:    "#ef4444",
};

export default function TopAIPicks({ onAddLeg, picks }: { onAddLeg?: (leg: SlipLeg) => void; picks?: any[] }) {
  const resolvedPicks = picks && picks.length > 0 ? picks : generateAIPicks();

  return (
    <div className="shrink-0 border-b border-[#22251f] bg-[#0a0b0a]">
      {/* Header */}
      <div className="flex items-center justify-between px-5 pt-2.5 pb-2">
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center h-5 w-5 rounded-md bg-[#3ee68a]/10">
            <Sparkles className="h-3 w-3 text-[#3ee68a]" />
          </div>
          <span className="text-[11px] font-bold text-white uppercase tracking-widest">Signal Feed</span>
          <span className="text-[10px] text-[#6b7068] font-normal">Real-time edge detection</span>
        </div>
        <button className="text-[10px] text-[#6b7068] hover:text-[#9ca39a] transition-colors">
          View all →
        </button>
      </div>

      {/* Cards */}
      <div className="flex gap-2.5 px-5 pb-3 overflow-x-auto scrollbar-hide">
        {resolvedPicks.map((pick) => {
          const typeStyle = TYPE_COLOR[pick.type] ?? { text: "text-[#6b7068]", bg: "bg-[#6b7068]/10" };
          const tierColor = TIER_COLOR[pick.confidence?.tier ?? "low"];
          const confPct = pick.confidence?.pct ?? 0;

          return (
            <div
              key={pick.id}
              className="shrink-0 w-[272px] rounded-xl border border-[#22251f] bg-[#121412] hover:border-[#2e332a] transition-all p-3 flex flex-col gap-2 group cursor-default"
            >
              {/* Row 1: matchup pill + type + confidence */}
              <div className="flex items-center justify-between gap-2">
                <span className="text-[9px] font-semibold text-[#6b7068] bg-[#22251f] px-2 py-[3px] rounded-full truncate max-w-[120px]">
                  {pick.game}
                </span>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className={cn("text-[8px] font-bold uppercase tracking-wider px-1.5 py-[2px] rounded", typeStyle.text, typeStyle.bg)}>
                    {pick.type}
                  </span>
                  <span className="text-[9px] font-bold font-mono" style={{ color: tierColor }}>
                    {confPct}%
                  </span>
                </div>
              </div>

              {/* Row 2: pick title + odds */}
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-[15px] font-extrabold text-white leading-tight tracking-tight truncate">
                  {pick.pick}
                </p>
                <span className={cn("text-[13px] font-mono font-bold shrink-0", pick.odds > 0 ? "text-[#3ee68a]" : "text-[#d4d7d0]")}>
                  {pick.odds > 0 ? `+${pick.odds}` : pick.odds}
                </span>
              </div>

              {/* Row 3: reasoning */}
              <p className="text-[10px] text-[#6b7068] leading-relaxed line-clamp-2 flex-1">
                {pick.reasoning}
              </p>

              {/* Row 4: edge + add button */}
              <div className="flex items-center justify-between pt-2 border-t border-[#22251f]">
                <div className="flex items-center gap-1.5">
                  <div className="flex items-center gap-1 bg-[#3ee68a]/[0.06] border border-[#3ee68a]/15 px-2 py-[3px] rounded-md">
                    <TrendingUp className="h-2.5 w-2.5 text-[#3ee68a]" />
                    <span className="text-[9px] font-bold text-[#3ee68a] font-mono">{pick.edge}</span>
                  </div>
                </div>
                <button
                  onClick={() => onAddLeg?.({
                    id: pick.id,
                    gameId: pick.gameId,
                    matchup: pick.game,
                    market: pick.market,
                    label: pick.pick,
                    odds: pick.odds,
                  })}
                  className="flex items-center gap-1 px-2.5 py-[5px] rounded-md bg-[#3ee68a]/8 border border-[#3ee68a]/15 text-[9px] font-bold text-[#3ee68a] hover:bg-[#3ee68a]/15 transition-all opacity-60 group-hover:opacity-100"
                >
                  <Plus className="h-2.5 w-2.5" /> Add to slip
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
