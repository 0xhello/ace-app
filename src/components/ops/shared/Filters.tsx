"use client";

import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SportFilter } from "@/components/ops/shared/ledger";

interface OpsFiltersProps {
  sport: SportFilter;
  onSportChange: (sport: SportFilter) => void;
  query: string;
  onQueryChange: (query: string) => void;
  resultCount: number;
  totalCount: number;
  sports?: SportFilter[];
  placeholder?: string;
}

const LABELS: Record<SportFilter, string> = {
  all: "All",
  mlb: "MLB",
  nba: "NBA",
  soccer: "Soccer",
};

export default function OpsFilters({
  sport,
  onSportChange,
  query,
  onQueryChange,
  resultCount,
  totalCount,
  sports = ["all", "mlb", "nba", "soccer"],
  placeholder = "Search team, market, book…",
}: OpsFiltersProps) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[#181c18] bg-[#0d0f0d] p-3 md:flex-row md:items-center md:justify-between">
      <div className="flex flex-wrap gap-2">
        {sports.map((key) => {
          const active = sport === key;
          return (
            <button
              key={key}
              onClick={() => onSportChange(key)}
              className={cn(
                "rounded-lg border px-3 py-2 text-[10px] font-bold uppercase tracking-[0.16em] transition-colors active:scale-[0.98]",
                active
                  ? "border-[#3ee68a]/30 bg-[#3ee68a]/10 text-[#3ee68a]"
                  : "border-[#22251f] bg-[#0a0b0a] text-[#6b7068] hover:border-[#2e332a] hover:text-[#c4c7c0]",
              )}
              aria-pressed={active}
            >
              {LABELS[key]}
            </button>
          );
        })}
      </div>

      <div className="flex flex-col gap-2 md:min-w-[360px]">
        <label className="sr-only" htmlFor="ops-search">Search rows</label>
        <div className="flex items-center gap-2 rounded-lg border border-[#22251f] bg-[#0a0b0a] px-3 py-2">
          <Search className="h-3.5 w-3.5 text-[#4a524a]" />
          <input
            id="ops-search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={placeholder}
            className="w-full bg-transparent text-[12px] text-[#d7dad4] outline-none placeholder:text-[#4a524a]"
          />
        </div>
        <p className="text-right text-[9px] uppercase tracking-[0.12em] text-[#6b7068]">
          Showing {resultCount} of {totalCount}
        </p>
      </div>
    </div>
  );
}
