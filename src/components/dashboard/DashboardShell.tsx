"use client";

import { useMemo, useState, useEffect, useRef, useCallback } from "react";
import { Game } from "@/types/game";
import GameRow from "@/components/GameRow";
import TopAIPicks from "@/components/TopAIPicks";
import BetSlip from "@/components/BetSlip";
import GameDetailPanel from "@/components/GameDetailPanel";
import NotificationBell from "@/components/NotificationBell";
import { Search, Sparkles, Star, AlertTriangle, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { getSignalsForGame, hasHighSeveritySignal } from "@/lib/signals";
import { checkAlerts, fireNotification } from "@/lib/alerts";

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

function extractBestOdds(game: Game): Record<string, number | null> {
  const bk = game.bookmakers;
  const best = (arr: number[]) => (arr.length ? Math.max(...arr) : null);
  return {
    "ml-away": best(bk.flatMap((b) => (b.markets.h2h || []).filter((o) => o.name === game.away_team).map((o) => o.price))),
    "ml-home": best(bk.flatMap((b) => (b.markets.h2h || []).filter((o) => o.name === game.home_team).map((o) => o.price))),
    "sp-away": best(bk.flatMap((b) => (b.markets.spreads || []).filter((o) => o.name === game.away_team).map((o) => o.price))),
    "sp-home": best(bk.flatMap((b) => (b.markets.spreads || []).filter((o) => o.name === game.home_team).map((o) => o.price))),
    "ov":      best(bk.flatMap((b) => (b.markets.totals || []).filter((o) => o.name === "Over").map((o) => o.price))),
    "un":      best(bk.flatMap((b) => (b.markets.totals || []).filter((o) => o.name === "Under").map((o) => o.price))),
  };
}

function computeMovementMap(prev: Game[], next: Game[]): Record<string, Record<string, "up" | "down">> {
  const result: Record<string, Record<string, "up" | "down">> = {};
  for (const ng of next) {
    const pg = prev.find((g) => g.id === ng.id);
    if (!pg) continue;
    const po = extractBestOdds(pg);
    const no = extractBestOdds(ng);
    const mv: Record<string, "up" | "down"> = {};
    for (const k of Object.keys(po)) {
      const p = po[k], n = no[k];
      if (p !== null && n !== null && p !== n) mv[k] = n > p ? "up" : "down";
    }
    if (Object.keys(mv).length) result[ng.id] = mv;
  }
  return result;
}

export default function DashboardShell({ games: initialGames, intelMap = {}, boardUpdatedAt: initialUpdatedAt, topPicks = [] }: { games: Game[]; intelMap?: Record<string, any>; boardUpdatedAt?: string | null; topPicks?: any[] }) {
  const [games, setGames] = useState<Game[]>(initialGames);
  const [boardUpdatedAt, setBoardUpdatedAt] = useState(initialUpdatedAt ?? null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastPoll, setLastPoll] = useState<Date>(new Date());

  const [sport, setSport] = useState<SportFilter>("ALL");
  const [time, setTime] = useState<TimeFilter>("ALL");
  const [query, setQuery] = useState("");
  const [slip, setSlip] = useState<SlipLeg[]>([]);
  const [watchlist, setWatchlist] = useState<Set<string>>(new Set());
  const [selectedGame, setSelectedGame] = useState<Game | null>(null);
  const [watchlistOnly, setWatchlistOnly] = useState(false);
  const [signalFilter, setSignalFilter] = useState<"none" | "high" | "volatile" | "new">("none");
  const [movementMap, setMovementMap] = useState<Record<string, Record<string, "up" | "down">>>({});

  const prevGamesRef = useRef<Game[]>(initialGames);

  const liveCount = games.filter((g) => g.status === "live").length;

  const poll = useCallback(async (silent = true) => {
    if (!silent) setRefreshing(true);
    try {
      const res = await fetch("/api/board");
      if (!res.ok) return;
      const data = await res.json();
      if (data.games?.length) {
        const triggered = checkAlerts(data.games);
        triggered.forEach(fireNotification);

        const realMovement = computeMovementMap(prevGamesRef.current, data.games);
        prevGamesRef.current = data.games;
        setGames(data.games);
        setMovementMap(realMovement);
        setLastPoll(new Date());
        if (data.fetchedAt) setBoardUpdatedAt(data.fetchedAt);
      }
    } catch {
      // Silently fail — keep showing existing data
    } finally {
      if (!silent) setRefreshing(false);
    }
  }, []);

  // Adaptive polling: 30s when live games, 5 min otherwise
  useEffect(() => {
    const interval = liveCount > 0 ? 30_000 : 5 * 60_000;
    const timer = setInterval(() => poll(true), interval);
    return () => clearInterval(timer);
  }, [liveCount, poll]);

  const highImpactCount = useMemo(() => {
    return games.filter((g) => intelMap[g.id]?.has_high_severity ?? hasHighSeveritySignal(g.id, g.home_team, g.away_team)).length;
  }, [games, intelMap]);

  const signalGameCount = useMemo(() => {
    return games.filter((g) => (intelMap[g.id]?.signals_count ?? getSignalsForGame(g.id, g.home_team, g.away_team).length) > 0).length;
  }, [games, intelMap]);

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

      const intel = intelMap[g.id];
      const hasBackendIntel = !!intel;
      const signalsCount = intel?.signals_count ?? getSignalsForGame(g.id, g.home_team, g.away_team).length;
      const highSeverity = intel?.has_high_severity ?? hasHighSeveritySignal(g.id, g.home_team, g.away_team);
      const isVolatile = intel?.is_volatile ?? false;
      const hasNewSignal = intel?.has_new_signal ?? signalsCount > 0;

      let sigOk = true;
      if (signalFilter === "high") {
        sigOk = highSeverity;
      } else if (signalFilter === "volatile") {
        sigOk = hasBackendIntel ? isVolatile : (isVolatile || signalsCount > 0);
      } else if (signalFilter === "new") {
        sigOk = hasNewSignal;
      }

      return sportOk && timeOk && textOk && wlOk && sigOk;
    });
  }, [games, sport, time, query, watchlistOnly, watchlist, signalFilter, intelMap]);

  const liveGames = filtered.filter((g) => g.status === "live");
  const upcomingGames = filtered.filter((g) => g.status !== "live");

  const upcomingBySport = useMemo(() => {
    const sports = Array.from(new Set(upcomingGames.map((g) => g.sport_title)));
    if (sports.length <= 1) return null;
    const groups: Record<string, Game[]> = {};
    for (const g of upcomingGames) {
      if (!groups[g.sport_title]) groups[g.sport_title] = [];
      groups[g.sport_title].push(g);
    }
    return groups;
  }, [upcomingGames]);

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
  const boardUpdateLabel = boardUpdatedAt ? new Date(boardUpdatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;

  return (
    <div className="flex flex-1 overflow-hidden">
      <div className="flex flex-col flex-1 overflow-hidden bg-[#09090b]">
        <div className="shrink-0 border-b border-[#141417] bg-[#08080a] flex items-center gap-3 px-5 h-11">
          <div className="flex-1 max-w-[400px]">
            <div className="flex items-center gap-2 bg-[#0c0c0e] border border-[#141417] rounded-lg px-3 py-1.5">
              <Search className="h-3.5 w-3.5 text-[#3f3f46] shrink-0" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search teams, matchups, or markets..."
                className="bg-transparent outline-none text-[11px] text-white placeholder:text-[#3f3f46] w-full"
              />
            </div>
          </div>

          <div className="flex items-center gap-3 ml-auto">
            {signalGameCount > 0 && (
              <div className="flex items-center gap-1.5 text-[10px]">
                <Sparkles className="h-3 w-3 text-[#00ff7f]/50" />
                <span className="text-[#3f3f46]">{signalGameCount} signals</span>
              </div>
            )}
            <div className="flex items-center gap-1.5 text-[10px] text-[#3f3f46]">
              <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", liveCount > 0 ? "bg-[#00ff7f] animate-pulse" : "bg-[#27272a]")} />
              <span>
                {boardUpdateLabel ? `Updated ${boardUpdateLabel}` : `Polled ${lastPoll.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}
              </span>
            </div>
            <button
              onClick={() => poll(false)}
              disabled={refreshing}
              title="Refresh odds"
              className={cn("text-[#27272a] hover:text-[#52525b] transition-colors", refreshing && "animate-spin")}
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
            <NotificationBell games={games} />
          </div>
        </div>

        <div className="shrink-0 border-b border-[#141417] bg-[#08080a] px-5 py-1.5">
          <div className="flex items-center gap-1">
            {SPORTS.map((s) => {
              const info = SPORT_LABELS[s];
              const count = sportCounts[s];
              return (
                <button
                  key={s}
                  onClick={() => setSport(s)}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium transition-all",
                    sport === s
                      ? "bg-[#141417] text-white border border-[#1e1e24]"
                      : "text-[#52525b] hover:text-[#a1a1aa] hover:bg-white/[0.02] border border-transparent"
                  )}
                >
                  <span>{info.emoji}</span>
                  <span>{info.label}</span>
                  {count !== undefined && count > 0 && (
                    <span className={cn("text-[9px] font-mono ml-0.5", sport === s ? "text-[#00ff7f]" : "text-[#3f3f46]")}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="shrink-0 border-b border-[#141417] bg-[#0a0a0c] px-5 py-1.5 flex items-center gap-2">
          {(["ALL", "LIVE", "TODAY"] as TimeFilter[]).map((t) => (
            <button
              key={t}
              onClick={() => setTime(t)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold border transition-all",
                time === t
                  ? "bg-[#141417] text-white border-[#1e1e24]"
                  : "text-[#52525b] hover:text-[#a1a1aa] border-transparent hover:bg-white/[0.02]"
              )}
            >
              {t === "LIVE" && <span className={cn("h-1.5 w-1.5 rounded-full", liveCount > 0 ? "bg-[#ef4444] animate-pulse" : "bg-[#3f3f46]")} />}
              {t === "ALL" ? "All Games" : t === "LIVE" ? `Live (${liveCount})` : "Today"}
            </button>
          ))}

          <div className="h-4 w-px bg-[#1e1e24] mx-1" />

          <button
            onClick={() => setSignalFilter(signalFilter === "high" ? "none" : "high")}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium border transition-all",
              signalFilter === "high"
                ? "text-[#ef4444] bg-[#ef4444]/8 border-[#ef4444]/20"
                : "text-[#52525b] hover:text-[#a1a1aa] border-transparent hover:bg-white/[0.02]"
            )}
          >
            <AlertTriangle className="h-3 w-3" />
            High Impact
            {highImpactCount > 0 && (
              <span className={cn("text-[9px] font-mono", signalFilter === "high" ? "text-[#ef4444]" : "text-[#3f3f46]")}>
                {highImpactCount}
              </span>
            )}
          </button>

          <button
            onClick={() => setWatchlistOnly(!watchlistOnly)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium border transition-all",
              watchlistOnly
                ? "text-[#00ff7f] bg-[#00ff7f]/8 border-[#00ff7f]/20"
                : "text-[#52525b] hover:text-[#a1a1aa] border-transparent hover:bg-white/[0.02]"
            )}
          >
            <Star className={cn("h-3 w-3", watchlistOnly && "fill-current")} />
            Watchlist
            {watchlist.size > 0 && (
              <span className={cn("text-[9px] font-mono", watchlistOnly ? "text-[#00ff7f]" : "text-[#3f3f46]")}>
                {watchlist.size}
              </span>
            )}
          </button>
        </div>

        <TopAIPicks onAddLeg={toggleLeg} picks={topPicks} />

        <div
          className="shrink-0 px-5 py-1.5 grid items-center gap-2 border-b border-[#141417] bg-[#08080a]"
          style={{ gridTemplateColumns: "minmax(200px,1fr) repeat(3, 80px) 28px" }}
        >
          <span className="text-[9px] text-[#3f3f46] font-semibold uppercase tracking-widest">Matchup</span>
          <span className="text-[9px] text-[#3f3f46] font-semibold uppercase tracking-widest text-center">ML</span>
          <span className="text-[9px] text-[#3f3f46] font-semibold uppercase tracking-widest text-center">Spread</span>
          <span className="text-[9px] text-[#3f3f46] font-semibold uppercase tracking-widest text-center">Total</span>
          <span />
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-hide">
          {liveGames.length > 0 && (
            <>
              <div className="flex items-center gap-2 px-5 py-1.5 bg-[#ef4444]/[0.03] border-b border-[#ef4444]/10">
                <span className="h-1.5 w-1.5 rounded-full bg-[#ef4444] animate-pulse" />
                <span className="text-[9px] font-bold text-[#ef4444] uppercase tracking-widest">Live</span>
                <span className="text-[9px] text-[#ef4444]/40 font-mono">{liveGames.length}</span>
              </div>
              {liveGames.map((g) => (
                <GameRow key={g.id} game={g} boardIntel={intelMap[g.id]} onToggleLeg={toggleLeg} selectedIds={selectedIds} watchlisted={watchlist.has(g.id)} onToggleWatch={toggleWatch} onSelectGame={setSelectedGame} realMovement={movementMap[g.id]} />
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
              {upcomingBySport
                ? Object.entries(upcomingBySport).map(([sportTitle, sportGames]) => (
                    <div key={sportTitle}>
                      <div className="sticky top-0 z-10 flex items-center gap-2 px-5 py-1.5 border-b border-[#141417] bg-[#09090b]/95 backdrop-blur-sm">
                        <span className="text-[9px] font-bold text-[#3f3f46] uppercase tracking-widest">
                          {SPORT_LABELS[SPORTS.find((s) => s !== "ALL" && sportTitle.toUpperCase().includes(s)) ?? "ALL"]?.emoji}{" "}{sportTitle}
                        </span>
                        <span className="text-[9px] text-[#27272a] font-mono">{sportGames.length}</span>
                      </div>
                      {sportGames.map((g) => (
                        <GameRow key={g.id} game={g} boardIntel={intelMap[g.id]} onToggleLeg={toggleLeg} selectedIds={selectedIds} watchlisted={watchlist.has(g.id)} onToggleWatch={toggleWatch} onSelectGame={setSelectedGame} realMovement={movementMap[g.id]} />
                      ))}
                    </div>
                  ))
                : upcomingGames.map((g) => (
                    <GameRow key={g.id} game={g} boardIntel={intelMap[g.id]} onToggleLeg={toggleLeg} selectedIds={selectedIds} watchlisted={watchlist.has(g.id)} onToggleWatch={toggleWatch} onSelectGame={setSelectedGame} realMovement={movementMap[g.id]} />
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

      <div className={cn(
        "shrink-0 border-l border-[#141417] overflow-hidden transition-all duration-200",
        selectedGame ? "w-[480px] xl:w-[520px]" : "w-[280px] xl:w-[320px]"
      )}>
        {selectedGame ? (
          <GameDetailPanel
            game={selectedGame}
            onClose={() => setSelectedGame(null)}
            onToggleLeg={toggleLeg}
            selectedIds={selectedIds}
          />
        ) : (
          <BetSlip slip={slip} onRemove={removeLeg} onClear={() => setSlip([])} games={games} />
        )}
      </div>
    </div>
  );
}
