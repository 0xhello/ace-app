"use client";

import { Game } from "@/types/game";
import { cn, formatAmericanOdds, teamAbbr, timeUntilGame } from "@/lib/utils";
import { Star, TrendingUp, TrendingDown } from "lucide-react";
import { SlipLeg } from "@/components/dashboard/DashboardShell";
import { bookMeta } from "@/lib/books";

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
  const b = book ? bookMeta(book) : null;
  return {
    id,
    gameId: game.id,
    matchup: `${game.away_team} @ ${game.home_team}`,
    market,
    label,
    odds,
    book: b?.short,
  };
}

function OddsBtn({
  leg,
  selected,
  onToggle,
  point,
}: {
  leg: SlipLeg;
  selected: boolean;
  onToggle: (l: SlipLeg) => void;
  point?: number;
}) {
  return (
    <button
      onClick={() => onToggle(leg)}
      className={cn(
        "w-[70px] h-[46px] rounded-md border flex flex-col items-center justify-center transition-all duration-75 select-none",
        selected
          ? "border-[#00ff7f]/40 bg-[#00ff7f]/10 shadow-[0_0_0_1px_rgba(0,255,127,0.12)]"
          : "border-[#1e1e24] bg-[#111113] hover:border-[#2a2a35] hover:bg-[#161618]"
      )}
    >
      {point !== undefined && (
        <span className="text-[10px] text-[#71717a] leading-none mb-0.5 font-medium">
          {point > 0 ? `+${point}` : point}
        </span>
      )}
      <span className={cn(
        "font-mono text-[13px] font-bold leading-none",
        selected ? "text-[#00ff7f]" : leg.odds > 0 ? "text-[#00ff7f]" : "text-white"
      )}>
        {formatAmericanOdds(leg.odds)}
      </span>
      {leg.book && (
        <span className="text-[9px] text-[#3f3f46] mt-[2px] leading-none">{leg.book}</span>
      )}
    </button>
  );
}

function EmptyCell() {
  return (
    <div className="w-[70px] h-[46px] rounded-md border border-dashed border-[#1e1e24]/50 flex items-center justify-center">
      <span className="text-[11px] text-[#3f3f46]">—</span>
    </div>
  );
}

export default function GameRow({
  game,
  onToggleLeg,
  selectedIds,
  watchlisted,
  onToggleWatch,
}: {
  game: Game;
  onToggleLeg: (l: SlipLeg) => void;
  selectedIds: string[];
  watchlisted: boolean;
  onToggleWatch: (id: string) => void;
}) {
  const isLive = game.status === "live";
  const away = game.away_team;
  const home = game.home_team;

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
      "relative border-b border-[#1e1e24] last:border-b-0 transition-colors",
      isLive ? "bg-[#ef4444]/[0.025] hover:bg-[#ef4444]/[0.04]" : "hover:bg-white/[0.015]"
    )}>
      {isLive && <div className="absolute left-0 top-0 bottom-0 w-[2px] bg-[#ef4444]/70 rounded-r" />}

      <div
        className="grid items-center gap-3 px-4 py-3 pl-5"
        style={{ gridTemplateColumns: "minmax(200px,1fr) 70px 70px 70px 32px" }}
      >
        {/* Team info */}
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-2.5">
            <span className="text-[10px] font-semibold text-[#52525b] uppercase tracking-wider">{game.sport_title}</span>
            <span className="text-[#27272a]">·</span>
            {isLive ? (
              <span className="flex items-center gap-1 text-[10px] font-bold text-[#ef4444] uppercase">
                <span className="h-1.5 w-1.5 rounded-full bg-[#ef4444] animate-pulse" />Live
              </span>
            ) : (
              <span className="text-[10px] text-[#52525b]">{timeUntilGame(game.commence_time)}</span>
            )}
            <span className="text-[#27272a]">·</span>
            <span className="text-[10px] text-[#3f3f46]">{game.num_books} books</span>
          </div>

          <div className="space-y-2">
            {[away, home].map((team, idx) => (
              <div key={team} className="flex items-center gap-2">
                <div className="h-[24px] w-[24px] rounded-md bg-[#18181b] border border-[#27272a] flex items-center justify-center text-[8px] font-bold text-[#a1a1aa] shrink-0 tracking-wider">
                  {teamAbbr(team)}
                </div>
                <span className="text-[13px] font-medium text-white truncate">{team}</span>
                {idx === 0 && <span className="text-[10px] text-[#3f3f46] ml-auto shrink-0">@</span>}
              </div>
            ))}
          </div>

          {/* AI placeholder badge */}
          <div className="mt-2 flex items-center gap-2">
            <span className="text-[10px] text-[#00ff7f]/60 flex items-center gap-1">
              <TrendingUp className="h-2.5 w-2.5" /> AI signals in Phase 4
            </span>
          </div>
        </div>

        {/* Moneyline */}
        <div className="flex flex-col gap-[6px] items-center pt-[26px]">
          {awayMLLeg ? <OddsBtn leg={awayMLLeg} selected={selectedIds.includes(awayMLLeg.id)} onToggle={onToggleLeg} /> : <EmptyCell />}
          {homeMLLeg ? <OddsBtn leg={homeMLLeg} selected={selectedIds.includes(homeMLLeg.id)} onToggle={onToggleLeg} /> : <EmptyCell />}
        </div>

        {/* Spread */}
        <div className="flex flex-col gap-[6px] items-center pt-[26px]">
          {awaySpLeg ? <OddsBtn leg={awaySpLeg} selected={selectedIds.includes(awaySpLeg.id)} onToggle={onToggleLeg} point={awaySpread?.point} /> : <EmptyCell />}
          {homeSpLeg ? <OddsBtn leg={homeSpLeg} selected={selectedIds.includes(homeSpLeg.id)} onToggle={onToggleLeg} point={homeSpread?.point} /> : <EmptyCell />}
        </div>

        {/* Total */}
        <div className="flex flex-col gap-[6px] items-center pt-[26px]">
          {overLeg ? <OddsBtn leg={overLeg} selected={selectedIds.includes(overLeg.id)} onToggle={onToggleLeg} point={over?.point} /> : <EmptyCell />}
          {underLeg ? <OddsBtn leg={underLeg} selected={selectedIds.includes(underLeg.id)} onToggle={onToggleLeg} point={under?.point} /> : <EmptyCell />}
        </div>

        {/* Watch */}
        <div className="flex items-center justify-center self-center">
          <button
            onClick={() => onToggleWatch(game.id)}
            className={cn("p-1.5 rounded-md transition-all", watchlisted ? "text-[#00ff7f]" : "text-[#3f3f46] hover:text-[#71717a]")}
          >
            <Star className={cn("h-3.5 w-3.5", watchlisted && "fill-current")} />
          </button>
        </div>
      </div>
    </div>
  );
}
