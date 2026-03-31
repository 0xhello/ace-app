"use client";

import { cn } from "@/lib/utils";
import { Flame, Plus, TrendingUp } from "lucide-react";
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
    reasoning: "Both teams top-5 pace. Last 4 matchups averaged 241 pts. No key injuries.",
    market: "Total",
    hot: true,
  },
  {
    id: "ai-2",
    type: "MONEYLINE",
    confidence: 87,
    pick: "LAL ML",
    game: "BOS @ LAL",
    gameId: "bos-lal",
    odds: -145,
    reasoning: "Lakers 8-2 last 10 home games. LeBron averaging 28.5 PPG this month.",
    market: "Moneyline",
    hot: false,
  },
  {
    id: "ai-3",
    type: "PROP",
    confidence: 84,
    pick: "Curry O 28.5 pts",
    game: "GSW @ PHX",
    gameId: "gsw-phx",
    odds: -115,
    reasoning: "Curry hit this over in 7 of last 10. Historically scores 30+ vs PHX.",
    market: "Player Prop",
    hot: false,
  },
  {
    id: "ai-4",
    type: "SPREAD",
    confidence: 79,
    pick: "MIL -4.5",
    game: "MIL @ CLE",
    gameId: "mil-cle",
    odds: -108,
    reasoning: "Milwaukee 6-1 ATS as road favorites. Giannis dominant vs Cavs this season.",
    market: "Spread",
    hot: false,
  },
];

const TYPE_STYLE: Record<string, { color: string; bg: string }> = {
  TOTAL:     { color: "#3b82f6", bg: "#3b82f618" },
  MONEYLINE: { color: "#8b5cf6", bg: "#8b5cf618" },
  PROP:      { color: "#f59e0b", bg: "#f59e0b18" },
  SPREAD:    { color: "#00ff7f", bg: "#00ff7f12" },
};

export default function TopAIPicks({ onAddLeg }: { onAddLeg?: (leg: SlipLeg) => void }) {
  function formatOdds(o: number) {
    return o > 0 ? `+${o}` : `${o}`;
  }

  return (
    <div className="shrink-0 border-b border-[#1e1e24] bg-[#0c0c0e]">
      <div className="flex items-center gap-2 px-4 pt-2.5 pb-1.5">
        <TrendingUp className="h-3.5 w-3.5 text-[#00ff7f]" />
        <span className="text-[11px] font-bold text-white uppercase tracking-wider">Top AI Picks</span>
        <span className="text-[11px] text-[#52525b]">{PICKS.length} high confidence</span>
      </div>

      <div className="flex gap-2.5 px-4 pb-3 overflow-x-auto scrollbar-hide">
        {PICKS.map((pick) => {
          const ts = TYPE_STYLE[pick.type] ?? { color: "#52525b", bg: "#52525b18" };
          return (
            <div
              key={pick.id}
              className="shrink-0 w-[195px] rounded-xl border border-[#1e1e24] bg-[#111113] hover:border-[#252528] transition-colors p-2.5 flex flex-col gap-2"
            >
              {/* Top row */}
              <div className="flex items-center justify-between">
                <span
                  className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
                  style={{ color: ts.color, background: ts.bg }}
                >
                  {pick.type}
                </span>
                <div className="flex items-center gap-1.5">
                  {pick.hot && (
                    <span className="flex items-center gap-0.5 text-[9px] font-bold text-[#f59e0b] bg-[#f59e0b15] border border-[#f59e0b25] px-1.5 py-0.5 rounded-full">
                      <Flame className="h-2.5 w-2.5" />HOT
                    </span>
                  )}
                  <span className="text-[11px] font-bold text-[#00ff7f]">{pick.confidence}%</span>
                </div>
              </div>

              {/* Confidence bar */}
              <div className="h-[3px] w-full bg-[#1e1e24] rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full bg-[#00ff7f] transition-all"
                  style={{ width: `${pick.confidence}%` }}
                />
              </div>

              {/* Pick */}
              <div>
                <p className="text-[14px] font-bold text-white leading-tight">{pick.pick}</p>
                <p className="text-[10px] text-[#52525b] mt-0.5">{pick.game}</p>
              </div>

              {/* Odds + Add */}
              <div className="flex items-center justify-between mt-auto">
                <span className={cn("text-[14px] font-mono font-bold", pick.odds > 0 ? "text-[#00ff7f]" : "text-white")}>
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
                  className="flex items-center gap-1 text-[10px] font-bold text-black bg-[#00ff7f] hover:bg-[#00e570] px-2 py-1 rounded-md transition-colors"
                >
                  <Plus className="h-2.5 w-2.5" />Add
                </button>
              </div>

              {/* Reasoning */}
              <p className="text-[10px] text-[#52525b] leading-relaxed line-clamp-2 border-t border-[#1e1e24] pt-1.5">
                {pick.reasoning}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
