"use client";

import type { ConfidenceRead } from "@/types/signal";
import { cn } from "@/lib/utils";

const TIER_STYLE = {
  high: { text: "text-[#00ff7f]", bg: "bg-[#00ff7f]/8", border: "border-[#00ff7f]/20" },
  medium: { text: "text-[#f59e0b]", bg: "bg-[#f59e0b]/6", border: "border-[#f59e0b]/15" },
  low: { text: "text-[#ef4444]", bg: "bg-[#ef4444]/6", border: "border-[#ef4444]/15" },
};

export function ConfidencePill({ confidence, compact }: { confidence: ConfidenceRead; compact?: boolean }) {
  const s = TIER_STYLE[confidence.tier];

  if (compact) {
    return (
      <span className={cn("inline-flex items-center gap-1 px-1.5 py-[2px] rounded border text-[9px] font-bold font-mono", s.text, s.bg, s.border)}>
        {confidence.pct}%
      </span>
    );
  }

  return (
    <div className={cn("rounded-lg border px-2.5 py-2", s.border, s.bg)}>
      <div className="flex items-center justify-between mb-1">
        <span className={cn("text-[11px] font-bold", s.text)}>{confidence.label}</span>
      </div>
      <p className="text-[10px] text-[#71717a] leading-relaxed">{confidence.explanation}</p>
      {/* Confidence bar */}
      <div className="h-[2px] w-full bg-[#141417] rounded-full mt-1.5 overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{
            width: `${confidence.pct}%`,
            background: confidence.tier === "high" ? "#00ff7f" : confidence.tier === "medium" ? "#f59e0b" : "#ef4444",
          }}
        />
      </div>
    </div>
  );
}
