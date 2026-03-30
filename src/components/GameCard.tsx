"use client";

import { Game } from "@/types/game";
import { formatAmericanOdds, timeUntilGame, teamAbbr, cn } from "@/lib/utils";
import { Clock, TrendingUp } from "lucide-react";

const BOOK_LABELS: Record<string, string> = {
  fanduel: "FD",
  draftkings: "DK",
  betmgm: "MGM",
  caesars: "CZR",
  pointsbet: "PB",
  bet365: "365",
  bovada: "BOV",
};

export default function GameCard({ game }: { game: Game }) {
  const home = game.home_team;
  const away = game.away_team;
  const homeML = game.best_moneyline?.[home];
  const awayML = game.best_moneyline?.[away];
  const isLive = game.status === "live";

  // Best book per side
  const bestHomeBook = game.bookmakers
    .flatMap((b) =>
      (b.markets.h2h || [])
        .filter((o) => o.name === home)
        .map((o) => ({ book: b.sportsbook, price: o.price }))
    )
    .sort((a, b) => b.price - a.price)[0];

  const bestAwayBook = game.bookmakers
    .flatMap((b) =>
      (b.markets.h2h || [])
        .filter((o) => o.name === away)
        .map((o) => ({ book: b.sportsbook, price: o.price }))
    )
    .sort((a, b) => b.price - a.price)[0];

  return (
    <div className={cn(
      "bg-ace-card border rounded-xl p-4 hover:border-ace-border/80 transition-colors group cursor-pointer",
      isLive ? "border-ace-red/40" : "border-ace-border"
    )}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium text-ace-muted">{game.sport_title}</span>
        <div className="flex items-center gap-1.5 text-xs">
          {isLive ? (
            <span className="flex items-center gap-1 text-ace-red font-semibold">
              <span className="h-1.5 w-1.5 rounded-full bg-ace-red animate-pulse" />
              LIVE
            </span>
          ) : (
            <span className="flex items-center gap-1 text-ace-muted">
              <Clock className="h-3 w-3" />
              {timeUntilGame(game.commence_time)}
            </span>
          )}
          <span className="text-ace-border">·</span>
          <span className="text-ace-muted">{game.num_books} books</span>
        </div>
      </div>

      {/* Teams + Odds */}
      <div className="space-y-2">
        {[
          { team: away, ml: awayML, bestBook: bestAwayBook },
          { team: home, ml: homeML, bestBook: bestHomeBook },
        ].map(({ team, ml, bestBook }) => (
          <div key={team} className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="h-7 w-7 rounded-full bg-ace-border flex items-center justify-center text-[10px] font-bold text-white">
                {teamAbbr(team)}
              </div>
              <span className="text-sm font-medium text-white truncate max-w-[140px]">{team}</span>
            </div>
            <div className="flex items-center gap-2">
              {bestBook && (
                <span className="text-[10px] text-ace-muted bg-ace-border px-1.5 py-0.5 rounded">
                  {BOOK_LABELS[bestBook.book] || bestBook.book}
                </span>
              )}
              {ml !== undefined ? (
                <span className={cn(
                  "text-sm font-bold tabular-nums w-14 text-right",
                  ml > 0 ? "text-ace-green" : "text-white"
                )}>
                  {formatAmericanOdds(ml)}
                </span>
              ) : (
                <span className="text-sm text-ace-muted w-14 text-right">—</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="flex items-center gap-2 mt-3 pt-3 border-t border-ace-border">
        <TrendingUp className="h-3 w-3 text-ace-muted" />
        <span className="text-[11px] text-ace-muted">Moneyline · Spread · Total</span>
      </div>
    </div>
  );
}
