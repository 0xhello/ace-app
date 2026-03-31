"use client";

import { Game } from "@/types/game";
import { cn, formatAmericanOdds, teamAbbr, timeUntilGame } from "@/lib/utils";
import { Star, Minus } from "lucide-react";
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
  return {
    id,
    gameId: game.id,
    matchup: `${game.away_team} @ ${game.home_team}`,
    market,
    label,
    odds,
    book: book ? (bookMeta(book).short) : undefined,
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
        "w-[68px] h-[46px] rounded-md border flex flex-col items-center justify-center gap-[2px] transition-all duration-75 select-none group",
        selected
          ? "border-[#00ff7f]/40 bg-[#00ff7f]/10 shadow-[0_0_0_1px_rgba(0,255,127,0.1)]"
          : "border-[#1e1e24] bg-[#0f0f11] hover:border-[#2a2a35] hover:bg-[#161618]"
      )}
    >
      {point !== undefined && (
        <span className="text-[10px] font-semibold leading-none text-[#71717a]">
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
        <span className="text-[9px] leading-none text-[#3a3a3a] group-hover:text-[#52525b] transition-colors">
          {leg.book}
        </span>
      )}
    </button>
  );
}

function EmptyCell() {
  return (
    <div className="w-[68px] h-[46px] rounded-md border border-dashed border-[#1e1e24]/40 flex items-center justify-center">
      <span className="text-[12px] text-[#2a2a35]">—</span>
    </div>
  );
}

// Movement indicator — placeholder, will be dynamic in Phase 5
function MovementChip() {
  return (
    <div className="flex items-center justify-center w-4 h-4">
      <Minus className="h-2.5 w-2.5 text-[#2a2a35]" />
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
      "relative border-b border-[#1a1a1f] last:border-b-0 transition-colors",
      isLive ? "bg-[#ef4444]/[0.025] hover:bg-[#ef4444]/[0.04]" : "hover:bg-[#ffffff]/[0.012]"
    )}>
      {/* Live left accent */}
      {isLive && <div className="absolute left-0 top-2 bottom-2 w-[2px] bg-[#ef4444]/70 rounded-r" />}

      <div
        className="grid items-center gap-3 px-4 py-3.5 pl-5"
        style={{ gridTemplateColumns: "minmax(190px,1fr) 68px 68px 68px 28px" }}
      >
        {/* ── Game info ─────────────────────────── */}
        <div className="min-w-0">
          {/* Meta */}
          <div className="flex items-center gap-2 mb-2.5">
            <span className="text-[10px] font-semibold text-[#52525b] uppercase tracking-widest">
              {game.sport_title}
            </span>
            {isLive ? (
              <span className="inline-flex items-center gap-1 bg-[#ef4444]/15 border border-[#ef4444]/25 text-[#ef4444] text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full">
                <span className="h-1 w-1 rounded-full bg-[#ef4444] animate-pulse" />
                Live
              </span>
            ) : (
              <span className="text-[10px] text-[#52525b]">{timeUntilGame(game.commence_time)}</span>
            )}
            <span className="text-[10px] text-[#3a3a3a]">{game.num_books} books</span>
          </div>

          {/* Teams */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <div className="h-[22px] w-[22px] rounded-md bg-[#161618] border border-[#252528] flex items-center justify-center text-[8px] font-bold text-[#71717a] shrink-0 tracking-wider">
                {teamAbbr(away)}
              </div>
              <span className="text-[13px] font-medium text-white truncate">{away}</span>
            </div>

            {/* @ divider */}
            <div className="flex items-center gap-2 pl-[5px]">
              <div className="h-px w-[12px] bg-[#252528]" />
              <span className="text-[9px] text-[#3a3a3a] font-medium">@</span>
            </div>

            <div className="flex items-center gap-2">
              <div className="h-[22px] w-[22px] rounded-md bg-[#161618] border border-[#252528] flex items-center justify-center text-[8px] font-bold text-[#71717a] shrink-0 tracking-wider">
                {teamAbbr(home)}
              </div>
              <span className="text-[13px] font-medium text-white truncate">{home}</span>
            </div>
          </div>
        </div>

        {/* ── Moneyline ──────────────────────── */}
        <div className="flex flex-col gap-[5px] items-center">
          <div className="flex items-center gap-1">
            {awayMLLeg ? <OddsBtn leg={awayMLLeg} selected={selectedIds.includes(awayMLLeg.id)} onToggle={onToggleLeg} /> : <EmptyCell />}
            <MovementChip />
          </div>
          <div className="flex items-center gap-1">
            {homeMLLeg ? <OddsBtn leg={homeMLLeg} selected={selectedIds.includes(homeMLLeg.id)} onToggle={onToggleLeg} /> : <EmptyCell />}
            <MovementChip />
          </div>
        </div>

        {/* ── Spread ─────────────────────────── */}
        <div className="flex flex-col gap-[5px] items-center">
          <div className="flex items-center gap-1">
            {awaySpLeg ? <OddsBtn leg={awaySpLeg} selected={selectedIds.includes(awaySpLeg.id)} onToggle={onToggleLeg} point={awaySpread?.point} /> : <EmptyCell />}
            <MovementChip />
          </div>
          <div className="flex items-center gap-1">
            {homeSpLeg ? <OddsBtn leg={homeSpLeg} selected={selectedIds.includes(homeSpLeg.id)} onToggle={onToggleLeg} point={homeSpread?.point} /> : <EmptyCell />}
            <MovementChip />
          </div>
        </div>

        {/* ── Total ──────────────────────────── */}
        <div className="flex flex-col gap-[5px] items-center">
          <div className="flex items-center gap-1">
            {overLeg ? <OddsBtn leg={overLeg} selected={selectedIds.includes(overLeg.id)} onToggle={onToggleLeg} point={over?.point} /> : <EmptyCell />}
            <MovementChip />
          </div>
          <div className="flex items-center gap-1">
            {underLeg ? <OddsBtn leg={underLeg} selected={selectedIds.includes(underLeg.id)} onToggle={onToggleLeg} point={under?.point} /> : <EmptyCell />}
            <MovementChip />
          </div>
        </div>

        {/* ── Watch ──────────────────────────── */}
        <div className="flex items-center justify-center self-center">
          <button
            onClick={() => onToggleWatch(game.id)}
            className={cn(
              "p-1.5 rounded-md transition-all",
              watchlisted ? "text-[#00ff7f]" : "text-[#2a2a35] hover:text-[#52525b]"
            )}
          >
            <Star className={cn("h-3.5 w-3.5", watchlisted && "fill-current")} />
          </button>
        </div>
      </div>
    </div>
  );
}
