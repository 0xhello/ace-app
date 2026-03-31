"use client";

import { Game, MarketOutcome } from "@/types/game";
import { cn, formatAmericanOdds, teamAbbr, timeUntilGame } from "@/lib/utils";
import { Star } from "lucide-react";
import { SlipLeg } from "@/components/dashboard/DashboardShell";
import { useState } from "react";

const BOOK_SHORT: Record<string, string> = {
  fanduel: "FD",
  draftkings: "DK",
  betmgm: "MGM",
  caesars: "CZR",
  pointsbet: "PB",
  bet365: "365",
  bovada: "BOV",
  mybookieag: "MB",
  williamhill_us: "WH",
  betonlineag: "BOL",
};

function bestH2H(game: Game, team: string) {
  return game.bookmakers
    .flatMap((b) => (b.markets.h2h || []).filter((o) => o.name === team).map((o) => ({ price: o.price, book: b.sportsbook })))
    .sort((a, b) => b.price - a.price)[0] ?? null;
}

function bestSpread(game: Game, team: string) {
  for (const b of game.bookmakers) {
    const hit = (b.markets.spreads || []).find((o) => o.name === team);
    if (hit) return { ...hit, book: b.sportsbook };
  }
  return null;
}

function bestTotal(game: Game, side: "Over" | "Under") {
  for (const b of game.bookmakers) {
    const hit = (b.markets.totals || []).find((o) => o.name === side);
    if (hit) return { ...hit, book: b.sportsbook };
  }
  return null;
}

function OddsBtn({ leg, selected, onToggle }: { leg: SlipLeg; selected: boolean; onToggle: (l: SlipLeg) => void }) {
  return (
    <button
      onClick={() => onToggle(leg)}
      className={cn(
        "flex flex-col items-center justify-center w-[58px] h-[42px] rounded-md border text-center transition-all duration-75 select-none",
        selected
          ? "border-[#00ff7f]/50 bg-[#00ff7f]/12 text-[#00ff7f]"
          : "border-[#1e1e24] bg-[#111113] text-white hover:border-[#2a2a35] hover:bg-[#18181b]"
      )}
    >
      <span className={cn("font-mono text-[12px] font-semibold leading-none", leg.odds > 0 ? "text-[#00ff7f]" : "text-white", selected && "text-[#00ff7f]")}>
        {formatAmericanOdds(leg.odds)}
      </span>
      {leg.book && (
        <span className="text-[9px] text-[#52525b] mt-0.5 leading-none">{leg.book}</span>
      )}
    </button>
  );
}

function EmptyOdds() {
  return <div className="w-[58px] h-[42px] rounded-md border border-dashed border-[#1e1e24] flex items-center justify-center"><span className="text-[10px] text-[#3f3f46]">—</span></div>;
}

export default function GameRow({ game, onToggleLeg, selectedIds, watchlisted, onToggleWatch }: {
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

  function leg(id: string, market: string, label: string, odds: number, book?: string): SlipLeg {
    return { id, gameId: game.id, matchup: `${away} @ ${home}`, market, label, odds, book: book ? BOOK_SHORT[book] || book : undefined };
  }

  const awayMLLeg = awayML ? leg(`${game.id}-ml-away`, "ML", `${away} ML`, awayML.price, awayML.book) : null;
  const homeMLLeg = homeML ? leg(`${game.id}-ml-home`, "ML", `${home} ML`, homeML.price, homeML.book) : null;
  const awaySpLeg = awaySpread ? leg(`${game.id}-sp-away`, "Spread", `${away} ${awaySpread.point! > 0 ? "+" : ""}${awaySpread.point}`, awaySpread.price, awaySpread.book) : null;
  const homeSpLeg = homeSpread ? leg(`${game.id}-sp-home`, "Spread", `${home} ${homeSpread.point! > 0 ? "+" : ""}${homeSpread.point}`, homeSpread.price, homeSpread.book) : null;
  const overLeg = over ? leg(`${game.id}-ov`, "Total", `O ${over.point}`, over.price, over.book) : null;
  const underLeg = under ? leg(`${game.id}-un`, "Total", `U ${under.point}`, under.price, under.book) : null;

  return (
    <div className={cn(
      "group border-b border-[#1e1e24] last:border-b-0 hover:bg-white/[0.02] transition-colors",
      isLive && "bg-[#ef4444]/[0.025]"
    )}>
      <div className="px-4 py-3 grid items-center gap-3" style={{ gridTemplateColumns: "1fr auto auto auto auto" }}>

        {/* Teams + Meta */}
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-2.5">
            <span className="text-[10px] font-semibold text-[#52525b] uppercase tracking-wider">{game.sport_title}</span>
            {isLive ? (
              <span className="flex items-center gap-1 text-[10px] font-semibold text-[#ef4444]">
                <span className="h-1.5 w-1.5 rounded-full bg-[#ef4444] animate-pulse" />LIVE
              </span>
            ) : (
              <span className="text-[10px] text-[#52525b]">{timeUntilGame(game.commence_time)}</span>
            )}
            <span className="text-[10px] text-[#3f3f46]">{game.num_books} books</span>
          </div>

          <div className="space-y-1.5">
            {[away, home].map((team, i) => (
              <div key={team} className="flex items-center gap-2">
                <div className="h-6 w-6 rounded-full bg-[#18181b] border border-[#27272a] flex items-center justify-center text-[9px] font-bold text-white shrink-0">
                  {teamAbbr(team)}
                </div>
                <span className="text-[13px] font-medium text-white truncate">{team}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Moneyline */}
        <div className="flex flex-col gap-1 items-center">
          <span className="text-[9px] uppercase tracking-wider text-[#52525b] font-semibold mb-0.5">ML</span>
          {awayMLLeg ? <OddsBtn leg={awayMLLeg} selected={selectedIds.includes(awayMLLeg.id)} onToggle={onToggleLeg} /> : <EmptyOdds />}
          {homeMLLeg ? <OddsBtn leg={homeMLLeg} selected={selectedIds.includes(homeMLLeg.id)} onToggle={onToggleLeg} /> : <EmptyOdds />}
        </div>

        {/* Spread */}
        <div className="flex flex-col gap-1 items-center">
          <span className="text-[9px] uppercase tracking-wider text-[#52525b] font-semibold mb-0.5">Spread</span>
          {awaySpLeg ? <OddsBtn leg={awaySpLeg} selected={selectedIds.includes(awaySpLeg.id)} onToggle={onToggleLeg} /> : <EmptyOdds />}
          {homeSpLeg ? <OddsBtn leg={homeSpLeg} selected={selectedIds.includes(homeSpLeg.id)} onToggle={onToggleLeg} /> : <EmptyOdds />}
        </div>

        {/* Total */}
        <div className="flex flex-col gap-1 items-center">
          <span className="text-[9px] uppercase tracking-wider text-[#52525b] font-semibold mb-0.5">Total</span>
          {overLeg ? <OddsBtn leg={overLeg} selected={selectedIds.includes(overLeg.id)} onToggle={onToggleLeg} /> : <EmptyOdds />}
          {underLeg ? <OddsBtn leg={underLeg} selected={selectedIds.includes(underLeg.id)} onToggle={onToggleLeg} /> : <EmptyOdds />}
        </div>

        {/* Watchlist */}
        <div className="flex flex-col items-center justify-center gap-1 self-center pl-2">
          <button
            onClick={() => onToggleWatch(game.id)}
            className={cn(
              "p-2 rounded-lg border transition-colors",
              watchlisted ? "border-[#00ff7f]/30 bg-[#00ff7f]/10 text-[#00ff7f]" : "border-transparent text-[#3f3f46] hover:text-white hover:border-[#27272a]"
            )}
          >
            <Star className={cn("h-3.5 w-3.5", watchlisted && "fill-current")} />
          </button>
        </div>
      </div>
    </div>
  );
}
