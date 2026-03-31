"use client";

import type { Signal, SignalSeverity, SignalType } from "@/types/signal";
import { cn } from "@/lib/utils";
import { AlertTriangle, Cloud, TrendingUp, Brain, Newspaper, Heart } from "lucide-react";

const ICON_MAP: Record<SignalType, typeof AlertTriangle> = {
  injury: Heart,
  weather: Cloud,
  market: TrendingUp,
  confidence: Brain,
  model: Brain,
  news: Newspaper,
};

const SEVERITY_STYLE: Record<SignalSeverity, { border: string; bg: string; text: string; glow?: string }> = {
  high: { border: "border-[#ef4444]/30", bg: "bg-[#ef4444]/8", text: "text-[#ef4444]", glow: "shadow-[0_0_6px_rgba(239,68,68,0.15)]" },
  medium: { border: "border-[#f59e0b]/20", bg: "bg-[#f59e0b]/6", text: "text-[#f59e0b]" },
  low: { border: "border-[#3f3f46]/30", bg: "bg-[#3f3f46]/6", text: "text-[#52525b]" },
};

export function SignalChip({ signal, compact }: { signal: Signal; compact?: boolean }) {
  const Icon = ICON_MAP[signal.type] || AlertTriangle;
  const style = SEVERITY_STYLE[signal.severity];

  if (compact) {
    return (
      <span className={cn("inline-flex items-center gap-1 px-1.5 py-[2px] rounded border text-[8px] font-bold uppercase tracking-widest", style.border, style.bg, style.text, style.glow)}>
        <Icon className="h-2.5 w-2.5" />
        {signal.type}
      </span>
    );
  }

  return (
    <div className={cn("flex items-start gap-2 px-2.5 py-2 rounded-lg border", style.border, style.bg, style.glow)}>
      <Icon className={cn("h-3.5 w-3.5 mt-0.5 shrink-0", style.text)} />
      <div className="min-w-0 flex-1">
        <p className={cn("text-[11px] font-semibold leading-tight", style.text)}>{signal.summary}</p>
        <p className="text-[10px] text-[#52525b] mt-0.5 leading-relaxed">{signal.details}</p>
        {(signal.benefits.length > 0 || signal.harms.length > 0) && (
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5">
            {signal.benefits.map((b, i) => (
              <span key={i} className="text-[9px] text-[#00ff7f]/70">↑ {b}</span>
            ))}
            {signal.harms.map((h, i) => (
              <span key={i} className="text-[9px] text-[#ef4444]/70">↓ {h}</span>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2 mt-1">
          <span className="text-[8px] text-[#3f3f46] uppercase tracking-wider">{signal.certainty}</span>
          {signal.isDemo && <span className="text-[8px] text-[#3f3f46]">· demo</span>}
        </div>
      </div>
    </div>
  );
}

export function SignalSummaryLine({ signal }: { signal: Signal }) {
  const style = SEVERITY_STYLE[signal.severity];
  return (
    <span className={cn("text-[9px] leading-tight", style.text)}>
      {signal.summary}
    </span>
  );
}
