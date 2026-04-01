"use client";

import { Game } from "@/types/game";
import { cn, formatAmericanOdds, teamAbbr, timeUntilGame } from "@/lib/utils";
import { Star, Sparkles, TrendingUp, TrendingDown } from "lucide-react";
import { SlipLeg } from "@/components/dashboard/DashboardShell";
import { bookMeta } from "@/lib/books";
import { getTopSignalForGame, getConfidenceForGame, hasHighSeveritySignal, getAIRecommendation, getMovementDirection, type MarketRec } from "@/lib/signals";
import { SignalChip, SignalSummaryLine } from "@/components/SignalBadge";
import { ConfidencePill } from "@/components/ConfidenceBadge";
import { getTeamLogoUrl } from "@/lib/team-logos";

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
    <div className="h-[18px] w-[18px] rounded bg-[#111113] border border-[#1a1a1f] flex items-center justify-center text-[7px] font-bold text-[#52525b] shrink-0">
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
  bookKey,
  recommended,
  recommendationReason,
  recommendationConfidence,
  movement,
}: {
  leg: SlipLeg | null;
  selected: boolean;
  onToggle: (l: SlipLeg) => void;
  point?: number;
  bookKey?: string;
  recommended?: boolean;
  recommendationReason?: string;
  recommendationConfidence?: number;
  movement?: "up" | "down" | null;
}) {
  if (!leg) {
    return (
      <div className="h-[40px] flex items-center justify-center rounded-md border border-transparent">
        <span className="text-[11px] text-[#1e1e24]">—</span>
      </div>
    );
  }

  const bm = bookKey ? bookMeta(bookKey) : null;

  return (
    <div className="relative group/rec">
      <button
        onClick={() => onToggle(leg)}
        className={cn(
          "relative h-[40px] w-full rounded-md border flex items-center justify-center gap-1.5 transition-all duration-100 select-none group/btn overflow-visible",
          selected
            ? "border-[#00ff7f]/35 bg-[#00ff7f]/10"
            : "border-[#141417] bg-[#0a0a0c] hover:border-[#1e1e24] hover:bg-[#0f0f11]",
          recommended && "border-[#00ff7f]/40 shadow-[0_0_0_1px_rgba(0,255,127,0.08),0_0_18px_rgba(0,255,127,0.08)]"
        )}
      >
        {recommended && <div className="absolute inset-y-0 left-0 w-[2px] bg-[#00ff7f] rounded-l-md" />}

        {point !== undefined && (
          <span className="text-[10px] font-medium text-[#52525b]">
            {point > 0 ? `+${point}` : point}
          </span>
        )}

        <span className={cn(
          "font-mono text-[12px] font-bold",
          selected || recommended ? "text-[#00ff7f]" : leg.odds > 0 ? "text-[#00ff7f]" : "text-[#e4e4e7]"
        )}>
          {formatAmericanOdds(leg.odds)}
        </span>

        {bm && (
          <span
            className="h-[5px] w-[5px] rounded-full shrink-0 opacity-40 group-hover/btn:opacity-70 transition-opacity"
            style={{ background: bm.color }}
          />
        )}

        {movement && (
          <span className={cn(
            "absolute bottom-1 right-1 opacity-70",
            movement === "up" ? "text-[#00ff7f]" : "text-[#ef4444]"
          )}>
            {movement === "up" ? <TrendingUp className="h-2.5 w-2.5" /> : <TrendingDown className="h-2.5 w-2.5" />}
          </span>
        )}

        {recommended && (
          <span className="absolute -top-[7px] left-1/2 -translate-x-1/2 z-20 h-3.5 w-3.5 rounded-full bg-[#0c0c0e] border border-[#00ff7f]/30 flex items-center justify-center text-[#00ff7f] shadow-[0_0_10px_rgba(0,255,127,0.12)]">
            <Sparkles className="h-2 w-2" />
          </span>
        )}
      </button>

      {recommended && recommendationReason && (
        <div className="pointer-events-none absolute left-1/2 bottom-[calc(100%+12px)] -translate-x-1/2 w-[210px] rounded-xl border border-[#2a2a35] bg-[#121216]/95 px-3 py-2.5 shadow-2xl opacity-0 group-hover/rec:opacity-100 transition-opacity z-30">
          <div className="flex items-center gap-1.5 mb-1.5">
            <Sparkles className="h-3 w-3 text-[#00ff7f] shrink-0" />
            <span className="text-[11px] font-bold text-white">{recommendationConfidence ?? 78}% Confidence</span>
          </div>
          <p className="text-[10px] text-[#a1a1aa] leading-relaxed">{recommendationReason}</p>
        </div>
      )}
    </div>
  );
}

function marketKeyFor(rec: MarketRec) {
  return rec;
}

export default function GameRow({
  game,
  onToggleLeg,
  selectedIds,
  watchlisted,
  onToggleWatch,
  boardIntel,
}: {
  game: Game;
  onToggleLeg: (l: SlipLeg) => void;
  selectedIds: string[];
  watchlisted: boolean;
  onToggleWatch: (id: string) => void;
  boardIntel?: any;
}) {
  const isLive = game.status === "live";
  const away = game.away_team;
  const home = game.home_team;

  const hasBackendIntel = !!boardIntel;
  const topSignal = boardIntel?.top_signal ?? getTopSignalForGame(game.id, home, away);
  const confidence = boardIntel?.confidence ?? getConfidenceForGame(game.id);
  const isHighSeverity = boardIntel?.has_high_severity ?? hasHighSeveritySignal(game.id, home, away);
  const aiRecommendation = boardIntel?.recommendation ?? getAIRecommendation(game.id);
  const marketMovement = boardIntel?.market_movement ?? {};
  const scoreboard = boardIntel?.scoreboard;
  const awayScore = scoreboard?.away_score;
  const homeScore = scoreboard?.home_score;
  const clock = scoreboard?.clock;
  const period = scoreboard?.period;

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

  return (
    <div className={cn(
      "relative group/row transition-colors",
      isHighSeverity && "bg-[#ef4444]/[0.015]",
      isLive ? "bg-[#ef4444]/[0.02] hover:bg-[#ef4444]/[0.04]" : "hover:bg-white/[0.015]"
    )}>
      {isLive && <div className="absolute left-0 top-0 bottom-0 w-[2px] bg-[#ef4444]" />}
      {!isLive && isHighSeverity && <div className="absolute left-0 top-0 bottom-0 w-[2px] bg-[#f59e0b]/50" />}

      <div
        className="grid items-center gap-2 px-5 py-2.5"
        style={{ gridTemplateColumns: "minmax(220px,1fr) repeat(3, 84px) 28px" }}
      >
        <div className="min-w-0 flex items-center gap-3">
          <div className="w-[48px] shrink-0 text-center">
            {isLive ? (
              <div className="flex flex-col items-center gap-0.5">
                <span className="h-1.5 w-1.5 rounded-full bg-[#ef4444] animate-pulse" />
                <span className="text-[9px] font-bold text-[#ef4444] uppercase tracking-widest">Live</span>
                {clock && clock !== "0.0" && (
                  <span className="text-[8px] text-[#ef4444]/60 font-mono">{clock}</span>
                )}
                {period != null && period > 0 && (
                  <span className="text-[7px] text-[#ef4444]/40 font-mono">
                    {game.sport?.includes("baseball") ? `${period}${period === 1 ? "st" : period === 2 ? "nd" : period === 3 ? "rd" : "th"}` : `Q${period}`}
                  </span>
                )}
              </div>
            ) : (
              <span className="text-[10px] text-[#52525b] font-medium leading-tight block">
                {timeUntilGame(game.commence_time)}
              </span>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-[3px]">
              <TeamIcon team={away} sport={game.sport} />
              <span className="text-[12px] font-medium text-[#e4e4e7] truncate flex-1">{away}</span>
              {awayScore != null && (
                <span className={cn(
                  "text-[14px] font-mono font-bold shrink-0 tabular-nums min-w-[24px] text-right",
                  isLive ? "text-white" : "text-[#52525b]"
                )}>{awayScore}</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <TeamIcon team={home} sport={game.sport} />
              <span className="text-[12px] font-medium text-[#e4e4e7] truncate flex-1">{home}</span>
              {homeScore != null && (
                <span className={cn(
                  "text-[14px] font-mono font-bold shrink-0 tabular-nums min-w-[24px] text-right",
                  isLive ? "text-white" : "text-[#52525b]"
                )}>{homeScore}</span>
              )}
            </div>

            <div className="flex items-center gap-2 mt-1.5 pl-[26px] flex-wrap">
              <span className="text-[9px] text-[#3f3f46] uppercase tracking-wider">{game.sport_title}</span>
              <span className="text-[9px] text-[#1e1e24]">·</span>
              <ConfidencePill confidence={confidence} compact />
              {topSignal && (
                <>
                  <span className="text-[9px] text-[#1e1e24]">·</span>
                  <SignalChip signal={topSignal} compact />
                </>
              )}
            </div>

            {topSignal && (
              <div className="pl-[26px] mt-0.5">
                <SignalSummaryLine signal={topSignal} />
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-[4px]">
          <OddsCell leg={awayMLLeg} selected={awayMLLeg ? selectedIds.includes(awayMLLeg.id) : false} onToggle={onToggleLeg} bookKey={awayML?.book} recommended={aiRecommendation?.market === "ml-away"} recommendationReason={aiRecommendation?.reason} recommendationConfidence={aiRecommendation?.confidence} movement={hasBackendIntel ? marketMovement["ml-away"] : getMovementDirection(game.id, marketKeyFor("ml-away"))} />
          <OddsCell leg={homeMLLeg} selected={homeMLLeg ? selectedIds.includes(homeMLLeg.id) : false} onToggle={onToggleLeg} bookKey={homeML?.book} recommended={aiRecommendation?.market === "ml-home"} recommendationReason={aiRecommendation?.reason} recommendationConfidence={aiRecommendation?.confidence} movement={hasBackendIntel ? marketMovement["ml-home"] : getMovementDirection(game.id, marketKeyFor("ml-home"))} />
        </div>

        <div className="flex flex-col gap-[4px]">
          <OddsCell leg={awaySpLeg} selected={awaySpLeg ? selectedIds.includes(awaySpLeg.id) : false} onToggle={onToggleLeg} point={awaySpread?.point} bookKey={awaySpread?.book} recommended={aiRecommendation?.market === "sp-away"} recommendationReason={aiRecommendation?.reason} recommendationConfidence={aiRecommendation?.confidence} movement={getMovementDirection(game.id, marketKeyFor("sp-away"))} />
          <OddsCell leg={homeSpLeg} selected={homeSpLeg ? selectedIds.includes(homeSpLeg.id) : false} onToggle={onToggleLeg} point={homeSpread?.point} bookKey={homeSpread?.book} recommended={aiRecommendation?.market === "sp-home"} recommendationReason={aiRecommendation?.reason} recommendationConfidence={aiRecommendation?.confidence} movement={getMovementDirection(game.id, marketKeyFor("sp-home"))} />
        </div>

        <div className="flex flex-col gap-[4px]">
          <OddsCell leg={overLeg} selected={overLeg ? selectedIds.includes(overLeg.id) : false} onToggle={onToggleLeg} point={over?.point} bookKey={over?.book} recommended={aiRecommendation?.market === "ov"} recommendationReason={aiRecommendation?.reason} recommendationConfidence={aiRecommendation?.confidence} movement={getMovementDirection(game.id, marketKeyFor("ov"))} />
          <OddsCell leg={underLeg} selected={underLeg ? selectedIds.includes(underLeg.id) : false} onToggle={onToggleLeg} point={under?.point} bookKey={under?.book} recommended={aiRecommendation?.market === "un"} recommendationReason={aiRecommendation?.reason} recommendationConfidence={aiRecommendation?.confidence} movement={getMovementDirection(game.id, marketKeyFor("un"))} />
        </div>

        <button
          onClick={() => onToggleWatch(game.id)}
          className={cn(
            "flex items-center justify-center self-center p-1 rounded transition-all",
            watchlisted
              ? "text-[#00ff7f] drop-shadow-[0_0_3px_rgba(0,255,127,0.3)]"
              : "text-[#1e1e24] group-hover/row:text-[#3f3f46]"
          )}
        >
          <Star className={cn("h-3.5 w-3.5", watchlisted && "fill-current")} />
        </button>
      </div>

      <div className="mx-5 h-px bg-[#111113]" />
    </div>
  );
}
