"use client";

import { useMemo, useState } from "react";
import { Game } from "@/types/game";
import GameRow from "@/components/GameRow";
import TopAIPicks from "@/components/TopAIPicks";
import BetSlip from "@/components/BetSlip";
import { Activity, Search, Sparkles, Star, TrendingUp, Zap, ChevronDown, AlertTriangle, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { getSignalsForGame, hasHighSeveritySignal } from "@/lib/signals";

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

const SPORT_LABELS: Record<string, { emoji: string; label: string }> = {
  ALL:   { emoji: "🏆", label: "All" },
  NBA:   { emoji: "🏀", label: "NBA" },
  NFL:   { emoji: "🏈", label: "NFL" },
  MLB:   { emoji: "⚾", label: "MLB" },
  NHL:   { emoji: "🏒", label: "NHL" },
  NCAAB: { emoji: "🎓", label: "NCAAB" },
};

const SPORTS: SportFilter[] = ["ALL", "NBA", "NFL", "MLB", "NHL", "NCAAB"];

export default function DashboardShell({ games }: { games: Game[] }) {
  const [sport, setSport] = useState<SportFilter>("ALL");
  const [time, setTime] = useState<TimeFilter>("ALL");
  const [query, setQuery] = useState("");
  const [slip, setSlip] = useState<SlipLeg[]>([]);
  const [watchlist, setWatchlist] = useState<Set<string>>(new Set());
  const [watchlistOnly, setWatchlistOnly] = useState(false);
  const [signalFilter, setSignalFilter] = useState<"none" | "high" | "volatile" | "new">("none");

  const liveCount = games.filter((g) => g.status === "live").length;

  // Signal counts for slate summary
  const highImpactCount = useMemo(() => {
    return games.filter((g) => hasHighSeveritySignal(g.id, g.home_team, g.away_team)).length;
  }, [games]);

  const signalGameCount = useMemo(() => {
    return games.filter((g) => getSignalsForGame(g.id, g.home_team, g.away_team).length > 0).length;
  }, [games]);

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

      let sigOk = true;
      if (signalFilter === "high") {
        sigOk = hasHighSeveritySignal(g.id, g.home_team, g.away_team);
      } else if (signalFilter === "new" || signalFilter === "volatile") {
        sigOk = getSignalsForGame(g.id, g.home_team, g.away_team).length > 0;
      }

      return sportOk && timeOk && textOk && wlOk && sigOk;
    });
  }, [games, sport, time, query, watchlistOnly, watchlist, signalFilter]);

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
      {/* ── Main board ─────────────────────── */}
      <div className="flex flex-col flex-1 overflow-hidden bg-[#09090b]">

        {/* ── Command bar ──────────────── */}
        <div className="shrink-0 border-b border-[#141417] bg-[#08080a]">
          <div className="flex items-center gap-3 px-5 h-11">
            {/* Sport selector */}
            <div className="flex items-center gap-0.5 bg-[#0c0c0e] border border-[#141417] rounded-lg p-0.5">
              {SPORTS.map((s) => {
                const info = SPORT_LABELS[s];
                const count = sportCounts[s];
                return (
                  <button
                    key={s}
                    onClick={() => setSport(s)}
                    className={cn(
                      "flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-all",
                      sport === s
                        ? "bg-[#141417] text-white shadow-sm"
                        : "text-[#52525b] hover:text-[#a1a1aa]"
                    )}
                  >
                    <span className="text-[10px]">{info.emoji}</span>
                    <span>{info.label}</span>
                    {count !== undefined && count > 0 && (
                      <span className={cn("text-[9px] font-mono", sport === s ? "text-[#00ff7f]" : "text-[#3f3f46]")}>
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Search */}
            <div className="flex-1 max-w-[320px]">
              <div className="flex items-center gap-2 bg-[#0c0c0e] border border-[#141417] rounded-lg px-2.5 py-1.5">
                <Search className="h-3 w-3 text-[#3f3f46] shrink-0" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search teams or matchups..."
                  className="bg-transparent outline-none text-[11px] text-white placeholder:text-[#3f3f46] w-full"
                />
              </div>
            </div>

            {/* Quick filters */}
            <div className="flex items-center gap-1 ml-auto">
              {(["ALL", "LIVE", "TODAY"] as TimeFilter[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTime(t)}
                  className={cn(
                    "flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-semibold transition-all",
                    time === t
                      ? "bg-[#141417] text-white"
                      : "text-[#3f3f46] hover:text-[#71717a]"
                  )}
                >
                  {t === "LIVE" && <span className={cn("h-1.5 w-1.5 rounded-full", liveCount > 0 ? "bg-[#ef4444] animate-pulse" : "bg-[#3f3f46]")} />}
                  {t === "ALL" ? "All" : t === "LIVE" ? `Live ${liveCount}` : "Today"}
                </button>
              ))}

              <div className="h-4 w-px bg-[#141417] mx-1" />

              <button
                onClick={() => setWatchlistOnly(!watchlistOnly)}
                className={cn(
                  "flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-all",
                  watchlistOnly ? "text-[#00ff7f] bg-[#00ff7f]/8" : "text-[#3f3f46] hover:text-[#71717a]"
                )}
              >
                <Star className={cn("h-3 w-3", watchlistOnly && "fill-current")} />
                {watchlist.size > 0 && <span className="font-mono">{watchlist.size}</span>}
              </button>

              <div className="h-4 w-px bg-[#141417] mx-1" />

              {/* Signal filters */}
              <button
                onClick={() => setSignalFilter(signalFilter === "high" ? "none" : "high")}
                className={cn(
                  "flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-all",
                  signalFilter === "high" ? "text-[#ef4444] bg-[#ef4444]/8" : "text-[#3f3f46] hover:text-[#71717a]"
                )}
              >
                <AlertTriangle className="h-3 w-3" />
                High Impact
              </button>

              <button
                onClick={() => setSignalFilter(signalFilter === "volatile" ? "none" : "volatile")}
                className={cn(
                  "flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-all",
                  signalFilter === "volatile" ? "text-[#f59e0b] bg-[#f59e0b]/8" : "text-[#3f3f46] hover:text-[#71717a]"
                )}
              >
                <Zap className="h-3 w-3" />
                Volatile
              </button>

              <button
                onClick={() => setSignalFilter(signalFilter === "new" ? "none" : "new")}
                className={cn(
                  "flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-all",
                  signalFilter === "new" ? "text-[#3b82f6] bg-[#3b82f6]/8" : "text-[#3f3f46] hover:text-[#71717a]"
                )}
              >
                <Clock className="h-3 w-3" />
                New Signals
              </button>
            </div>
          </div>
        </div>

        {/* ── Slate summary ────────────── */}
        <div className="shrink-0 border-b border-[#141417] bg-[#08080a] px-5 py-1.5 flex items-center gap-4">
          <div className="flex items-center gap-1.5 text-[10px]">
            <Activity className="h-3 w-3 text-[#00ff7f]" />
            <span className="text-[#71717a] font-medium">{games.length} games</span>
          </div>
          {liveCount > 0 && (
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#ef4444] animate-pulse" />
              <span className="text-[#ef4444] font-medium">{liveCount} live</span>
            </div>
          )}
          <div className="flex items-center gap-1.5 text-[10px]">
            <Sparkles className="h-3 w-3 text-[#00ff7f]/50" />
            <span className="text-[#3f3f46]">{signalGameCount} with signals</span>
          </div>
          {highImpactCount > 0 && (
            <div className="flex items-center gap-1.5 text-[10px]">
              <AlertTriangle className="h-3 w-3 text-[#ef4444]/50" />
              <span className="text-[#ef4444]/70">{highImpactCount} high impact</span>
            </div>
          )}
          {watchlist.size > 0 && (
            <div className="flex items-center gap-1.5 text-[10px]">
              <Star className="h-3 w-3 text-[#00ff7f]/50 fill-[#00ff7f]/50" />
              <span className="text-[#3f3f46]">{watchlist.size} watching</span>
            </div>
          )}
        </div>

        {/* ── AI Picks ─────────────────── */}
        <TopAIPicks onAddLeg={toggleLeg} />

        {/* ── Column headers ───────────── */}
        <div
          className="shrink-0 px-5 py-1.5 grid items-center gap-2 border-b border-[#141417] bg-[#08080a]"
          style={{ gridTemplateColumns: "minmax(180px,1fr) repeat(3, 80px) 28px" }}
        >
          <span className="text-[9px] text-[#3f3f46] font-semibold uppercase tracking-widest">Matchup</span>
          <span className="text-[9px] text-[#3f3f46] font-semibold uppercase tracking-widest text-center">ML</span>
          <span className="text-[9px] text-[#3f3f46] font-semibold uppercase tracking-widest text-center">Spread</span>
          <span className="text-[9px] text-[#3f3f46] font-semibold uppercase tracking-widest text-center">Total</span>
          <span />
        </div>

        {/* ── Scrollable board ─────────── */}
        <div className="flex-1 overflow-y-auto scrollbar-hide">
          {liveGames.length > 0 && (
            <>
              <div className="flex items-center gap-2 px-5 py-1.5 bg-[#ef4444]/[0.03] border-b border-[#ef4444]/10">
                <span className="h-1.5 w-1.5 rounded-full bg-[#ef4444] animate-pulse" />
                <span className="text-[9px] font-bold text-[#ef4444] uppercase tracking-widest">Live</span>
                <span className="text-[9px] text-[#ef4444]/40 font-mono">{liveGames.length}</span>
              </div>
              {liveGames.map((g) => (
                <GameRow key={g.id} game={g} onToggleLeg={toggleLeg} selectedIds={selectedIds} watchlisted={watchlist.has(g.id)} onToggleWatch={toggleWatch} />
              ))}
            </>
          )}

          {upcomingGames.length > 0 && (
            <>
              {liveGames.length > 0 && (
                <div className="flex items-center gap-2 px-5 py-1.5 border-b border-[#141417] bg-[#08080a]">
                  <span className="text-[9px] font-bold text-[#3f3f46] uppercase tracking-widest">Upcoming</span>
                  <span className="text-[9px] text-[#27272a] font-mono">{upcomingGames.length}</span>
                </div>
              )}
              {upcomingGames.map((g) => (
                <GameRow key={g.id} game={g} onToggleLeg={toggleLeg} selectedIds={selectedIds} watchlisted={watchlist.has(g.id)} onToggleWatch={toggleWatch} />
              ))}
            </>
          )}

          {filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 gap-2 text-center">
              <p className="text-[13px] text-[#52525b] font-medium">No games match your filters</p>
              <p className="text-[11px] text-[#3f3f46]">Try adjusting sport or time filters</p>
            </div>
          )}
        </div>
      </div>

      {/* ── Right rail ─────────────────── */}
      <div className="w-[280px] xl:w-[320px] shrink-0 border-l border-[#141417] overflow-hidden">
        <BetSlip slip={slip} onRemove={removeLeg} onClear={() => setSlip([])} />
      </div>
    </div>
  );
}
