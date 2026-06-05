"use client";

import { cn } from "@/lib/utils";
import type { OpsSportKey } from "@/components/ops/config/sports";
import { OPS_SPORTS } from "@/components/ops/config/sports";

interface OpsTabBarProps {
  activeSport: OpsSportKey;
  onChange: (sport: OpsSportKey) => void;
}

export default function OpsTabBar({ activeSport, onChange }: OpsTabBarProps) {
  return (
    <div className="border-b border-[#181c18] bg-[#0a0b0a] px-4 sm:px-6">
      <div className="mx-auto flex max-w-[1200px] items-center gap-2 overflow-x-auto py-3">
        {OPS_SPORTS.map((sport) => {
          const active = sport.key === activeSport;
          return (
            <div key={sport.key} className="flex items-center gap-2">
              <button
                onClick={() => onChange(sport.key)}
                className={cn(
                  "flex items-center gap-2 rounded-lg border px-3 py-2 text-[10px] font-bold uppercase tracking-[0.18em] transition-colors",
                  active
                    ? "border-[#3ee68a]/30 bg-[#3ee68a]/10 text-[#3ee68a]"
                    : "border-[#1e2220] bg-[#0d0f0d] text-[#4a524a] hover:border-[#2e332a] hover:text-[#9ca39a]"
                )}
                aria-pressed={active}
              >
                <span>{sport.label}</span>
                {sport.status !== "live" && (
                  <span className="rounded border border-[#2e332a] px-1.5 py-0.5 text-[8px] tracking-[0.12em] text-[#6b7068]">
                    {sport.status}
                  </span>
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
