"use client";

import { useMemo, useState } from "react";
import { Game } from "@/types/game";
import GameCard from "@/components/GameCard";
import { Activity, Filter, Search, Sparkles, TrendingUp, X } from "lucide-react";
import { cn, formatAmericanOdds } from "@/lib/utils";

type SportFilter = "ALL" | "NBA" | "NFL" | "MLB" | "NHL" | "NCAAB" | "NCAAF";
type TimeFilter = "ALL" | "LIVE" | "TODAY";

export interface SlipLeg {
  id: string;
  gameId: string;
  matchup: string;
  market: string;
  label: string;
  odds: number;
  book?: string;
}

export default function DashboardShell({ games }: { games: Game[] }) {
  const [sportFilter, setSportFilter] = useState<SportFilter>("ALL");
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("ALL");
  const [query, setQuery] = useState("");
  const [slip, setSlip] = useState<SlipLeg[]>([]);

  const filteredGames = useMemo(() => {
    return games.filter((game) => {
      const sportMatch = sportFilter === "ALL" || game.sport_title.toUpperCase() === sportFilter;
      const timeMatch = timeFilter === "ALL"
        || (timeFilter === "LIVE" && game.status === "live")
        || (timeFilter === "TODAY" && new Date(game.commence_time).toDateString() === new Date().toDateString());
      const q = query.trim().toLowerCase();
      const textMatch = !q || `${game.away_team} ${game.home_team} ${game.sport_title}`.toLowerCase().includes(q);
      return sportMatch && timeMatch && textMatch;
    });
  }, [games, sportFilter, timeFilter, query]);

  const liveCount = games.filter((g) => g.status === "live").length;

  function toggleSlip(leg: SlipLeg) {
    setSlip((prev) => prev.some((x) => x.id === leg.id) ? prev.filter((x) => x.id !== leg.id) : [...prev, leg]);
  }

  function removeLeg(id: string) {
    setSlip((prev) => prev.filter((x) => x.id !== id));
  }

  const combinedDecimal = slip.reduce((acc, leg) => {
    const american = leg.odds;
    const dec = american > 0 ? (american / 100 + 1) : (100 / Math.abs(american) + 1);
    return acc * dec;
  }, 1);

  return (
    <div className="p-4 md:p-6 xl:p-8 max-w-[1600px] mx-auto">
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-6">
        <div className="space-y-5">
          <div className="rounded-2xl border border-ace-border bg-ace-card px-4 py-4">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <div className="flex items-center gap-2 text-xs text-ace-secondary mb-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-ace-green animate-pulse" />
                  40+ books synced · live market intelligence
                </div>
                <h1 className="text-2xl md:text-3xl font-semibold tracking-tight text-white">The terminal for sports bettors.</h1>
                <p className="text-sm text-ace-secondary mt-1">Scan the slate, spot the edge, build the ticket.</p>
              </div>
              <div className="flex items-center gap-2 rounded-xl border border-ace-border bg-black/20 px-3 py-2 text-xs text-ace-secondary">
                <Activity className="h-4 w-4 text-ace-green" />
                {liveCount} live · {games.length} total games
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-ace-border bg-ace-card px-4 py-3 flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              {["ALL","NBA","NFL","MLB","NHL","NCAAB"].map((s) => (
                <button
                  key={s}
                  onClick={() => setSportFilter(s as SportFilter)}
                  className={cn(
                    "px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors",
                    sportFilter === s ? "border-ace-green/30 bg-ace-green/10 text-ace-green" : "border-ace-border bg-transparent text-ace-secondary hover:text-white hover:bg-ace-surface"
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex items-center gap-2 flex-wrap">
                {["ALL","LIVE","TODAY"].map((t) => (
                  <button
                    key={t}
                    onClick={() => setTimeFilter(t as TimeFilter)}
                    className={cn(
                      "px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors",
                      timeFilter === t ? "border-ace-green/30 bg-ace-green/10 text-ace-green" : "border-ace-border text-ace-secondary hover:text-white hover:bg-ace-surface"
                    )}
                  >
                    {t === "LIVE" ? `LIVE (${liveCount})` : t}
                  </button>
                ))}
                <div className="ml-1 flex items-center gap-1.5 text-xs text-ace-muted">
                  <Filter className="h-3.5 w-3.5" />
                  ML / Spread / Total inline
                </div>
              </div>
              <div className="flex items-center gap-2 rounded-xl border border-ace-border bg-black/20 px-3 py-2 min-w-[260px]">
                <Search className="h-4 w-4 text-ace-muted" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search teams or leagues"
                  className="bg-transparent outline-none w-full text-sm text-white placeholder:text-ace-muted"
                />
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-ace-border bg-ace-card p-3 flex flex-wrap gap-2 text-xs">
            <div className="px-3 py-2 rounded-lg bg-ace-green/10 text-ace-green border border-ace-green/20 flex items-center gap-2"><Sparkles className="h-3.5 w-3.5" /> AI edge layer coming next</div>
            <div className="px-3 py-2 rounded-lg bg-black/20 text-ace-secondary border border-ace-border">Best-book highlighting live</div>
            <div className="px-3 py-2 rounded-lg bg-black/20 text-ace-secondary border border-ace-border">Slip intelligence active</div>
          </div>

          <div className="space-y-3">
            {filteredGames.map((game) => (
              <GameCard key={game.id} game={game} onToggleLeg={toggleSlip} selectedLegIds={slip.map((x) => x.id)} />
            ))}
          </div>
        </div>

        <aside className="xl:sticky xl:top-6 h-fit space-y-4">
          <div className="rounded-2xl border border-ace-border bg-ace-card overflow-hidden">
            <div className="px-4 py-3 border-b border-ace-border flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-white">Slip</h2>
                <p className="text-xs text-ace-muted">Build while you research</p>
              </div>
              <div className="text-xs px-2 py-1 rounded-full bg-ace-green/10 text-ace-green border border-ace-green/20">{slip.length} legs</div>
            </div>
            <div className="p-4 space-y-3">
              {slip.length === 0 ? (
                <div className="rounded-xl border border-dashed border-ace-border p-6 text-center">
                  <p className="text-sm text-white mb-1">No legs added yet</p>
                  <p className="text-xs text-ace-muted">Click any odds button on the board to start building.</p>
                </div>
              ) : (
                slip.map((leg) => (
                  <div key={leg.id} className="rounded-xl border border-ace-border bg-black/20 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-xs text-ace-muted">{leg.matchup}</p>
                        <p className="text-sm font-medium text-white mt-0.5">{leg.label}</p>
                        <p className="text-xs text-ace-secondary mt-1">{leg.market}{leg.book ? ` · ${leg.book}` : ""}</p>
                      </div>
                      <button onClick={() => removeLeg(leg.id)} className="text-ace-muted hover:text-white"><X className="h-4 w-4" /></button>
                    </div>
                    <div className="mt-2 text-sm font-mono font-semibold text-ace-green">{formatAmericanOdds(leg.odds)}</div>
                  </div>
                ))
              )}
            </div>
            <div className="border-t border-ace-border p-4 space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-ace-secondary">Combined decimal</span>
                <span className="text-white font-mono">{slip.length ? combinedDecimal.toFixed(2) : "—"}</span>
              </div>
              <div className="rounded-xl bg-ace-green/10 border border-ace-green/20 p-3">
                <p className="text-xs uppercase tracking-wide text-ace-green font-semibold mb-1">Slip intelligence</p>
                <p className="text-sm text-white">{slip.length < 2 ? "Add more legs to see correlation and execution guidance." : "Good start. Next layer: correlation checks, playability, and best-book routing."}</p>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-ace-border bg-ace-card p-4">
            <h3 className="text-sm font-semibold text-white mb-3">Market tape</h3>
            <div className="space-y-2 text-xs">
              <div className="rounded-lg bg-black/20 border border-ace-border px-3 py-2 text-ace-secondary">BOS ML improved across 2 books</div>
              <div className="rounded-lg bg-black/20 border border-ace-border px-3 py-2 text-ace-secondary">Totals disagreement detected on late slate</div>
              <div className="rounded-lg bg-black/20 border border-ace-border px-3 py-2 text-ace-secondary">AI signal lane plugs in next phase</div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
