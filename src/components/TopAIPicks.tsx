"use client";

import { cn } from "@/lib/utils";
import { Plus, Zap } from "lucide-react";
import { SlipLeg } from "@/components/dashboard/DashboardShell";
import { ConfidencePill } from "@/components/ConfidenceBadge";
import { generateAIPicks } from "@/lib/signals";

const TAG_STYLE: Record<string, { text: string; bg: string; border: string }> = {
  stable:   { text: "text-[#00ff7f]", bg: "bg-[#00ff7f]/8", border: "border-[#00ff7f]/15" },
  volatile: { text: "text-[#f59e0b]", bg: "bg-[#f59e0b]/6", border: "border-[#f59e0b]/15" },
  watch:    { text: "text-[#3b82f6]", bg: "bg-[#3b82f6]/6", border: "border-[#3b82f6]/15" },
};

const TYPE_COLOR: Record<string, string> = {
  TOTAL: "#3b82f6",
  ML: "#8b5cf6",
  PROP: "#f59e0b",
  SPREAD: "#00ff7f",
};

export default function TopAIPicks({ onAddLeg, picks }: { onAddLeg?: (leg: SlipLeg) => void; picks?: any[] }) {
  const resolvedPicks = picks && picks.length > 0 ? picks : generateAIPicks();

  return (
    <div className="shrink-0 border-b border-[#141417] bg-[#08080a]/80">
      <div className="flex items-center justify-between px-5 pt-2.5 pb-1">
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center h-5 w-5 rounded-md bg-[#00ff7f]/10">
            <Zap className="h-3 w-3 text-[#00ff7f]" />
          </div>
          <span className="text-[11px] font-bold text-white uppercase tracking-widest">AI Picks</span>
          <span className="text-[10px] text-[#3f3f46] font-mono">{resolvedPicks.length} signals</span>
        </div>
        <button className="text-[10px] text-[#3f3f46] hover:text-[#71717a] transition-colors">View all →</button>
      </div>

      <div className="flex gap-2 px-5 pb-2.5 overflow-x-auto scrollbar-hide">
        {resolvedPicks.map((pick) => {
          const color = TYPE_COLOR[pick.type] ?? "#52525b";
          const tagStyle = TAG_STYLE[pick.tag] ?? TAG_STYLE.stable;

          return (
            <div
              key={pick.id}
              className="shrink-0 w-[200px] rounded-lg border border-[#141417] bg-[#0c0c0e] hover:border-[#1e1e24] transition-all p-2.5 flex flex-col gap-1.5 group cursor-default"
            >
              <div className="flex items-center justify-between">
                <span
                  className="text-[8px] font-bold uppercase tracking-widest px-1.5 py-[2px] rounded"
                  style={{ color, background: `${color}15` }}
                >
                  {pick.type}
                </span>
                <span className={cn("text-[8px] font-bold uppercase tracking-widest px-1.5 py-[2px] rounded border", tagStyle.text, tagStyle.bg, tagStyle.border)}>
                  {pick.tag}
                </span>
              </div>

              <ConfidencePill confidence={pick.confidence} compact />

              <div className="flex items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[13px] font-bold text-white leading-tight truncate">{pick.pick}</p>
                  <p className="text-[9px] text-[#3f3f46] mt-px">{pick.game}</p>
                </div>
                <span className={cn("text-[13px] font-mono font-bold shrink-0", pick.odds > 0 ? "text-[#00ff7f]" : "text-white")}>
                  {pick.odds > 0 ? `+${pick.odds}` : pick.odds}
                </span>
              </div>

              <p className="text-[10px] text-[#71717a] leading-relaxed line-clamp-2">
                {pick.reasoning}
              </p>

              <div className="flex items-center justify-between pt-1.5 border-t border-[#141417]">
                <span className="text-[9px] font-mono text-[#00ff7f]/70">{pick.edge} edge</span>
                <button
                  onClick={() => onAddLeg?.({
                    id: pick.id,
                    gameId: pick.gameId,
                    matchup: pick.game,
                    market: pick.market,
                    label: pick.pick,
                    odds: pick.odds,
                  })}
                  className="flex items-center gap-0.5 text-[9px] font-bold text-[#00ff7f] hover:text-white transition-colors opacity-60 group-hover:opacity-100"
                >
                  <Plus className="h-2.5 w-2.5" />Add
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
