"use client";

import { cn } from "@/lib/utils";
import { TrendingUp, Plus } from "lucide-react";
import { SlipLeg } from "@/components/dashboard/DashboardShell";

// Placeholder AI picks — Phase 4 replaces with real model output
const PLACEHOLDER_PICKS = [
  {
    id: "ai-1",
    type: "TOTAL",
    confidence: 91,
    pick: "O 228.5",
    game: "GSW @ PHX",
    gameId: "gsw-phx",
    odds: -105,
    reasoning: "Both teams rank top 5 in pace. Last 4 matchups averaged 241 total points. No significant injuries reported.",
    market: "Total",
  },
  {
    id: "ai-2",
    type: "MONEYLINE",
    confidence: 87,
    pick: "LAL",
    game: "BOS @ LAL",
    gameId: "bos-lal",
    odds: -145,
    reasoning: "Lakers are 8-2 in their last 10 home games. LeBron averaging 28.5 PPG this month. Celtics o/u...",
    market: "Moneyline",
  },
  {
    id: "ai-3",
    type: "PLAYER PROP",
    confidence: 84,
    pick: "Stephen Curry Over 28.5",
    game: "GSW @ PHX",
    gameId: "gsw-phx",
    odds: -115,
    reasoning: "Curry has hit this over in 7 of last 10 games. Historically scores 30+ against Phoenix.",
    market: "Player Prop",
  },
];

const TYPE_COLORS: Record<string, string> = {
  TOTAL: "#3b82f6",
  MONEYLINE: "#8b5cf6",
  "PLAYER PROP": "#f59e0b",
};

export default function TopAIPicks({ onAddLeg }: { onAddLeg?: (leg: SlipLeg) => void }) {
  function formatOdds(o: number) {
    return o > 0 ? `+${o}` : `${o}`;
  }

  return (
    <div className="shrink-0 border-b border-[#1e1e24] bg-[#0d0d10]">
      <div className="px-4 py-2 flex items-center gap-2">
        <TrendingUp className="h-3.5 w-3.5 text-[#00ff7f]" />
        <span className="text-[11px] font-bold text-[#00ff7f] uppercase tracking-wider">Top AI Picks</span>
        <span className="text-[11px] text-[#52525b]">3 high confidence picks</span>
        <span className="ml-auto text-[10px] text-[#3f3f46]">Phase 4: live model signals</span>
      </div>

      <div className="flex gap-3 px-4 pb-3 overflow-x-auto scrollbar-hide">
        {PLACEHOLDER_PICKS.map((pick) => (
          <div
            key={pick.id}
            className="shrink-0 w-[220px] rounded-xl border border-[#1e1e24] bg-[#111113] p-3 flex flex-col gap-2"
          >
            <div className="flex items-center justify-between">
              <span
                className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
                style={{ color: TYPE_COLORS[pick.type] ?? "#52525b", background: `${TYPE_COLORS[pick.type] ?? "#52525b"}18` }}
              >
                {pick.type}
              </span>
              <span className="flex items-center gap-1 text-[11px] font-bold text-[#00ff7f]">
                <TrendingUp className="h-2.5 w-2.5" />
                {pick.confidence}%
              </span>
            </div>

            <div>
              <p className="text-[15px] font-bold text-white leading-tight">{pick.pick}</p>
              <p className="text-[10px] text-[#52525b] mt-0.5">{pick.game}</p>
            </div>

            <div className="flex items-center justify-between mt-auto">
              <span className={cn("text-[15px] font-mono font-bold", pick.odds > 0 ? "text-[#00ff7f]" : "text-white")}>
                {formatOdds(pick.odds)}
              </span>
              <button
                onClick={() => onAddLeg?.({
                  id: pick.id,
                  gameId: pick.gameId,
                  matchup: pick.game,
                  market: pick.market,
                  label: pick.pick,
                  odds: pick.odds,
                })}
                className="flex items-center gap-1 text-[11px] font-semibold text-black bg-[#00ff7f] hover:bg-[#00e570] px-2.5 py-1.5 rounded-md transition-colors"
              >
                <Plus className="h-3 w-3" />Add
              </button>
            </div>

            <p className="text-[10px] text-[#52525b] leading-relaxed line-clamp-2 border-t border-[#1e1e24] pt-2">
              {pick.reasoning}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
