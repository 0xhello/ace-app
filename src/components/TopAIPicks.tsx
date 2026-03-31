"use client";

import { cn } from "@/lib/utils";
import { Flame, Plus, TrendingUp, Zap } from "lucide-react";
import { SlipLeg } from "@/components/dashboard/DashboardShell";

const PICKS = [
  {
    id: "ai-1",
    type: "TOTAL",
    confidence: 91,
    pick: "O 228.5",
    game: "GSW @ PHX",
    gameId: "gsw-phx",
    odds: -105,
    reasoning: "Both teams top-5 pace. Last 4 H2H averaged 241 pts.",
    market: "Total",
    hot: true,
    edge: "+4.2%",
  },
  {
    id: "ai-2",
    type: "ML",
    confidence: 87,
    pick: "LAL ML",
    game: "BOS @ LAL",
    gameId: "bos-lal",
    odds: -145,
    reasoning: "Lakers 8-2 L10 home. LeBron 28.5 PPG this month.",
    market: "Moneyline",
    hot: false,
    edge: "+3.1%",
  },
  {
    id: "ai-3",
    type: "PROP",
    confidence: 84,
    pick: "Curry O 28.5",
    game: "GSW @ PHX",
    gameId: "gsw-phx",
    odds: -115,
    reasoning: "Hit over 7 of L10. Averages 30+ vs PHX historically.",
    market: "Player Prop",
    hot: false,
    edge: "+2.8%",
  },
  {
    id: "ai-4",
    type: "SPREAD",
    confidence: 79,
    pick: "MIL -4.5",
    game: "MIL @ CLE",
    gameId: "mil-cle",
    odds: -108,
    reasoning: "Milwaukee 6-1 ATS as road favorites this season.",
    market: "Spread",
    hot: false,
    edge: "+1.9%",
  },
];

const TYPE_STYLE: Record<string, string> = {
  TOTAL: "#3b82f6",
  ML: "#8b5cf6",
  PROP: "#f59e0b",
  SPREAD: "#00ff7f",
};

export default function TopAIPicks({ onAddLeg }: { onAddLeg?: (leg: SlipLeg) => void }) {
  return (
    <div className="shrink-0 border-b border-[#141417] bg-[#08080a]/80">
      <div className="flex items-center justify-between px-5 pt-2.5 pb-1">
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center h-5 w-5 rounded-md bg-[#00ff7f]/10">
            <Zap className="h-3 w-3 text-[#00ff7f]" />
          </div>
          <span className="text-[11px] font-bold text-white uppercase tracking-widest">AI Picks</span>
          <span className="text-[10px] text-[#3f3f46] font-mono">{PICKS.length} signals</span>
        </div>
        <button className="text-[10px] text-[#3f3f46] hover:text-[#71717a] transition-colors">View all →</button>
      </div>

      <div className="flex gap-2 px-5 pb-2.5 overflow-x-auto scrollbar-hide">
        {PICKS.map((pick) => {
          const color = TYPE_STYLE[pick.type] ?? "#52525b";
          return (
            <div
              key={pick.id}
              className="shrink-0 w-[180px] rounded-lg border border-[#141417] bg-[#0c0c0e] hover:border-[#1e1e24] transition-all p-2.5 flex flex-col gap-1.5 group cursor-default"
            >
              {/* Header */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span
                    className="text-[8px] font-bold uppercase tracking-widest px-1.5 py-[2px] rounded"
                    style={{ color, background: `${color}15` }}
                  >
                    {pick.type}
                  </span>
                  {pick.hot && (
                    <Flame className="h-3 w-3 text-[#f59e0b] drop-shadow-[0_0_3px_rgba(245,158,11,0.4)]" />
                  )}
                </div>
                <span className="text-[10px] font-bold text-[#00ff7f] font-mono">{pick.confidence}%</span>
              </div>

              {/* Confidence bar */}
              <div className="h-[2px] w-full bg-[#141417] rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{ width: `${pick.confidence}%`, background: `linear-gradient(90deg, ${color}, #00ff7f)` }}
                />
              </div>

              {/* Pick + odds */}
              <div className="flex items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[13px] font-bold text-white leading-tight truncate">{pick.pick}</p>
                  <p className="text-[9px] text-[#3f3f46] mt-px">{pick.game}</p>
                </div>
                <span className={cn("text-[13px] font-mono font-bold shrink-0", pick.odds > 0 ? "text-[#00ff7f]" : "text-white")}>
                  {pick.odds > 0 ? `+${pick.odds}` : pick.odds}
                </span>
              </div>

              {/* Edge + Add */}
              <div className="flex items-center justify-between pt-1 border-t border-[#141417]">
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
