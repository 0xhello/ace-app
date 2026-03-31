"use client";

import { useMemo, useState } from "react";
import { Game } from "@/types/game";
import GameRow from "@/components/GameRow";
import { Activity, Search, Sparkles, TrendingUp, X, ChevronRight, Plus } from "lucide-react";
import { cn, formatAmericanOdds } from "@/lib/utils";

type SportFilter = "ALL" | "NBA" | "NFL" | "MLB" | "NHL" | "NCAAB";
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

function slipDecimal(odds: number) {
  return odds > 0 ? odds / 100 + 1 : 100 / Math.abs(odds) + 1;
}

export default function DashboardShell({ games }: { games: Game[] }) {
  const [sport, setSport] = useState<SportFilter>("ALL");
  const [time, setTime] = useState<TimeFilter>("ALL");
  const [query, setQuery] = useState("");
  const [slip, setSlip] = useState<SlipLeg[]>([]);
  const [watchlist, setWatchlist] = useState<Set<string>>(new Set());

  const liveCount = games.filter((g) => g.status === "live").length;

  const filtered = useMemo(() => {
    return games.filter((g) => {
      const sportOk = sport === "ALL" || g.sport_title.toUpperCase().includes(sport);
      const timeOk =
        time === "ALL" ||
        (time === "LIVE" && g.status === "live") ||
        (time === "TODAY" && new Date(g.commence_time).toDateString() === new Date().toDateString());
      const q = query.toLowerCase().trim();
      const textOk = !q || `${g.away_team} ${g.home_team} ${g.sport_title}`.toLowerCase().includes(q);
      return sportOk && timeOk && textOk;
    });
  }, [games, sport, time, query]);

  const liveGames = filtered.filter((g) => g.status === "live");
  const upcomingGames = filtered.filter((g) => g.status !== "live");

  function toggleLeg(leg: SlipLeg) {
    setSlip((prev) => prev.some((x) => x.id === leg.id) ? prev.filter((x) => x.id !== leg.id) : [...prev, leg]);
  }

  function removeLeg(id: string) {
    setSlip((prev) => prev.filter((x) => x.id !== id));
  }

  function toggleWatch(id: string) {
    setWatchlist((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const combinedDecimal = slip.reduce((acc, l) => acc * slipDecimal(l.odds), 1);
  const combinedAmerican = combinedDecimal >= 2 ? Math.round((combinedDecimal - 1) * 100) : Math.round(-100 / (combinedDecimal - 1));
  const selectedIds = slip.map((x) => x.id);

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* ── Main board ─────────────────────────────────── */}
      <div className="flex flex-col flex-1 overflow-hidden">

        {/* Top bar */}
        <div className="shrink-0 h-14 border-b border-[#1e1e24] flex items-center gap-3 px-4">
          {/* Sport pills */}
          <div className="flex items-center gap-1 overflow-x-auto scrollbar-hide">
            {(["ALL", "NBA", "NFL", "MLB", "NHL", "NCAAB"] as SportFilter[]).map((s) => (
              <button
                key={s}
                onClick={() => setSport(s)}
                className={cn(
                  "px-3 py-1 rounded-md text-[12px] font-medium shrink-0 transition-colors",
                  sport === s
                    ? "bg-[#00ff7f]/10 text-[#00ff7f] border border-[#00ff7f]/20"
                    : "text-[#71717a] hover:text-white"
                )}
              >
                {s}
              </button>
            ))}
          </div>

          <div className="h-4 w-px bg-[#27272a] shrink-0" />

          {/* Time pills */}
          <div className="flex items-center gap-1">
            {(["ALL", "LIVE", "TODAY"] as TimeFilter[]).map((t) => (
              <button
                key={t}
                onClick={() => setTime(t)}
                className={cn(
                  "px-3 py-1 rounded-md text-[12px] font-medium transition-colors flex items-center gap-1.5",
                  time === t
                    ? "bg-[#00ff7f]/10 text-[#00ff7f] border border-[#00ff7f]/20"
                    : "text-[#71717a] hover:text-white"
                )}
              >
                {t === "LIVE" && liveCount > 0 && (
                  <span className="h-1.5 w-1.5 rounded-full bg-[#ef4444] animate-pulse" />
                )}
                {t === "LIVE" ? `LIVE (${liveCount})` : t}
              </button>
            ))}
          </div>

          <div className="flex-1" />

          {/* Search */}
          <div className="flex items-center gap-2 bg-[#111113] border border-[#1e1e24] rounded-lg px-3 py-1.5 w-52">
            <Search className="h-3.5 w-3.5 text-[#52525b] shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search teams…"
              className="bg-transparent outline-none text-[12px] text-white placeholder:text-[#52525b] w-full"
            />
          </div>

          {/* Live status */}
          <div className="flex items-center gap-2 text-[11px] text-[#52525b] shrink-0">
            <Activity className="h-3.5 w-3.5 text-[#00ff7f]" />
            {games.length} games · {liveCount} live
          </div>
        </div>

        {/* Intelligence strip */}
        <div className="shrink-0 border-b border-[#1e1e24] bg-[#0d0d10] px-4 py-2 flex items-center gap-2 overflow-x-auto scrollbar-hide">
          <span className="text-[10px] font-semibold text-[#52525b] uppercase tracking-wider shrink-0">SIGNALS</span>
          <div className="flex items-center gap-2">
            {[
              { text: "AI edge layer · coming next", accent: true },
              { text: "Best-book live", accent: false },
              { text: "Line movement tracking · Phase 4", accent: false },
              { text: "Playability scores · Phase 4", accent: false },
            ].map((item, i) => (
              <div key={i} className={cn(
                "flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] shrink-0",
                item.accent ? "border-[#00ff7f]/20 bg-[#00ff7f]/8 text-[#00ff7f]" : "border-[#1e1e24] text-[#52525b]"
              )}>
                {item.accent && <Sparkles className="h-3 w-3" />}
                {item.text}
              </div>
            ))}
          </div>
        </div>

        {/* Board headers */}
        <div className="shrink-0 px-4 py-2 grid items-center gap-3 border-b border-[#1e1e24]" style={{ gridTemplateColumns: "1fr auto auto auto auto" }}>
          <span className="text-[10px] text-[#52525b] font-semibold uppercase tracking-wider">Game</span>
          <span className="text-[10px] text-[#52525b] font-semibold uppercase tracking-wider w-[58px] text-center">ML</span>
          <span className="text-[10px] text-[#52525b] font-semibold uppercase tracking-wider w-[58px] text-center">Spread</span>
          <span className="text-[10px] text-[#52525b] font-semibold uppercase tracking-wider w-[58px] text-center">Total</span>
          <span className="text-[10px] text-[#52525b] font-semibold uppercase tracking-wider w-[46px] text-center">Watch</span>
        </div>

        {/* Game rows — scrollable */}
        <div className="flex-1 overflow-y-auto">
          {liveGames.length > 0 && (
            <div>
              <div className="flex items-center gap-2 px-4 py-2 bg-[#ef4444]/5 border-b border-[#ef4444]/10">
                <span className="h-1.5 w-1.5 rounded-full bg-[#ef4444] animate-pulse" />
                <span className="text-[11px] font-semibold text-[#ef4444] uppercase tracking-wider">Live Now</span>
                <span className="text-[11px] text-[#ef4444]/60">({liveGames.length})</span>
              </div>
              {liveGames.map((g) => (
                <GameRow key={g.id} game={g} onToggleLeg={toggleLeg} selectedIds={selectedIds} watchlisted={watchlist.has(g.id)} onToggleWatch={toggleWatch} />
              ))}
            </div>
          )}

          {upcomingGames.length > 0 && (
            <div>
              {liveGames.length > 0 && (
                <div className="flex items-center gap-2 px-4 py-2 border-b border-[#1e1e24] bg-[#0d0d10]">
                  <span className="text-[11px] font-semibold text-[#52525b] uppercase tracking-wider">Upcoming</span>
                  <span className="text-[11px] text-[#3f3f46]">({upcomingGames.length})</span>
                </div>
              )}
              {upcomingGames.map((g) => (
                <GameRow key={g.id} game={g} onToggleLeg={toggleLeg} selectedIds={selectedIds} watchlisted={watchlist.has(g.id)} onToggleWatch={toggleWatch} />
              ))}
            </div>
          )}

          {filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center py-24 gap-2 text-center">
              <p className="text-white font-medium">No games found</p>
              <p className="text-sm text-[#52525b]">Try adjusting your filters</p>
            </div>
          )}
        </div>
      </div>

      {/* ── Right rail ─────────────────────────────────── */}
      <div className="w-[320px] shrink-0 border-l border-[#1e1e24] flex flex-col overflow-hidden">

        {/* Slip header */}
        <div className="shrink-0 h-14 border-b border-[#1e1e24] flex items-center justify-between px-4">
          <div>
            <h2 className="text-[13px] font-semibold text-white">Slip</h2>
            <p className="text-[10px] text-[#52525b]">Click odds to add legs</p>
          </div>
          {slip.length > 0 && (
            <button onClick={() => setSlip([])} className="text-[11px] text-[#52525b] hover:text-white transition-colors">Clear all</button>
          )}
        </div>

        {/* Slip body */}
        <div className="flex-1 overflow-y-auto">
          {slip.length === 0 ? (
            <div className="flex flex-col items-center justify-center px-6 py-10 gap-3 text-center">
              <div className="h-10 w-10 rounded-xl border border-dashed border-[#27272a] flex items-center justify-center">
                <Plus className="h-5 w-5 text-[#3f3f46]" />
              </div>
              <p className="text-[13px] font-medium text-white">No legs added</p>
              <p className="text-[11px] text-[#52525b] leading-relaxed">Click any odds button on the board to start building your slip.</p>
            </div>
          ) : (
            <div className="p-3 space-y-2">
              {slip.map((leg) => (
                <div key={leg.id} className="rounded-lg border border-[#1e1e24] bg-[#111113] p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-[10px] text-[#52525b] truncate">{leg.matchup}</p>
                      <p className="text-[12px] font-medium text-white mt-0.5 truncate">{leg.label}</p>
                      <p className="text-[10px] text-[#52525b] mt-0.5">{leg.market}{leg.book ? ` · ${leg.book}` : ""}</p>
                    </div>
                    <button onClick={() => removeLeg(leg.id)} className="text-[#3f3f46] hover:text-white shrink-0 mt-0.5">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className={cn("mt-2 text-[13px] font-mono font-bold", leg.odds > 0 ? "text-[#00ff7f]" : "text-white")}>
                    {formatAmericanOdds(leg.odds)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Slip footer — combined odds */}
        {slip.length >= 2 && (
          <div className="shrink-0 border-t border-[#1e1e24] p-4 space-y-3">
            <div className="flex items-center justify-between text-[12px]">
              <span className="text-[#71717a]">Combined odds</span>
              <span className="text-white font-mono font-semibold">{formatAmericanOdds(combinedAmerican)}</span>
            </div>
            <div className="flex items-center justify-between text-[12px]">
              <span className="text-[#71717a]">Implied prob.</span>
              <span className="text-white font-mono">{(100 / combinedDecimal).toFixed(1)}%</span>
            </div>
            <div className="flex items-center justify-between text-[12px]">
              <span className="text-[#71717a]">$100 returns</span>
              <span className="text-[#00ff7f] font-mono font-semibold">${((combinedDecimal - 1) * 100).toFixed(2)}</span>
            </div>
          </div>
        )}

        {/* Intelligence zone */}
        <div className="shrink-0 border-t border-[#1e1e24]">
          <div className="px-4 py-3 border-b border-[#1e1e24]">
            <p className="text-[10px] font-semibold text-[#52525b] uppercase tracking-wider mb-2">Slip Intelligence</p>
            <div className="rounded-lg border border-[#00ff7f]/15 bg-[#00ff7f]/6 p-3">
              <p className="text-[11px] text-[#00ff7f] font-semibold mb-1">Coming in Phase 3</p>
              <p className="text-[11px] text-[#52525b] leading-relaxed">Correlation warnings, playability status, best-book execution routing, and EV estimates.</p>
            </div>
          </div>

          {/* Market tape */}
          <div className="px-4 py-3">
            <p className="text-[10px] font-semibold text-[#52525b] uppercase tracking-wider mb-2">Market Tape</p>
            <div className="space-y-1.5">
              {[
                "Line movement detection active in Phase 4",
                "AI signal lane wires in Phase 4",
                "40+ books synced · refreshing",
              ].map((t, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px] text-[#52525b] py-1">
                  <ChevronRight className="h-3 w-3 shrink-0" />
                  {t}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
