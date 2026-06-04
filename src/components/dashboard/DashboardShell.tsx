"use client";

import { useMemo, useState, useEffect, useRef, useCallback } from "react";
import { Game } from "@/types/game";
import GameRow from "@/components/GameRow";
import TopAIPicks from "@/components/TopAIPicks";
import WCBanner from "@/components/dashboard/WCBanner";
import FeaturedPickCard from "@/components/dashboard/FeaturedPickCard";
import BetSlip from "@/components/BetSlip";
import NotificationBell from "@/components/NotificationBell";
import AskAce from "@/components/AskAce";
import { Search, Sparkles, AlertTriangle, RefreshCw, Star, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { checkAlertsAgainst, fireNotification, type PriceAlert } from "@/lib/alerts";
import { sportTab } from "@/lib/sport-tab";

type SportFilter = "ALL" | "SOCCER" | "NBA" | "NFL" | "MLB" | "NHL" | "NCAAB";
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
  ALL:    { emoji: "🏆", label: "All" },
  SOCCER: { emoji: "⚽", label: "Soccer" },
  NBA:    { emoji: "🏀", label: "NBA" },
  NFL:    { emoji: "🏈", label: "NFL" },
  MLB:    { emoji: "⚾", label: "MLB" },
  NHL:    { emoji: "🏒", label: "NHL" },
  NCAAB:  { emoji: "🎓", label: "NCAAB" },
};

const SPORTS: SportFilter[] = ["ALL", "SOCCER", "NBA", "NFL", "MLB", "NHL", "NCAAB"];

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
  const [serverAlerts, setServerAlerts] = useState<PriceAlert[]>([]);

  // Keep a ref in sync so poll() always sees the latest alerts without stale closure
  useEffect(() => { serverAlertsRef.current = serverAlerts; }, [serverAlerts]);
  const [watchlistOnly, setWatchlistOnly] = useState(false);
  const [signalFilter, setSignalFilter] = useState<"none" | "high" | "volatile" | "new">("none");
  const [movementMap, setMovementMap] = useState<Record<string, Record<string, "up" | "down">>>({});
  const [showAskAce, setShowAskAce] = useState(false);

  const prevGamesRef = useRef<Game[]>(initialGames);
  const serverAlertsRef = useRef<PriceAlert[]>([]);

  const liveCount = games.filter((g) => g.status === "live").length;

  const poll = useCallback(async (silent = true) => {
    if (!silent) setRefreshing(true);
    try {
      const res = await fetch("/api/board");
      if (!res.ok) return;
      const data = await res.json();
      if (data.games?.length) {
        const triggered = checkAlertsAgainst(data.games, serverAlertsRef.current);
        if (triggered.length) {
          setServerAlerts((prev) => prev.map((a) => triggered.find((t) => t.id === a.id) ?? a));
          triggered.forEach((alert) => {
            fireNotification(alert);
            fetch(`/api/alerts/${alert.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ status: "triggered", triggeredAt: alert.triggeredAt, triggeredOdds: alert.triggeredOdds }),
            }).catch(() => {});
          });
        }

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

  // Load watchlist and alerts from server on mount
  useEffect(() => {
    fetch("/api/watchlist").then((r) => r.json()).then((d) => {
      if (d.gameIds) setWatchlist(new Set(d.gameIds));
    }).catch(() => {});

    fetch("/api/alerts").then((r) => r.json()).then((d) => {
      if (d.alerts) setServerAlerts(d.alerts);
    }).catch(() => {});
  }, []);

  // Adaptive polling: 30s when live games, 5 min otherwise
  useEffect(() => {
    const interval = liveCount > 0 ? 30_000 : 5 * 60_000;
    const timer = setInterval(() => poll(true), interval);
    return () => clearInterval(timer);
  }, [liveCount, poll]);

  const highImpactCount = useMemo(() => {
    return games.filter((g) => intelMap[g.id]?.has_high_severity ?? false).length;
  }, [games, intelMap]);

  const signalGameCount = useMemo(() => {
    return games.filter((g) => (intelMap[g.id]?.signals_count ?? 0) > 0).length;
  }, [games, intelMap]);

  const sportCounts = useMemo(() => {
    const c: Record<string, number> = { ALL: games.length };
    for (const g of games) {
      // Route on the reliable sport_key (game.sport), not the display title.
      const tab = sportTab(g.sport, g.sport_title);
      if (tab) c[tab] = (c[tab] || 0) + 1;
    }
    return c;
  }, [games]);

  const filtered = useMemo(() => {
    return games.filter((g) => {
      const sportOk = sport === "ALL" || sportTab(g.sport, g.sport_title) === sport;
      const timeOk = time === "ALL"
        || (time === "LIVE" && g.status === "live")
        || (time === "TODAY" && new Date(g.commence_time).toDateString() === new Date().toDateString());
      const q = query.toLowerCase().trim();
      const textOk = !q || `${g.away_team} ${g.home_team} ${g.sport_title}`.toLowerCase().includes(q);
      const wlOk = !watchlistOnly || watchlist.has(g.id);

      const intel = intelMap[g.id];
      const hasBackendIntel = !!intel;
      const signalsCount = intel?.signals_count ?? 0;
      const highSeverity = intel?.has_high_severity ?? false;
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

  // Signal Feed picks, filtered to the active sport (P1.2). One feed that
  // respects the sport tab: Soccer tab → soccer signals, All → best across
  // everything. Each pick carries a gameId; we resolve its sport via the
  // games list. Under a specific sport filter we exclude picks whose sport
  // can't be resolved (don't show stray off-sport signals).
  const feedPicks = useMemo(() => {
    if (sport === "ALL") return topPicks;
    // Resolve each pick's sport via its game's reliable sport_key, so a soccer
    // pick (e.g. a "FIFA World Cup" game) routes to SOCCER and never leaks into
    // another sport's tab.
    const tabById = new Map(games.map((g) => [g.id, sportTab(g.sport, g.sport_title)]));
    return topPicks.filter((p) => tabById.get(p?.gameId) === sport);
  }, [topPicks, games, sport]);

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
    setWatchlist((prev) => {
      const n = new Set(prev);
      if (n.has(id)) {
        n.delete(id);
        fetch(`/api/watchlist/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
      } else {
        n.add(id);
        fetch("/api/watchlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ gameId: id }),
        }).catch(() => {});
      }
      return n;
    });
  }

  const selectedIds = slip.map((x) => x.id);
  const boardUpdateLabel = boardUpdatedAt ? new Date(boardUpdatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;
  const activeFilterCount = [sport !== "ALL", time !== "ALL", signalFilter !== "none", watchlistOnly, query.trim().length > 0].filter(Boolean).length;

  return (
    <div className="flex flex-1 overflow-hidden bg-[#090a09]">
      <div className="flex flex-col flex-1 overflow-hidden bg-transparent">
        <div className="shrink-0 border-b border-[#1b201a] bg-[linear-gradient(180deg,rgba(11,13,11,0.98),rgba(10,11,10,0.96))] px-5 py-2.5">
          <div className="flex items-center gap-3">
            <div className="flex-1 max-w-[460px]">
              <div className="flex items-center gap-2 rounded-xl border border-[#22271f] bg-[#121512]/95 px-3.5 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
                <Search className="h-3.5 w-3.5 text-[#6b7068] shrink-0" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search teams, markets, signals..."
                  className="bg-transparent outline-none text-[11px] text-white placeholder:text-[#5f665d] w-full"
                />
              </div>
            </div>

            <div className="hidden xl:flex items-center gap-3 text-[10px] text-[#7f867c] whitespace-nowrap">
              <span className="inline-flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-[#3ee68a]" />{games.length} games</span>
              <span className="inline-flex items-center gap-1.5 text-[#ef6666]"><span className="h-1.5 w-1.5 rounded-full bg-[#ef4444] animate-pulse" />{liveCount} live</span>
              <span className="inline-flex items-center gap-1.5 text-[#87d7aa]"><Sparkles className="h-3 w-3" />{signalGameCount} signals today</span>
              <span>{boardUpdateLabel ? `Updated ${boardUpdateLabel}` : `Polled ${lastPoll.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}</span>
              {activeFilterCount > 0 && <span>{activeFilterCount} filters</span>}
            </div>

            <div className="flex items-center gap-2 ml-auto">
              <button
                onClick={() => setShowAskAce(true)}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#3ee68a]/10 border border-[#3ee68a]/20 text-[10px] font-bold text-[#3ee68a] hover:bg-[#3ee68a]/16 transition-all shadow-[0_0_20px_rgba(62,230,138,0.05)]"
              >
                <Sparkles className="h-3 w-3" />
                Ask ACE
              </button>
              <button
                onClick={() => poll(false)}
                disabled={refreshing}
                title="Refresh odds"
                className={cn("flex h-8 w-8 items-center justify-center rounded-lg border border-[#22271f] bg-[#111310] text-[#5e645b] hover:text-[#9ca39a] hover:border-[#2b3128] transition-colors", refreshing && "animate-spin")}
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
              <div className="flex h-8 items-center rounded-lg border border-[#22271f] bg-[#111310] px-2">
                <NotificationBell games={games} serverAlerts={serverAlerts} intelMap={intelMap} />
              </div>
            </div>
          </div>
        </div>

        <div className="shrink-0 border-b border-[#1b201a] bg-[#0d0f0d] px-5 py-1.5">
          <div className="flex items-center gap-1.5 flex-wrap">
            {SPORTS.map((s) => {
              const info = SPORT_LABELS[s];
              const count = sportCounts[s];
              return (
                <button
                  key={s}
                  onClick={() => setSport(s)}
                  className={cn(
                    "flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-medium transition-all",
                    sport === s
                      ? "bg-[#22251f] text-white border border-[#2e332a]"
                      : "text-[#6b7068] hover:text-[#d4d7d0] hover:bg-white/[0.02] border border-transparent"
                  )}
                >
                  <span>{info.emoji}</span>
                  <span>{info.label}</span>
                  {count !== undefined && count > 0 && (
                    <span className={cn("text-[9px] font-mono ml-0.5", sport === s ? "text-[#3ee68a]" : "text-[#6b7068]")}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}

            <div className="h-3.5 w-px bg-[#2e332a] mx-0.5" />

            <button
              onClick={() => setSignalFilter(signalFilter === "high" ? "none" : "high")}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-medium border transition-all",
                signalFilter === "high"
                  ? "text-[#87d7aa] bg-[#3ee68a]/8 border-[#3ee68a]/20"
                  : "text-[#6b7068] hover:text-[#d4d7d0] border-transparent hover:bg-white/[0.02]"
              )}
            >
              <Sparkles className="h-3 w-3" />
              High impact only
              {highImpactCount > 0 && (
                <span className={cn("text-[9px] font-mono", signalFilter === "high" ? "text-[#87d7aa]" : "text-[#6b7068]")}>
                  {highImpactCount}
                </span>
              )}
            </button>

            <button
              onClick={() => setTime(time === "TODAY" ? "ALL" : "TODAY")}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-semibold border transition-all",
                time === "TODAY"
                  ? "bg-[#22251f] text-white border-[#2e332a]"
                  : "text-[#6b7068] hover:text-[#d4d7d0] border-transparent hover:bg-white/[0.02]"
              )}
            >
              Today
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-hide">
          <WCBanner />
          {/* M47 — the one proven pick (Over 2.5), surfaced prominently on the
              All + Soccer tabs. hideWhenEmpty: renders nothing until a real
              validated pick exists, so it never shows a "not betting" card as
              clutter pre-launch (the feed already covers the empty state). */}
          {(sport === "ALL" || sport === "SOCCER") && <FeaturedPickCard hideWhenEmpty />}
          {/* P1.2 — ONE Signal Feed that respects the sport filter. The old
              separate "Soccer Picks" section (SoccerPicksPanel) was removed
              here: it was redundant with the feed and confusing. Soccer
              signals now flow through the same Signal Feed as every other
              sport, filtered by the active tab. */}
          <TopAIPicks onAddLeg={toggleLeg} picks={feedPicks} />

          <div
            className="sticky top-0 z-20 px-5 py-2 grid items-center gap-2 border-b border-[#1b201a] bg-[#0a0b0a]/98 backdrop-blur-sm"
            style={{ gridTemplateColumns: "minmax(220px,1fr) repeat(3, 84px) 28px" }}
          >
            <span className="text-[9px] text-[#6b7068] font-semibold uppercase tracking-widest">Matchup</span>
            <span className="text-[9px] text-[#6b7068] font-semibold uppercase tracking-widest text-center">ML</span>
            <span className="text-[9px] text-[#6b7068] font-semibold uppercase tracking-widest text-center">Spread</span>
            <span className="text-[9px] text-[#6b7068] font-semibold uppercase tracking-widest text-center">Total</span>
            <span />
          </div>

          {/* ── Watching rail ─────────────────────────────────────────────── */}
          {watchlist.size > 0 && (() => {
            const watchedGames = Array.from(watchlist)
              .map(id => games.find(g => g.id === id))
              .filter(Boolean) as Game[];
            if (watchedGames.length === 0) return null;
            return (
              <div className="border-b border-[#22251f] bg-[#0b0d0b]">
                <div className="flex items-center gap-2 px-5 pt-3 pb-1.5">
                  <Star className="h-3 w-3 text-[#3ee68a] fill-current" />
                  <span className="text-[9px] font-bold text-[#3ee68a] uppercase tracking-widest">Watching</span>
                  <span className="text-[9px] text-[#2e3328] font-mono">{watchedGames.length}</span>
                </div>
                <div className="divide-y divide-[#161a16]">
                  {watchedGames.map(g => {
                    const isLive = g.status === "live";
                    const isFinal = g.status === "final";
                    const hs = g.scoreboard?.home_score != null ? Number(g.scoreboard.home_score) : null;
                    const as_ = g.scoreboard?.away_score != null ? Number(g.scoreboard.away_score) : null;
                    const clock = g.scoreboard?.clock;
                    const period = g.scoreboard?.period;
                    // Best spread line (home convention)
                    const allSpreads = g.bookmakers.flatMap(b => b.markets.spreads ?? []);
                    const homeSpread = allSpreads.find(s => s.name === g.home_team);
                    const homeLine = homeSpread?.point ?? null;
                    // Cover margin from home perspective
                    let coverMargin: number | null = null;
                    if (hs !== null && as_ !== null && homeLine !== null) {
                      coverMargin = (hs - as_) + homeLine;
                    }
                    const awayAbbr = g.away_team.split(" ").at(-1)!;
                    const homeAbbr = g.home_team.split(" ").at(-1)!;
                    return (
                      <div key={g.id} className="flex items-center gap-3 px-5 py-2.5">
                        {/* Matchup */}
                        <span className="text-[11px] font-medium text-white w-[130px] shrink-0 truncate">
                          {awayAbbr} <span className="text-[#3a4033]">@</span> {homeAbbr}
                        </span>
                        {/* Live/Final/Time */}
                        {isLive ? (
                          <span className="text-[9px] font-bold text-[#ef4444] shrink-0 flex items-center gap-1">
                            <span className="h-1.5 w-1.5 rounded-full bg-[#ef4444] animate-pulse inline-block" />
                            {period ? `Q${period}` : "LIVE"}{clock ? ` ${clock}` : ""}
                          </span>
                        ) : isFinal ? (
                          <span className="text-[9px] text-[#4a524a] shrink-0">FINAL</span>
                        ) : (
                          <span className="text-[9px] text-[#4a524a] shrink-0">
                            {new Date(g.commence_time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                          </span>
                        )}
                        {/* Score */}
                        {hs !== null && as_ !== null ? (
                          <span className="text-[13px] font-black font-mono tabular-nums text-white shrink-0">
                            {as_}–{hs}
                          </span>
                        ) : (
                          <span className="text-[9px] text-[#2e3328]">no score yet</span>
                        )}
                        {/* Spread */}
                        {homeLine !== null && (
                          <span className="text-[9px] font-mono text-[#4a524a] shrink-0">
                            {homeAbbr} {homeLine > 0 ? "+" : ""}{homeLine}
                          </span>
                        )}
                        {/* Cover status — show which team is currently covering */}
                        {coverMargin !== null && (
                          <span className="text-[10px] font-bold shrink-0" style={{ color: coverMargin !== 0 ? "#3ee68a" : "#6b7068" }}>
                            {coverMargin > 0 ? `${homeAbbr} covering ✓` : coverMargin < 0 ? `${awayAbbr} covering ✓` : "PUSH"}
                          </span>
                        )}
                        {/* Unstar */}
                        <button
                          onClick={() => toggleWatch(g.id)}
                          className="ml-auto text-[#3ee68a] hover:text-[#ef4444] transition-colors"
                          title="Remove from watching"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          {liveGames.length > 0 && (
            <>
              <div className="flex items-center gap-2 px-5 py-1.5 bg-[#ef4444]/[0.03] border-b border-[#ef4444]/10">
                <span className="h-1.5 w-1.5 rounded-full bg-[#ef4444] animate-pulse" />
                <span className="text-[9px] font-bold text-[#ef4444] uppercase tracking-widest">Live</span>
                <span className="text-[9px] text-[#ef4444]/40 font-mono">{liveGames.length}</span>
              </div>
              {liveGames.map((g) => (
                <GameRow key={g.id} game={g} boardIntel={intelMap[g.id]} onToggleLeg={toggleLeg} selectedIds={selectedIds} watchlisted={watchlist.has(g.id)} onToggleWatch={toggleWatch} realMovement={movementMap[g.id]} />
              ))}
            </>
          )}

          {upcomingGames.length > 0 && (
            <>
              {liveGames.length > 0 && (
                <div className="flex items-center gap-2 px-5 py-1.5 border-b border-[#22251f] bg-[#0a0b0a]">
                  <span className="text-[9px] font-bold text-[#6b7068] uppercase tracking-widest">Upcoming</span>
                  <span className="text-[9px] text-[#3a4033] font-mono">{upcomingGames.length}</span>
                </div>
              )}
              {upcomingBySport
                ? Object.entries(upcomingBySport).map(([sportTitle, sportGames]) => (
                    <div key={sportTitle}>
                      <div className="sticky top-0 z-10 flex items-center gap-2 px-5 py-1.5 border-b border-[#22251f] bg-[#0a0b0a]/95 backdrop-blur-sm">
                        <span className="text-[9px] font-bold text-[#6b7068] uppercase tracking-widest">
                          {SPORT_LABELS[SPORTS.find((s) => s !== "ALL" && sportTitle.toUpperCase().includes(s)) ?? "ALL"]?.emoji}{" "}{sportTitle}
                        </span>
                        <span className="text-[9px] text-[#3a4033] font-mono">{sportGames.length}</span>
                      </div>
                      {sportGames.map((g) => (
                        <GameRow key={g.id} game={g} boardIntel={intelMap[g.id]} onToggleLeg={toggleLeg} selectedIds={selectedIds} watchlisted={watchlist.has(g.id)} onToggleWatch={toggleWatch} realMovement={movementMap[g.id]} />
                      ))}
                    </div>
                  ))
                : upcomingGames.map((g) => (
                    <GameRow key={g.id} game={g} boardIntel={intelMap[g.id]} onToggleLeg={toggleLeg} selectedIds={selectedIds} watchlisted={watchlist.has(g.id)} onToggleWatch={toggleWatch} realMovement={movementMap[g.id]} />
                  ))}
            </>
          )}

          {filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 gap-2 text-center">
              <p className="text-[13px] text-[#6b7068] font-medium">No games match your filters</p>
              <p className="text-[11px] text-[#6b7068]">Try adjusting sport or time filters</p>
            </div>
          )}
        </div>
      </div>

      <div className={cn(
        "shrink-0 border-l border-[#1b201a] overflow-hidden transition-all duration-300 bg-[#090a09]",
        slip.length > 0 ? "w-[300px] xl:w-[340px]" : "w-11"
      )}>
        {slip.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 select-none">
            <div className="[writing-mode:vertical-rl] rotate-180 text-[9px] font-bold tracking-widest text-[#2e332a] uppercase">Betslip</div>
          </div>
        ) : (
          <BetSlip slip={slip} onRemove={removeLeg} onClear={() => setSlip([])} games={games} intelMap={intelMap} />
        )}
      </div>

      {showAskAce && <AskAce onClose={() => setShowAskAce(false)} />}
    </div>
  );
}
