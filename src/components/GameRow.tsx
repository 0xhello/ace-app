"use client";

import { Game } from "@/types/game";
import { cn, formatAmericanOdds, teamAbbr, timeUntilGame } from "@/lib/utils";
import { Star } from "lucide-react";
import { SlipLeg } from "@/components/dashboard/DashboardShell";
import { bookMeta } from "@/lib/books";
import { getTopSignalForGame, getConfidenceForGame, hasHighSeveritySignal } from "@/lib/signals";
import { SignalChip, SignalSummaryLine } from "@/components/SignalBadge";
import { ConfidencePill } from "@/components/ConfidenceBadge";

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
}: {
  leg: SlipLeg | null;
  selected: boolean;
  onToggle: (l: SlipLeg) => void;
  point?: number;
  bookKey?: string;
}) {
  if (!leg) {
    return (
      <div className="h-[38px] flex items-center justify-center">
        <span className="text-[11px] text-[#1e1e24]">—</span>
      </div>
    );
  }

  const bm = bookKey ? bookMeta(bookKey) : null;

  return (
    <button
      onClick={() => onToggle(leg)}
      className={cn(
        "h-[38px] w-full rounded-md border flex items-center justify-center gap-1.5 transition-all duration-75 select-none group/btn",
        selected
          ? "border-[#00ff7f]/30 bg-[#00ff7f]/8"
          : "border-[#141417] bg-[#0a0a0c] hover:border-[#1e1e24] hover:bg-[#0f0f11]"
      )}
    >
      {point !== undefined && (
        <span className="text-[10px] font-medium text-[#52525b]">
          {point > 0 ? `+${point}` : point}
        </span>
      )}
      <span className={cn(
        "font-mono text-[12px] font-bold",
        selected ? "text-[#00ff7f]" : leg.odds > 0 ? "text-[#00ff7f]" : "text-[#e4e4e7]"
      )}>
        {formatAmericanOdds(leg.odds)}
      </span>
      {bm && (
        <span
          className="h-[5px] w-[5px] rounded-full shrink-0 opacity-40 group-hover/btn:opacity-70 transition-opacity"
          style={{ background: bm.color }}
        />
      )}
    </button>
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

  // Signal system
  const topSignal = getTopSignalForGame(game.id, home, away);
  const confidence = getConfidenceForGame(game.id);
  const isHighSeverity = hasHighSeveritySignal(game.id, home, away);

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
        style={{ gridTemplateColumns: "minmax(200px,1fr) repeat(3, 80px) 28px" }}
      >
        {/* ── Game info ──────────────── */}
        <div className="min-w-0 flex items-center gap-3">
          <div className="w-[48px] shrink-0 text-center">
            {isLive ? (
              <div className="flex flex-col items-center gap-0.5">
                <span className="h-1.5 w-1.5 rounded-full bg-[#ef4444] animate-pulse" />
                <span className="text-[9px] font-bold text-[#ef4444] uppercase tracking-widest">Live</span>
              </div>
            ) : (
              <span className="text-[10px] text-[#52525b] font-medium leading-tight block">
                {timeUntilGame(game.commence_time)}
              </span>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-[3px]">
              <div className="h-[18px] w-[18px] rounded bg-[#111113] border border-[#1a1a1f] flex items-center justify-center text-[7px] font-bold text-[#52525b] shrink-0">
                {teamAbbr(away)}
              </div>
              <span className="text-[12px] font-medium text-[#e4e4e7] truncate">{away}</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="h-[18px] w-[18px] rounded bg-[#111113] border border-[#1a1a1f] flex items-center justify-center text-[7px] font-bold text-[#52525b] shrink-0">
                {teamAbbr(home)}
              </div>
              <span className="text-[12px] font-medium text-[#e4e4e7] truncate">{home}</span>
            </div>

            {/* Signal + confidence row */}
            <div className="flex items-center gap-2 mt-1.5 pl-[26px]">
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

            {/* Signal summary line */}
            {topSignal && (
              <div className="pl-[26px] mt-0.5">
                <SignalSummaryLine signal={topSignal} />
              </div>
            )}
          </div>
        </div>

        {/* ── Moneyline ──────────── */}
        <div className="flex flex-col gap-[3px]">
          <OddsCell leg={awayMLLeg} selected={awayMLLeg ? selectedIds.includes(awayMLLeg.id) : false} onToggle={onToggleLeg} bookKey={awayML?.book} />
          <OddsCell leg={homeMLLeg} selected={homeMLLeg ? selectedIds.includes(homeMLLeg.id) : false} onToggle={onToggleLeg} bookKey={homeML?.book} />
        </div>

        {/* ── Spread ─────────── */}
        <div className="flex flex-col gap-[3px]">
          <OddsCell leg={awaySpLeg} selected={awaySpLeg ? selectedIds.includes(awaySpLeg.id) : false} onToggle={onToggleLeg} point={awaySpread?.point} bookKey={awaySpread?.book} />
          <OddsCell leg={homeSpLeg} selected={homeSpLeg ? selectedIds.includes(homeSpLeg.id) : false} onToggle={onToggleLeg} point={homeSpread?.point} bookKey={homeSpread?.book} />
        </div>

        {/* ── Total ──────────── */}
        <div className="flex flex-col gap-[3px]">
          <OddsCell leg={overLeg} selected={overLeg ? selectedIds.includes(overLeg.id) : false} onToggle={onToggleLeg} point={over?.point} bookKey={over?.book} />
          <OddsCell leg={underLeg} selected={underLeg ? selectedIds.includes(underLeg.id) : false} onToggle={onToggleLeg} point={under?.point} bookKey={under?.book} />
        </div>

        {/* ── Watch ──────────── */}
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
