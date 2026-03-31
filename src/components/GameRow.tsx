"use client";

import { Game } from "@/types/game";
import { cn, formatAmericanOdds, teamAbbr, timeUntilGame } from "@/lib/utils";
import { Star, Zap } from "lucide-react";
import { SlipLeg } from "@/components/dashboard/DashboardShell";

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
  draftkingssbk: "DK",
  barstool: "BS",
  unibet_us: "UB",
  espnbet: "ESPN",
  hardrockbet: "HR",
};

function bestH2H(game: Game, team: string) {
  const all = game.bookmakers
    .flatMap((b) => (b.markets.h2h || []).filter((o) => o.name === team).map((o) => ({ price: o.price, book: b.sportsbook })));
  if (!all.length) return null;
  return all.reduce((best, cur) => cur.price > best.price ? cur : best);
}

function bestSpread(game: Game, team: string) {
  // Find best price (highest) for the team's spread
  const all = game.bookmakers
    .flatMap((b) => (b.markets.spreads || []).filter((o) => o.name === team).map((o) => ({ ...o, book: b.sportsbook })));
  if (!all.length) return null;
  return all.reduce((best, cur) => cur.price > best.price ? cur : best);
}

function bestTotal(game: Game, side: "Over" | "Under") {
  const all = game.bookmakers
    .flatMap((b) => (b.markets.totals || []).filter((o) => o.name === side).map((o) => ({ ...o, book: b.sportsbook })));
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
    book: book ? (BOOK_SHORT[book] || book.toUpperCase().slice(0, 4)) : undefined,
  };
}

function OddsBtn({
  leg,
  selected,
  onToggle,
  isBest,
  sublabel,
}: {
  leg: SlipLeg;
  selected: boolean;
  onToggle: (l: SlipLeg) => void;
  isBest?: boolean;
  sublabel?: string;
}) {
  return (
    <button
      onClick={() => onToggle(leg)}
      className={cn(
        "relative w-[62px] h-[44px] rounded-md border flex flex-col items-center justify-center transition-all duration-75 select-none group",
        selected
          ? "border-[#00ff7f]/40 bg-[#00ff7f]/10 shadow-[0_0_0_1px_rgba(0,255,127,0.15)]"
          : isBest
          ? "border-[#00ff7f]/20 bg-[#00ff7f]/5 hover:border-[#00ff7f]/35 hover:bg-[#00ff7f]/8"
          : "border-[#1e1e24] bg-[#111113] hover:border-[#2a2a35] hover:bg-[#161618]"
      )}
    >
      {isBest && !selected && (
        <span className="absolute -top-[7px] left-1/2 -translate-x-1/2 flex items-center gap-0.5 bg-[#00ff7f] text-black text-[8px] font-bold px-1.5 py-0.5 rounded-full leading-none tracking-wide">
          BEST
        </span>
      )}
      <span className={cn(
        "font-mono text-[13px] font-bold leading-none",
        selected ? "text-[#00ff7f]" : leg.odds > 0 ? "text-[#00ff7f]" : "text-white"
      )}>
        {formatAmericanOdds(leg.odds)}
      </span>
      {sublabel && (
        <span className="text-[9px] text-[#52525b] mt-[3px] leading-none">
          {sublabel}
        </span>
      )}
    </button>
  );
}

function EmptyCell() {
  return (
    <div className="w-[62px] h-[44px] rounded-md border border-dashed border-[#1e1e24]/60 flex items-center justify-center">
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

  // Find global best ML (highest price for the underdog, etc.)
  const awayMLIsBest = awayML && homeML && awayML.price > homeML.price;
  const homeMLIsBest = homeML && awayML && homeML.price > awayML.price;

  const awayMLLeg = awayML ? buildLeg(`${game.id}-ml-away`, game, "Moneyline", `${away} ML`, awayML.price, awayML.book) : null;
  const homeMLLeg = homeML ? buildLeg(`${game.id}-ml-home`, game, "Moneyline", `${home} ML`, homeML.price, homeML.book) : null;
  const awaySpLeg = awaySpread ? buildLeg(`${game.id}-sp-away`, game, "Spread", `${away} ${(awaySpread.point ?? 0) > 0 ? "+" : ""}${awaySpread.point}`, awaySpread.price, awaySpread.book) : null;
  const homeSpLeg = homeSpread ? buildLeg(`${game.id}-sp-home`, game, "Spread", `${home} ${(homeSpread.point ?? 0) > 0 ? "+" : ""}${homeSpread.point}`, homeSpread.price, homeSpread.book) : null;
  const overLeg = over ? buildLeg(`${game.id}-ov`, game, "Total", `O ${over.point}`, over.price, over.book) : null;
  const underLeg = under ? buildLeg(`${game.id}-un`, game, "Total", `U ${under.point}`, under.price, under.book) : null;

  return (
    <div className={cn(
      "relative border-b border-[#1e1e24] last:border-b-0 transition-colors",
      isLive
        ? "bg-[#ef4444]/[0.03] hover:bg-[#ef4444]/[0.05]"
        : "hover:bg-white/[0.015]"
    )}>
      {/* Live left border accent */}
      {isLive && (
        <div className="absolute left-0 top-0 bottom-0 w-[2px] bg-[#ef4444]/60" />
      )}

      <div
        className="grid items-center gap-4 px-4 py-3.5 pl-5"
        style={{ gridTemplateColumns: "minmax(180px,1fr) 62px 62px 62px 36px" }}
      >
        {/* ── Team / game info ─────────── */}
        <div className="min-w-0">
          {/* Meta row */}
          <div className="flex items-center gap-2 mb-3">
            <span className="text-[10px] font-semibold text-[#52525b] tracking-wider uppercase">
              {game.sport_title}
            </span>
            <span className="text-[#2a2a35]">·</span>
            {isLive ? (
              <span className="flex items-center gap-1.5 text-[10px] font-bold text-[#ef4444] uppercase tracking-wide">
                <span className="h-1.5 w-1.5 rounded-full bg-[#ef4444] animate-pulse" />
                Live
              </span>
            ) : (
              <span className="text-[10px] text-[#52525b]">
                {timeUntilGame(game.commence_time)}
              </span>
            )}
            <span className="text-[#2a2a35]">·</span>
            <span className="text-[10px] text-[#3f3f46]">{game.num_books} books</span>
          </div>

          {/* Teams */}
          <div className="space-y-2">
            {[away, home].map((team, idx) => (
              <div key={team} className="flex items-center gap-2.5">
                <div className="h-[22px] w-[22px] rounded-md bg-[#18181b] border border-[#27272a] flex items-center justify-center text-[8px] font-bold text-[#a1a1aa] shrink-0 tracking-wider">
                  {teamAbbr(team)}
                </div>
                <span className="text-[13px] font-medium text-white truncate leading-tight">
                  {team}
                </span>
                {idx === 0 && (
                  <span className="ml-auto text-[10px] text-[#3f3f46] shrink-0 pr-2">@</span>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* ── Moneyline ─────────────────── */}
        <div className="flex flex-col gap-[7px] items-center pt-5">
          {awayMLLeg
            ? <OddsBtn leg={awayMLLeg} selected={selectedIds.includes(awayMLLeg.id)} onToggle={onToggleLeg} isBest={!!awayMLIsBest} sublabel={awayMLLeg.book} />
            : <EmptyCell />}
          {homeMLLeg
            ? <OddsBtn leg={homeMLLeg} selected={selectedIds.includes(homeMLLeg.id)} onToggle={onToggleLeg} isBest={!!homeMLIsBest} sublabel={homeMLLeg.book} />
            : <EmptyCell />}
        </div>

        {/* ── Spread ───────────────────── */}
        <div className="flex flex-col gap-[7px] items-center pt-5">
          {awaySpLeg
            ? <OddsBtn leg={awaySpLeg} selected={selectedIds.includes(awaySpLeg.id)} onToggle={onToggleLeg} sublabel={awaySpLeg.book} />
            : <EmptyCell />}
          {homeSpLeg
            ? <OddsBtn leg={homeSpLeg} selected={selectedIds.includes(homeSpLeg.id)} onToggle={onToggleLeg} sublabel={homeSpLeg.book} />
            : <EmptyCell />}
        </div>

        {/* ── Total ────────────────────── */}
        <div className="flex flex-col gap-[7px] items-center pt-5">
          {overLeg
            ? <OddsBtn leg={overLeg} selected={selectedIds.includes(overLeg.id)} onToggle={onToggleLeg} sublabel={overLeg.book} />
            : <EmptyCell />}
          {underLeg
            ? <OddsBtn leg={underLeg} selected={selectedIds.includes(underLeg.id)} onToggle={onToggleLeg} sublabel={underLeg.book} />
            : <EmptyCell />}
        </div>

        {/* ── Watchlist ────────────────── */}
        <div className="flex items-center justify-center self-center">
          <button
            onClick={() => onToggleWatch(game.id)}
            className={cn(
              "p-1.5 rounded-md transition-all duration-100",
              watchlisted
                ? "text-[#00ff7f]"
                : "text-[#3f3f46] hover:text-[#71717a]"
            )}
          >
            <Star className={cn("h-3.5 w-3.5 transition-all", watchlisted && "fill-current")} />
          </button>
        </div>
      </div>
    </div>
  );
}
