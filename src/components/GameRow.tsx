"use client";

import { useState } from "react";
import { Game } from "@/types/game";
import { cn, formatAmericanOdds, teamAbbr, timeUntilGame } from "@/lib/utils";
import { Star, Sparkles, TrendingUp, TrendingDown } from "lucide-react";
import { SlipLeg } from "@/components/dashboard/DashboardShell";
import { bookMeta, bookLogoUrl } from "@/lib/books";
import { getTopSignalForGame, hasHighSeveritySignal, getAIRecommendation } from "@/lib/signals";
import { impliedProbability, edgePct } from "@/lib/edge";
import { SignalChip, SignalSummaryLine } from "@/components/SignalBadge";
import { getTeamLogoUrl } from "@/lib/team-logos";
import { getTeamStyle } from "@/lib/team-style";
import { saveAlert } from "@/lib/alerts";

function TeamIcon({ team, sport }: { team: string; sport: string }) {
  const logoUrl = getTeamLogoUrl(team, sport);
  if (logoUrl) {
    return (
      <img
        src={logoUrl}
        alt={team}
        className="h-[18px] w-[18px] rounded object-contain shrink-0"
        loading="lazy"
        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
      />
    );
  }
  return (
    <div className="h-[18px] w-[18px] rounded bg-[#161a16] border border-[#1e2b1e] flex items-center justify-center text-[7px] font-bold text-[#6b7068] shrink-0">
      {teamAbbr(team)}
    </div>
  );
}

function bestH2H(game: Game, team: string) {
  const all = game.bookmakers.flatMap((b) =>
    (b.markets.h2h || []).filter((o) => o.name === team).map((o) => ({ price: o.price, book: b.sportsbook }))
  );
  if (!all.length) return null;
  return all.reduce((best, cur) => cur.price > best.price ? cur : best);
}

function bestSpread(game: Game, team: string) {
  const all = game.bookmakers.flatMap((b) =>
    (b.markets.spreads || []).filter((o) => o.name === team).map((o) => ({ ...o, book: b.sportsbook }))
  );
  if (!all.length) return null;
  return all.reduce((best, cur) => cur.price > best.price ? cur : best);
}

function bestTotal(game: Game, side: "Over" | "Under") {
  const all = game.bookmakers.flatMap((b) =>
    (b.markets.totals || []).filter((o) => o.name === side).map((o) => ({ ...o, book: b.sportsbook }))
  );
  if (!all.length) return null;
  return all.reduce((best, cur) => cur.price > best.price ? cur : best);
}

function buildLeg(id: string, game: Game, market: string, label: string, odds: number, book?: string): SlipLeg {
  return {
    id,
    gameId: game.id,
    matchup: `${game.away_team} @ ${game.home_team}`,
    market,
    label,
    odds,
    book: book ? bookMeta(book).short : undefined,
  };
}

function OddsCell({
  leg,
  selected,
  onToggle,
  point,
  pointLabel,
  bookKey,
  recommended,
  recommendationReason,
  recommendationConfidence,
  recEdge,
  isBest,
  alertMeta,
  movement,
  marketConfidence,
}: {
  leg: SlipLeg | null;
  selected: boolean;
  onToggle: (l: SlipLeg) => void;
  point?: number;
  pointLabel?: string;
  bookKey?: string;
  recommended?: boolean;
  recommendationReason?: string;
  recommendationConfidence?: number;
  recEdge?: number;
  isBest?: boolean;
  alertMeta?: {
    gameId: string;
    team: string;
    market: "ml" | "spread" | "total";
    side: "away" | "home" | "over" | "under";
  };
  movement?: "up" | "down" | null;
  marketConfidence?: {
    pct?: number;
    lean?: string | null;
    reason?: string;
    supporting_signals?: string[];
    status?: string;
  } | null;
}) {
  const [alertMenu, setAlertMenu] = useState(false);
  const [alertDone, setAlertDone] = useState(false);

  function handleContextMenu(e: React.MouseEvent) {
    if (!alertMeta || !leg) return;
    e.preventDefault();
    setAlertMenu((v) => !v);
  }

  function createAlert(condition: "drops_below" | "rises_above") {
    if (!alertMeta || !leg) return;
    saveAlert({
      id: `alert-${Date.now()}`,
      gameId: alertMeta.gameId,
      matchup: leg.matchup,
      team: alertMeta.team,
      market: alertMeta.market,
      side: alertMeta.side,
      condition,
      threshold: leg.odds,
      book: "any",
      status: "active",
      createdAt: new Date().toISOString(),
    });
    setAlertMenu(false);
    setAlertDone(true);
    setTimeout(() => setAlertDone(false), 1500);
  }

  if (!leg) {
    return (
      <div className="h-[40px] flex items-center justify-center rounded-md border border-transparent">
        <span className="text-[11px] text-[#2e332a]">—</span>
      </div>
    );
  }

  const bm = bookKey ? bookMeta(bookKey) : null;

  return (
    <div className="relative group/rec">
      <button
        onClick={() => onToggle(leg)}
        onContextMenu={alertMeta ? handleContextMenu : undefined}
        className={cn(
          "relative h-[40px] w-full rounded-md border flex flex-col items-center justify-center transition-all duration-100 select-none group/btn overflow-visible",
          selected
            ? "border-[#3ee68a]/35 bg-[#3ee68a]/10"
            : "border-[#22251f] bg-[#0d0e0c] hover:border-[#2e332a] hover:bg-[#161a16]",
          recommended && "border-[#3ee68a]/40 shadow-[0_0_0_1px_rgba(0,255,127,0.08),0_0_18px_rgba(0,255,127,0.08)]"
        )}
      >
        {recommended && <div className="absolute inset-y-0 left-0 w-[2px] bg-[#3ee68a] rounded-l-md" />}

        {(pointLabel !== undefined || point !== undefined) && (
          <span className="text-[9px] font-medium text-[#6b7068] leading-none mb-[2px]">
            {pointLabel ?? (point! > 0 ? `+${point}` : point)}
          </span>
        )}

        <span className={cn(
          "font-mono text-[12px] font-bold leading-none",
          selected || recommended ? "text-[#3ee68a]" : leg.odds > 0 ? "text-[#3ee68a]" : "text-[#d4d7d0]"
        )}>
          {formatAmericanOdds(leg.odds)}
        </span>

        {bookKey && (
          <div className="absolute bottom-[3px] right-[3px]">
            <img
              src={bookLogoUrl(bookKey)}
              alt={bm?.name ?? bookKey}
              className="h-[10px] w-[10px] rounded-sm opacity-45 group-hover/btn:opacity-80 transition-opacity"
            />
          </div>
        )}

        {alertDone && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#121412]/90 rounded-md z-10">
            <span className="text-[9px] font-bold text-[#3ee68a]">Alert ✓</span>
          </div>
        )}

        {movement && (
          <span className={cn(
            "absolute bottom-[3px] left-[3px] opacity-60",
            movement === "up" ? "text-[#3ee68a]" : "text-[#ef4444]"
          )}>
            {movement === "up" ? <TrendingUp className="h-2 w-2" /> : <TrendingDown className="h-2 w-2" />}
          </span>
        )}

        {recommended && (
          <span className="absolute -top-[7px] left-1/2 -translate-x-1/2 z-20 h-3.5 w-3.5 rounded-full bg-[#121412] border border-[#3ee68a]/30 flex items-center justify-center text-[#3ee68a]">
            <Sparkles className="h-2 w-2" />
          </span>
        )}
      </button>

      {alertMenu && alertMeta && leg && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setAlertMenu(false)} />
          <div className="absolute bottom-full left-0 mb-1 z-50 w-[168px] rounded-xl border border-[#2e332a] bg-[#121412] p-2.5 shadow-2xl">
            <p className="text-[8px] text-[#6b7068] uppercase tracking-wider mb-1">Set alert at</p>
            <p className="text-[11px] font-mono font-bold text-white mb-2">{leg.odds > 0 ? "+" : ""}{leg.odds}</p>
            <div className="flex flex-col gap-0.5">
              <button onClick={() => createAlert("drops_below")} className="flex items-center gap-1.5 px-2 py-1.5 rounded-md hover:bg-white/[0.04] text-[10px] text-[#d4d7d0] transition-colors text-left w-full">
                <TrendingDown className="h-3 w-3 text-[#ef4444] shrink-0" /> Drops below
              </button>
              <button onClick={() => createAlert("rises_above")} className="flex items-center gap-1.5 px-2 py-1.5 rounded-md hover:bg-white/[0.04] text-[10px] text-[#d4d7d0] transition-colors text-left w-full">
                <TrendingUp className="h-3 w-3 text-[#3ee68a] shrink-0" /> Rises above
              </button>
            </div>
          </div>
        </>
      )}

      {(marketConfidence || (recommended && recommendationReason)) && (
        <div className="pointer-events-none absolute left-1/2 bottom-[calc(100%+12px)] -translate-x-1/2 w-[210px] rounded-xl border border-[#2e332a] bg-[#161a16]/95 px-3 py-2.5 shadow-2xl opacity-0 group-hover/rec:opacity-100 transition-opacity z-30">
          {marketConfidence ? (
            <>
              <div className="flex items-center gap-1.5 mb-1.5">
                <Sparkles className="h-3 w-3 text-[#3ee68a] shrink-0" />
                <span className="text-[11px] font-bold text-white">{marketConfidence.pct ?? 0}% · {marketConfidence.lean || "No clear lean"}</span>
              </div>
              <p className="text-[10px] text-[#d4d7d0] leading-relaxed">{marketConfidence.reason || "No credible market-specific read yet."}</p>
              {marketConfidence.supporting_signals?.[0] && (
                <p className="mt-1.5 text-[10px] text-[#9ca39a] leading-relaxed">{marketConfidence.supporting_signals[0]}</p>
              )}
            </>
          ) : (
            <>
              <div className="flex items-center gap-1.5 mb-1.5">
                <Sparkles className="h-3 w-3 text-[#3ee68a] shrink-0" />
                <span className="text-[11px] font-bold text-white">{recommendationConfidence ?? 78}% Confidence</span>
              </div>
              <p className="text-[10px] text-[#d4d7d0] leading-relaxed">{recommendationReason}</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}


function ScoreTag({ team, score, leading }: { team: string; score: string | number; leading?: boolean }) {
  const style = getTeamStyle(team);
  const abbr = style?.abbr || teamAbbr(team);
  const color = style?.color || "#d4d7d0";
  return (
    <div className={cn(
      "h-[23px] flex items-center justify-center gap-1.5 rounded-sm px-1.5 transition-colors",
      leading ? "bg-white/[0.02]" : ""
    )}>
      <span className="text-[9px] font-bold tracking-wide uppercase" style={{ color, opacity: leading ? 1 : 0.82 }}>{abbr}</span>
      <span className={cn(
        "text-[14px] font-mono font-bold tabular-nums",
        leading ? "text-white" : "text-[#9ca39a]"
      )}>{score}</span>
    </div>
  );
}

function formatUpcomingStart(commenceTime: string) {
  const now = new Date();
  const game = new Date(commenceTime);
  const isToday = now.toDateString() === game.toDateString();
  const primary = game.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  if (isToday) {
    return {
      primary,
      secondary: `in ${timeUntilGame(commenceTime)}`,
    };
  }

  return {
    primary,
    secondary: game.toLocaleDateString("en-US", { weekday: "short" }),
  };
}

function formatLiveState(game: Game, scoreboard: any) {
  if (!scoreboard) return { label: null, meta: null };
  const state = scoreboard?.state;
  const detail = scoreboard?.status_detail;
  const status = scoreboard?.status;
  const clock = scoreboard?.clock;
  const period = scoreboard?.period;

  if (state === "post") {
    return { label: status === "Final" ? "Final" : (status || "Final"), meta: null };
  }

  if (detail && detail !== "0:00") {
    if (detail.toLowerCase().includes("final")) return { label: "Final", meta: null };
    return { label: "Live", meta: detail };
  }

  if (game.sport?.includes("baseball") && period) {
    const inning = `${period}${period === 1 ? "st" : period === 2 ? "nd" : period === 3 ? "rd" : "th"}`;
    return { label: "Live", meta: inning };
  }

  if (clock && clock !== "0.0" && period) {
    return { label: "Live", meta: `${clock} Q${period}` };
  }

  return { label: game.status === "live" ? "Live" : null, meta: null };
}

export default function GameRow({
  game,
  onToggleLeg,
  selectedIds,
  watchlisted,
  onToggleWatch,
  boardIntel,
  onSelectGame,
  realMovement,
}: {
  game: Game;
  onToggleLeg: (l: SlipLeg) => void;
  selectedIds: string[];
  watchlisted: boolean;
  onToggleWatch: (id: string) => void;
  boardIntel?: any;
  onSelectGame?: (g: Game) => void;
  realMovement?: Record<string, "up" | "down" | null>;
}) {
  const isLive = game.status === "live";
  const away = game.away_team;
  const home = game.home_team;

  const hasBackendIntel = !!boardIntel;
  const topSignal = boardIntel?.top_signal ?? getTopSignalForGame(game.id, home, away);
  const isHighSeverity = boardIntel?.has_high_severity ?? hasHighSeveritySignal(game.id, home, away);
  const aiRecommendation = boardIntel?.recommendation ?? getAIRecommendation(game.id, home, away);
  const marketMovement = boardIntel?.market_movement ?? {};
  const marketConfidence = boardIntel?.market_confidence ?? {};
  const scoreboard = boardIntel?.scoreboard || game.scoreboard;
  const awayScore = scoreboard?.away_score;
  const homeScore = scoreboard?.home_score;
  const awayRecord = scoreboard?.away_record;
  const homeRecord = scoreboard?.home_record;
  const liveState = formatLiveState(game, scoreboard);
  const showScores = scoreboard?.state && scoreboard.state !== "pre" && awayScore != null && homeScore != null;
  const awayLeading = scoreboard?.away_winner ?? (showScores && Number(awayScore) > Number(homeScore));
  const homeLeading = scoreboard?.home_winner ?? (showScores && Number(homeScore) > Number(awayScore));

  const startDisplay = formatUpcomingStart(game.commence_time);

  const awayML = bestH2H(game, away);
  const homeML = bestH2H(game, home);
  const awaySpread = bestSpread(game, away);
  const homeSpread = bestSpread(game, home);
  const over = bestTotal(game, "Over");
  const under = bestTotal(game, "Under");

  const awayMLLeg = awayML ? buildLeg(`${game.id}-ml-away`, game, "Moneyline", `${away} ML`, awayML.price, awayML.book) : null;
  const homeMLLeg = homeML ? buildLeg(`${game.id}-ml-home`, game, "Moneyline", `${home} ML`, homeML.price, homeML.book) : null;
  const awaySpLeg = awaySpread ? buildLeg(`${game.id}-sp-away`, game, "Spread", `${away} ${(awaySpread.point ?? 0) > 0 ? "+" : ""}${awaySpread.point}`, awaySpread.price, awaySpread.book) : null;
  const homeSpLeg = homeSpread ? buildLeg(`${game.id}-sp-home`, game, "Spread", `${home} ${(homeSpread.point ?? 0) > 0 ? "+" : ""}${homeSpread.point}`, homeSpread.price, homeSpread.book) : null;
  const overLeg = over ? buildLeg(`${game.id}-ov`, game, "Total", `O ${over.point}`, over.price, over.book) : null;
  const underLeg = under ? buildLeg(`${game.id}-un`, game, "Total", `U ${under.point}`, under.price, under.book) : null;

  // Edge for the AI-recommended market cell
  let recEdge: number | null = null;
  if (aiRecommendation) {
    const recOddsMap: Record<string, number | null> = {
      "ml-away": awayML?.price ?? null,
      "ml-home": homeML?.price ?? null,
      "sp-away": awaySpread?.price ?? null,
      "sp-home": homeSpread?.price ?? null,
      ov: over?.price ?? null,
      un: under?.price ?? null,
    };
    const recOdds = recOddsMap[aiRecommendation.market];
    if (recOdds !== null) recEdge = edgePct(aiRecommendation.confidence, recOdds);
  }

  return (
    <div className={cn(
      "relative group/row transition-colors border-b border-transparent",
      isLive ? "bg-[#ef4444]/[0.02] hover:bg-[#ef4444]/[0.04]" : "hover:bg-white/[0.02]"
    )}>
      {isLive && <div className="absolute left-0 top-0 bottom-0 w-[2px] bg-[#ef4444]" />}
      {!isLive && isHighSeverity && <div className="absolute left-0 top-0 bottom-0 w-[2px] bg-[#f59e0b]/50" />}

      <div
        className="grid items-center gap-2 px-5 py-3"
        style={{ gridTemplateColumns: "minmax(220px,1fr) repeat(3, 84px) 28px" }}
      >
        <button
          onClick={() => onSelectGame?.(game)}
          className="min-w-0 flex items-center gap-3 text-left cursor-pointer"
        >
          <div className="w-[56px] shrink-0 text-center">
            {isLive ? (
              <div className="flex min-w-[52px] flex-col items-start justify-center leading-none">
                <div className="inline-flex items-center gap-1.5">
                  <span className={cn("h-1.5 w-1.5 rounded-full", liveState.label === "Final" ? "bg-[#6b7068]" : "bg-[#ef4444] animate-pulse")} />
                  <span className={cn(
                    "text-[10px] font-bold uppercase tracking-[0.14em]",
                    liveState.label === "Final" ? "text-[#d4d7d0]" : "text-[#ef6666]"
                  )}>{liveState.label || "Live"}</span>
                </div>
                {liveState.meta && (
                  <span className={cn(
                    "mt-1 text-[9px] font-mono leading-none",
                    liveState.label === "Final" ? "text-[#9ca39a]" : "text-[#ef4444]/70"
                  )}>{liveState.meta}</span>
                )}
              </div>
            ) : (
              <div className="flex min-w-[52px] flex-col items-start justify-center leading-none">
                <span className="text-[11px] font-medium text-[#d7dbd4] tabular-nums">
                  {startDisplay.primary}
                </span>
                <span className="mt-1 text-[9px] text-[#6b7068] uppercase tracking-[0.08em]">
                  {startDisplay.secondary}
                </span>
              </div>
            )}
          </div>

          <div className="min-w-0 flex-1 grid grid-cols-[minmax(0,1fr)_74px] gap-4 items-center">
            <div className="min-w-0">
              <div className="flex items-center gap-2.5 mb-[3px] min-w-0">
                <TeamIcon team={away} sport={game.sport} />
                <span className="text-[12px] font-medium text-[#d4d7d0] truncate">{away}</span>
                {awayRecord && (
                  <span className="text-[10px] text-[#9ca39a]/60 font-mono tracking-tight shrink-0">{awayRecord}</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <TeamIcon team={home} sport={game.sport} />
                <span className="text-[12px] font-medium text-[#d4d7d0] truncate">{home}</span>
                {homeRecord && (
                  <span className="text-[10px] text-[#9ca39a]/60 font-mono tracking-tight shrink-0">{homeRecord}</span>
                )}
              </div>

              <div className="flex items-center gap-2 mt-1.5 pl-[26px] flex-wrap">
                <span className="text-[9px] text-[#6b7068] uppercase tracking-wider">{game.sport_title}</span>
                {topSignal && (
                  <>
                    <span className="text-[9px] text-[#2e332a]">·</span>
                    <SignalChip signal={topSignal} compact />
                  </>
                )}
              </div>

              {topSignal && (
                <div className="pl-[26px] mt-0.5 space-y-1">
                  <SignalSummaryLine signal={topSignal} />
                  {aiRecommendation?.reason && (
                    <p className="text-[10px] text-[#8b9388] line-clamp-1">{aiRecommendation.reason}</p>
                  )}
                </div>
              )}
            </div>

            <div className="h-full flex items-center justify-center">
              {showScores ? (
                <div className="w-[74px] min-w-[74px] overflow-visible flex flex-col items-center justify-center">
                  <ScoreTag team={away} score={awayScore} leading={awayLeading} />
                  <div className="h-px w-[52px] my-0.5 bg-white/[0.04]" />
                  <ScoreTag team={home} score={homeScore} leading={homeLeading} />
                </div>
              ) : (
                <div className="w-[74px] min-w-[74px]" />
              )}
            </div>
          </div>
        </button>

        <div className="flex flex-col gap-[4px]">
          <OddsCell leg={awayMLLeg} selected={awayMLLeg ? selectedIds.includes(awayMLLeg.id) : false} onToggle={onToggleLeg} bookKey={awayML?.book} recommended={aiRecommendation?.market === "ml-away"} recommendationReason={aiRecommendation?.reason} recommendationConfidence={aiRecommendation?.confidence} recEdge={aiRecommendation?.market === "ml-away" ? (recEdge ?? undefined) : undefined} movement={realMovement?.["ml-away"] ?? (hasBackendIntel ? marketMovement["ml-away"] : null)} marketConfidence={marketConfidence?.ml} isBest={!!awayML} alertMeta={awayML ? { gameId: game.id, team: away, market: "ml", side: "away" } : undefined} />
          <OddsCell leg={homeMLLeg} selected={homeMLLeg ? selectedIds.includes(homeMLLeg.id) : false} onToggle={onToggleLeg} bookKey={homeML?.book} recommended={aiRecommendation?.market === "ml-home"} recommendationReason={aiRecommendation?.reason} recommendationConfidence={aiRecommendation?.confidence} recEdge={aiRecommendation?.market === "ml-home" ? (recEdge ?? undefined) : undefined} movement={realMovement?.["ml-home"] ?? (hasBackendIntel ? marketMovement["ml-home"] : null)} marketConfidence={marketConfidence?.ml} isBest={!!homeML} alertMeta={homeML ? { gameId: game.id, team: home, market: "ml", side: "home" } : undefined} />
        </div>

        <div className="flex flex-col gap-[4px]">
          <OddsCell leg={awaySpLeg} selected={awaySpLeg ? selectedIds.includes(awaySpLeg.id) : false} onToggle={onToggleLeg} point={awaySpread?.point} bookKey={awaySpread?.book} recommended={aiRecommendation?.market === "sp-away"} recommendationReason={aiRecommendation?.reason} recommendationConfidence={aiRecommendation?.confidence} recEdge={aiRecommendation?.market === "sp-away" ? (recEdge ?? undefined) : undefined} movement={realMovement?.["sp-away"] ?? (hasBackendIntel ? marketMovement["sp-away"] : null)} isBest={!!awaySpread} alertMeta={awaySpread ? { gameId: game.id, team: away, market: "spread", side: "away" } : undefined} />
          <OddsCell leg={homeSpLeg} selected={homeSpLeg ? selectedIds.includes(homeSpLeg.id) : false} onToggle={onToggleLeg} point={homeSpread?.point} bookKey={homeSpread?.book} recommended={aiRecommendation?.market === "sp-home"} recommendationReason={aiRecommendation?.reason} recommendationConfidence={aiRecommendation?.confidence} recEdge={aiRecommendation?.market === "sp-home" ? (recEdge ?? undefined) : undefined} movement={realMovement?.["sp-home"] ?? (hasBackendIntel ? marketMovement["sp-home"] : null)} isBest={!!homeSpread} alertMeta={homeSpread ? { gameId: game.id, team: home, market: "spread", side: "home" } : undefined} />
        </div>

        <div className="flex flex-col gap-[4px]">
          <OddsCell leg={overLeg} selected={overLeg ? selectedIds.includes(overLeg.id) : false} onToggle={onToggleLeg} pointLabel={over ? `O ${over.point}` : undefined} bookKey={over?.book} recommended={aiRecommendation?.market === "ov"} recommendationReason={aiRecommendation?.reason} recommendationConfidence={aiRecommendation?.confidence} recEdge={aiRecommendation?.market === "ov" ? (recEdge ?? undefined) : undefined} movement={realMovement?.["ov"] ?? (hasBackendIntel ? marketMovement["ov"] : null)} isBest={!!over} alertMeta={over ? { gameId: game.id, team: "Over", market: "total", side: "over" } : undefined} />
          <OddsCell leg={underLeg} selected={underLeg ? selectedIds.includes(underLeg.id) : false} onToggle={onToggleLeg} pointLabel={under ? `U ${under.point}` : undefined} bookKey={under?.book} recommended={aiRecommendation?.market === "un"} recommendationReason={aiRecommendation?.reason} recommendationConfidence={aiRecommendation?.confidence} recEdge={aiRecommendation?.market === "un" ? (recEdge ?? undefined) : undefined} movement={realMovement?.["un"] ?? (hasBackendIntel ? marketMovement["un"] : null)} isBest={!!under} alertMeta={under ? { gameId: game.id, team: "Under", market: "total", side: "under" } : undefined} />
        </div>

        <button
          onClick={() => onToggleWatch(game.id)}
          className={cn(
            "flex items-center justify-center self-center p-1 rounded transition-all",
            watchlisted
              ? "text-[#3ee68a] drop-shadow-[0_0_3px_rgba(0,255,127,0.3)]"
              : "text-[#2e332a] group-hover/row:text-[#6b7068]"
          )}
        >
          <Star className={cn("h-3.5 w-3.5", watchlisted && "fill-current")} />
        </button>
      </div>

      <div className="mx-5 h-px bg-[#161a16]" />
    </div>
  );
}

