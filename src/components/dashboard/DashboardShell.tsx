"use client";

import { useMemo, useState } from "react";
import { Game } from "@/types/game";
import GameRow from "@/components/GameRow";
import TopAIPicks from "@/components/TopAIPicks";
import BetSlip from "@/components/BetSlip";
import { Activity, Search, Sparkles, Star, TrendingUp, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

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

const SPORT_EMOJIS: Record<string, string> = {
  ALL: "🏆", NBA: "🏀", NFL: "🏈", MLB: "⚾", NHL: "🏒", NCAAB: "🎓",
};

const SPORTS: SportFilter[] = ["ALL", "NBA", "NFL", "MLB", "NHL", "NCAAB"];

export default function DashboardShell({ games }: { games: Game[] }) {
  const [sport, setSport] = useState<SportFilter>("ALL");
  const [time, setTime] = useState<TimeFilter>("ALL");
  const [query, setQuery] = useState("");
  const [slip, setSlip] = useState<SlipLeg[]>([]);
  const [watchlist, setWatchlist] = useState<Set<string>>(new Set());
  const [aiPicksOnly, setAiPicksOnly] = useState(false);
  const [watchlistOnly, setWatchlistOnly] = useState(false);

  const liveCount = games.filter((g) => g.status === "live").length;

  const sportCounts = useMemo(() => {
    const c: Record<string, number> = { ALL: games.length };
    for (const g of games) {
      const s = g.sport_title.toUpperCase();
      for (const sp of SPORTS.slice(1)) {
        if (s.includes(sp)) c[sp] = (c[sp] || 0) + 1;
      }
    }
    return c;
  }, [games]);

  const filtered = useMemo(() => {
    return games.filter((g) => {
      const sportOk = sport === "ALL" || g.sport_title.toUpperCase().includes(sport);
      const timeOk = time === "ALL"
        || (time === "LIVE" && g.status === "live")
        || (time === "TODAY" && new Date(g.commence_time).toDateString() === new Date().toDateString());
      const q = query.toLowerCase().trim();
      const textOk = !q || `${g.away_team} ${g.home_team} ${g.sport_title}`.toLowerCase().includes(q);
      const wlOk = !watchlistOnly || watchlist.has(g.id);
      return sportOk && timeOk && textOk && wlOk;
    });
  }, [games, sport, time, query, watchlistOnly, watchlist]);

  const liveGames = filtered.filter((g) => g.status === "live");
  const upcomingGames = filtered.filter((g) => g.status !== "live");

  function toggleLeg(leg: SlipLeg) {
    setSlip((prev) => prev.some((x) => x.id === leg.id) ? prev.filter((x) => x.id !== leg.id) : [...prev, leg]);
  }

  function removeLeg(id: string) {
    setSlip((prev) => prev.filter((x) => x.id !== id));
  }

  function toggleWatch(id: string) {
    setWatchlist((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  const selectedIds = slip.map((x) => x.id);

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* ── Main board ─────────────────────────────────────── */}
      <div className="flex flex-col flex-1 overflow-hidden">

        {/* Top header */}
        <div className="shrink-0 border-b border-[#1e1e24] bg-[#09090b]">
          {/* Title row */}
          <div className="flex items-center gap-4 px-6 h-12">
            <h1 className="text-[15px] font-semibold text-white">Today's Games</h1>
            <div className="flex-1 max-w-[420px] ml-2">
              <div className="flex items-center gap-2 bg-[#111113] border border-[#1e1e24] rounded-lg px-3 py-1.5">
                <Search className="h-3.5 w-3.5 text-[#52525b] shrink-0" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search teams, players, sports..."
                  className="bg-transparent outline-none text-[12px] text-white placeholder:text-[#52525b] w-full"
                />
              </div>
            </div>
            <div className="ml-auto flex items-center gap-3 text-[11px] text-[#52525b]">
              <Activity className="h-3.5 w-3.5 text-[#00ff7f]" />
              {liveCount} live · {games.length} total
            </div>
          </div>

          {/* Sport tabs */}
          <div className="flex items-center gap-1 px-4 pb-0 overflow-x-auto scrollbar-hide border-t border-[#1e1e24] pt-2">
            {SPORTS.map((s) => (
              <button
                key={s}
                onClick={() => setSport(s)}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium shrink-0 transition-colors mb-2",
                  sport === s
                    ? "bg-[#00ff7f]/10 text-[#00ff7f] border border-[#00ff7f]/20"
                    : "text-[#71717a] hover:text-white border border-transparent hover:bg-white/5"
                )}
              >
                <span>{SPORT_EMOJIS[s]}</span>
                {s}
                {sportCounts[s] !== undefined && (
                  <span className={cn("text-[10px]", sport === s ? "text-[#00ff7f]/60" : "text-[#3f3f46]")}>
                    {sportCounts[s]}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* AI Picks banner */}
        <TopAIPicks onAddLeg={toggleLeg} />

        {/* Filter bar */}
        <div className="shrink-0 border-b border-[#1e1e24] bg-[#09090b] px-4 py-2 flex items-center gap-3 flex-wrap">
          {/* Time filters */}
          {(["ALL", "LIVE", "TODAY"] as TimeFilter[]).map((t) => (
            <button
              key={t}
              onClick={() => setTime(t)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium border transition-colors",
                time === t
                  ? "border-[#00ff7f]/20 bg-[#00ff7f]/10 text-[#00ff7f]"
                  : "border-transparent text-[#71717a] hover:text-white"
              )}
            >
              {t === "LIVE" && liveCount > 0 && (
                <span className="h-1.5 w-1.5 rounded-full bg-[#ef4444] animate-pulse" />
              )}
              {t === "LIVE" ? `Live (${liveCount})` : t === "ALL" ? "All Games" : t}
            </button>
          ))}

          <div className="h-3.5 w-px bg-[#27272a]" />

          <span className="text-[11px] text-[#52525b]">Filters:</span>

          <button
            onClick={() => setAiPicksOnly(!aiPicksOnly)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium border transition-colors",
              aiPicksOnly ? "border-[#00ff7f]/20 bg-[#00ff7f]/10 text-[#00ff7f]" : "border-[#1e1e24] text-[#52525b] hover:text-white"
            )}
          >
            <Sparkles className="h-3 w-3" /> AI Picks
          </button>

          <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium border border-[#1e1e24] text-[#52525b] hover:text-white transition-colors">
            <Zap className="h-3 w-3" /> 85%+ Confidence
          </button>

          <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium border border-[#1e1e24] text-[#52525b] hover:text-white transition-colors">
            <TrendingUp className="h-3 w-3" /> Line Movement
          </button>

          <button
            onClick={() => setWatchlistOnly(!watchlistOnly)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium border transition-colors",
              watchlistOnly ? "border-[#00ff7f]/20 bg-[#00ff7f]/10 text-[#00ff7f]" : "border-[#1e1e24] text-[#52525b] hover:text-white"
            )}
          >
            <Star className="h-3 w-3" /> Watchlist
            {watchlist.size > 0 && (
              <span className={cn("text-[9px] px-1 rounded-full", watchlistOnly ? "bg-[#00ff7f]/20 text-[#00ff7f]" : "bg-[#27272a] text-[#52525b]")}>
                {watchlist.size}
              </span>
            )}
          </button>

          <div className="ml-auto flex items-center gap-3 text-[11px] text-[#52525b]">
            {watchlist.size > 0 && (
              <span className="flex items-center gap-1"><Star className="h-3 w-3 text-[#00ff7f] fill-[#00ff7f]" />{watchlist.size} watching</span>
            )}
            <span className="flex items-center gap-1"><Sparkles className="h-3 w-3 text-[#00ff7f]" />8 AI picks</span>
          </div>
        </div>

        {/* Column headers */}
        <div
          className="shrink-0 px-4 py-2 pl-5 grid items-center gap-3 border-b border-[#1e1e24] bg-[#0d0d10]"
          style={{ gridTemplateColumns: "minmax(200px,1fr) 70px 70px 70px 32px" }}
        >
          <span className="text-[10px] text-[#52525b] font-semibold uppercase tracking-wider">Game</span>
          <span className="text-[10px] text-[#52525b] font-semibold uppercase tracking-wider text-center">ML</span>
          <span className="text-[10px] text-[#52525b] font-semibold uppercase tracking-wider text-center">Spread</span>
          <span className="text-[10px] text-[#52525b] font-semibold uppercase tracking-wider text-center">Total</span>
          <span className="text-[10px] text-[#52525b] font-semibold uppercase tracking-wider text-center">★</span>
        </div>

        {/* Scrollable board */}
        <div className="flex-1 overflow-y-auto">
          {liveGames.length > 0 && (
            <>
              <div className="flex items-center gap-2 px-5 py-2 bg-[#ef4444]/5 border-b border-[#ef4444]/10">
                <span className="h-1.5 w-1.5 rounded-full bg-[#ef4444] animate-pulse" />
                <span className="text-[10px] font-bold text-[#ef4444] uppercase tracking-wider">Live Now</span>
                <span className="text-[10px] text-[#ef4444]/50 font-semibold">{liveGames.length}</span>
              </div>
              {liveGames.map((g) => (
                <GameRow key={g.id} game={g} onToggleLeg={toggleLeg} selectedIds={selectedIds} watchlisted={watchlist.has(g.id)} onToggleWatch={toggleWatch} />
              ))}
            </>
          )}

          {upcomingGames.length > 0 && (
            <>
              {liveGames.length > 0 && (
                <div className="flex items-center gap-2 px-5 py-2 border-b border-[#1e1e24] bg-[#0d0d10]">
                  <span className="text-[10px] font-bold text-[#52525b] uppercase tracking-wider">Upcoming</span>
                  <span className="text-[10px] text-[#3f3f46]">{upcomingGames.length}</span>
                </div>
              )}
              {upcomingGames.map((g) => (
                <GameRow key={g.id} game={g} onToggleLeg={toggleLeg} selectedIds={selectedIds} watchlisted={watchlist.has(g.id)} onToggleWatch={toggleWatch} />
              ))}
            </>
          )}

          {filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center py-24 gap-2 text-center">
              <p className="text-white font-medium">No games found</p>
              <p className="text-sm text-[#52525b]">Try adjusting your filters</p>
            </div>
          )}
        </div>
      </div>

      {/* ── Right rail — Bet Calculator ─────────────────── */}
      <div className="w-[300px] xl:w-[340px] shrink-0 border-l border-[#1e1e24] overflow-hidden">
        <BetSlip slip={slip} onRemove={removeLeg} onClear={() => setSlip([])} />
      </div>
    </div>
  );
}
