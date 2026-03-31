"use client";

import { Game, MarketOutcome } from "@/types/game";
import { cn, formatAmericanOdds, teamAbbr, timeUntilGame } from "@/lib/utils";
import { Activity, Clock, Plus, Sparkles, TrendingUp } from "lucide-react";
import { SlipLeg } from "@/components/dashboard/DashboardShell";

const BOOK_LABELS: Record<string, string> = {
  fanduel: "FD",
  draftkings: "DK",
  betmgm: "MGM",
  caesars: "CZR",
  pointsbet: "PB",
  bet365: "365",
  bovada: "BOV",
  mybookieag: "MB",
};

function bestOutcome(game: Game, marketKey: "h2h" | "spreads" | "totals", outcomeName: string) {
  const candidates = game.bookmakers.flatMap((book) =>
    (book.markets[marketKey] || [])
      .filter((o) => o.name === outcomeName)
      .map((o) => ({ ...o, book: book.sportsbook }))
  );
  return candidates.sort((a, b) => b.price - a.price)[0];
}

function firstSpread(game: Game, team: string) {
  for (const book of game.bookmakers) {
    const hit = (book.markets.spreads || []).find((o) => o.name === team);
    if (hit) return { ...hit, book: book.sportsbook };
  }
  return null;
}

function firstTotal(game: Game, side: "Over" | "Under") {
  for (const book of game.bookmakers) {
    const hit = (book.markets.totals || []).find((o) => o.name === side);
    if (hit) return { ...hit, book: book.sportsbook };
  }
  return null;
}

function buildLeg(id: string, game: Game, market: string, label: string, odds: number, book?: string): SlipLeg {
  return {
    id,
    gameId: game.id,
    matchup: `${game.away_team} @ ${game.home_team}`,
    market,
    label,
    odds,
    book,
  };
}

function OddsPill({
  leg,
  selected,
  onToggle,
  accent,
  sublabel,
}: {
  leg: SlipLeg;
  selected: boolean;
  onToggle: (leg: SlipLeg) => void;
  accent?: boolean;
  sublabel?: string;
}) {
  return (
    <button
      onClick={() => onToggle(leg)}
      className={cn(
        "group flex items-center justify-between gap-2 rounded-lg border px-2.5 py-2 text-left transition-all",
        selected
          ? "border-ace-green/40 bg-ace-green/10 text-ace-green"
          : "border-ace-border bg-black/20 text-white hover:border-ace-border-active hover:bg-ace-surface",
        accent && !selected && "shadow-[inset_0_0_0_1px_rgba(0,255,127,0.08)]"
      )}
    >
      <div className="min-w-0">
        <div className="text-[11px] text-ace-secondary truncate">{leg.label}</div>
        {sublabel && <div className="text-[10px] text-ace-muted truncate">{sublabel}</div>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className={cn("font-mono text-sm font-semibold", leg.odds > 0 ? "text-ace-green" : "text-white")}>{formatAmericanOdds(leg.odds)}</span>
        <Plus className={cn("h-3.5 w-3.5 transition-opacity", selected ? "opacity-0" : "opacity-40 group-hover:opacity-100")} />
      </div>
    </button>
  );
}

export default function GameCard({
  game,
  onToggleLeg,
  selectedLegIds,
}: {
  game: Game;
  onToggleLeg: (leg: SlipLeg) => void;
  selectedLegIds: string[];
}) {
  const isLive = game.status === "live";
  const awayML = bestOutcome(game, "h2h", game.away_team);
  const homeML = bestOutcome(game, "h2h", game.home_team);
  const awaySpread = firstSpread(game, game.away_team);
  const homeSpread = firstSpread(game, game.home_team);
  const over = firstTotal(game, "Over");
  const under = firstTotal(game, "Under");

  const awayMlLeg = awayML ? buildLeg(`${game.id}-ml-away`, game, "Moneyline", `${game.away_team} ML`, awayML.price, BOOK_LABELS[awayML.book]) : null;
  const homeMlLeg = homeML ? buildLeg(`${game.id}-ml-home`, game, "Moneyline", `${game.home_team} ML`, homeML.price, BOOK_LABELS[homeML.book]) : null;
  const awaySpreadLeg = awaySpread ? buildLeg(`${game.id}-sp-away`, game, "Spread", `${game.away_team} ${awaySpread.point && awaySpread.point > 0 ? "+" : ""}${awaySpread.point}`, awaySpread.price, BOOK_LABELS[awaySpread.book]) : null;
  const homeSpreadLeg = homeSpread ? buildLeg(`${game.id}-sp-home`, game, "Spread", `${game.home_team} ${homeSpread.point && homeSpread.point > 0 ? "+" : ""}${homeSpread.point}`, homeSpread.price, BOOK_LABELS[homeSpread.book]) : null;
  const overLeg = over ? buildLeg(`${game.id}-tot-over`, game, "Total", `Over ${over.point}`, over.price, BOOK_LABELS[over.book]) : null;
  const underLeg = under ? buildLeg(`${game.id}-tot-under`, game, "Total", `Under ${under.point}`, under.price, BOOK_LABELS[under.book]) : null;

  return (
    <div className={cn(
      "rounded-2xl border bg-ace-card p-4 md:p-5 transition-colors hover:border-ace-border-active",
      isLive ? "border-ace-red/30" : "border-ace-border"
    )}>
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between mb-4">
        <div>
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-ace-muted mb-1">
            <span>{game.sport_title}</span>
            <span>•</span>
            {isLive ? (
              <span className="flex items-center gap-1 text-ace-red font-semibold"><span className="h-1.5 w-1.5 rounded-full bg-ace-red animate-pulse" />Live market</span>
            ) : (
              <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{timeUntilGame(game.commence_time)}</span>
            )}
            <span>•</span>
            <span>{game.num_books} books</span>
          </div>
          <h3 className="text-white font-medium text-base">{game.away_team} @ {game.home_team}</h3>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <div className="rounded-full border border-ace-green/20 bg-ace-green/10 px-2.5 py-1 text-ace-green flex items-center gap-1.5"><Sparkles className="h-3 w-3" /> AI lane next</div>
          <div className="rounded-full border border-ace-border px-2.5 py-1 text-ace-secondary flex items-center gap-1.5"><Activity className="h-3 w-3" /> Best book live</div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[minmax(220px,1fr)_repeat(3,minmax(150px,180px))] gap-3 items-start">
        <div className="space-y-3">
          {[game.away_team, game.home_team].map((team) => (
            <div key={team} className="flex items-center gap-3 rounded-xl bg-black/20 border border-ace-border px-3 py-3">
              <div className="h-9 w-9 rounded-full bg-ace-surface border border-ace-border flex items-center justify-center text-xs font-bold text-white">{teamAbbr(team)}</div>
              <div className="min-w-0">
                <div className="text-sm font-medium text-white truncate">{team}</div>
                <div className="text-[11px] text-ace-muted">Board-ready market view</div>
              </div>
            </div>
          ))}
        </div>

        <div className="space-y-2">
          <div className="text-[10px] uppercase tracking-wider text-ace-muted font-semibold">Moneyline</div>
          {awayMlLeg && <OddsPill leg={awayMlLeg} selected={selectedLegIds.includes(awayMlLeg.id)} onToggle={onToggleLeg} accent sublabel={awayMlLeg.book} />}
          {homeMlLeg && <OddsPill leg={homeMlLeg} selected={selectedLegIds.includes(homeMlLeg.id)} onToggle={onToggleLeg} accent sublabel={homeMlLeg.book} />}
        </div>

        <div className="space-y-2">
          <div className="text-[10px] uppercase tracking-wider text-ace-muted font-semibold">Spread</div>
          {awaySpreadLeg ? <OddsPill leg={awaySpreadLeg} selected={selectedLegIds.includes(awaySpreadLeg.id)} onToggle={onToggleLeg} sublabel={awaySpreadLeg.book} /> : <div className="rounded-lg border border-dashed border-ace-border px-3 py-3 text-xs text-ace-muted">No spread</div>}
          {homeSpreadLeg ? <OddsPill leg={homeSpreadLeg} selected={selectedLegIds.includes(homeSpreadLeg.id)} onToggle={onToggleLeg} sublabel={homeSpreadLeg.book} /> : <div className="rounded-lg border border-dashed border-ace-border px-3 py-3 text-xs text-ace-muted">No spread</div>}
        </div>

        <div className="space-y-2">
          <div className="text-[10px] uppercase tracking-wider text-ace-muted font-semibold">Total</div>
          {overLeg ? <OddsPill leg={overLeg} selected={selectedLegIds.includes(overLeg.id)} onToggle={onToggleLeg} sublabel={overLeg.book} /> : <div className="rounded-lg border border-dashed border-ace-border px-3 py-3 text-xs text-ace-muted">No total</div>}
          {underLeg ? <OddsPill leg={underLeg} selected={selectedLegIds.includes(underLeg.id)} onToggle={onToggleLeg} sublabel={underLeg.book} /> : <div className="rounded-lg border border-dashed border-ace-border px-3 py-3 text-xs text-ace-muted">No total</div>}
        </div>
      </div>

      <div className="mt-4 pt-4 border-t border-ace-border flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div className="text-xs text-ace-secondary flex items-center gap-2"><TrendingUp className="h-3.5 w-3.5 text-ace-green" /> Market intelligence layer coming here: playability, movement, disagreement, AI conviction.</div>
        <div className="text-[11px] text-ace-muted">Unified board · no noise · one-screen workflow</div>
      </div>
    </div>
  );
}
