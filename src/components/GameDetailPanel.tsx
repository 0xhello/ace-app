"use client";

import { useState } from "react";
import { X, Sparkles, TrendingUp, TrendingDown, AlertTriangle, Zap, CloudRain, BarChart2, ChevronRight, Check } from "lucide-react";
import { cn, formatAmericanOdds, timeUntilGame } from "@/lib/utils";
import { bookMeta, bookLogoUrl } from "@/lib/books";
import { getSignalsForGame, getConfidenceForGame, getAIRecommendation } from "@/lib/signals";
import { impliedProbability, edgePct, noVigProb } from "@/lib/edge";
import { bookDeepLink } from "@/lib/deeplinks";
import { saveAlert } from "@/lib/alerts";
import { Game } from "@/types/game";
import { SlipLeg } from "@/components/dashboard/DashboardShell";

// ── Signal display helpers ─────────────────────────────────────────────────

const SIGNAL_ICON: Record<string, any> = {
  injury: AlertTriangle,
  weather: CloudRain,
  market: BarChart2,
  news: Zap,
  confidence: Sparkles,
};

const SEVERITY_COLOR: Record<string, string> = {
  high: "#ef4444",
  medium: "#f59e0b",
  low: "#6b7068",
};

const TIER_COLOR: Record<string, string> = {
  high: "#3ee68a",
  medium: "#f59e0b",
  low: "#ef4444",
};

// ── Odds helpers ───────────────────────────────────────────────────────────

function getH2H(game: Game, team: string, book: string): number | null {
  const b = game.bookmakers.find((bk) => bk.sportsbook === book);
  return b?.markets.h2h?.find((o) => o.name === team)?.price ?? null;
}

function getSpread(game: Game, team: string, book: string): { price: number; point: number } | null {
  const b = game.bookmakers.find((bk) => bk.sportsbook === book);
  const o = b?.markets.spreads?.find((o) => o.name === team);
  return o ? { price: o.price, point: o.point ?? 0 } : null;
}

function getTotal(game: Game, side: "Over" | "Under", book: string): { price: number; point: number } | null {
  const b = game.bookmakers.find((bk) => bk.sportsbook === book);
  const o = b?.markets.totals?.find((o) => o.name === side);
  return o ? { price: o.price, point: o.point ?? 0 } : null;
}

function bestH2HAcrossBooks(game: Game, team: string): number | null {
  const all = game.bookmakers.flatMap((b) =>
    (b.markets.h2h || []).filter((o) => o.name === team).map((o) => o.price)
  );
  return all.length ? Math.max(...all) : null;
}

function buildLeg(id: string, game: Game, market: string, label: string, odds: number, book?: string): SlipLeg {
  return { id, gameId: game.id, matchup: `${game.away_team} @ ${game.home_team}`, market, label, odds, book };
}

// ── Stat box ───────────────────────────────────────────────────────────────

function StatBox({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="flex-1 rounded-lg bg-[#121412] border border-[#22251f] p-3 text-center">
      <p className="text-[9px] text-[#6b7068] uppercase tracking-wider mb-1">{label}</p>
      <p className="text-[18px] font-black font-mono leading-none" style={{ color: color ?? "#d4d7d0" }}>{value}</p>
      {sub && <p className="text-[9px] text-[#6b7068] mt-1">{sub}</p>}
    </div>
  );
}

// ── Odds cell in comparison table ──────────────────────────────────────────

function TableCell({
  price,
  point,
  isBest,
  onClick,
  isSelected,
}: {
  price: number | null;
  point?: number;
  isBest?: boolean;
  onClick?: () => void;
  isSelected?: boolean;
}) {
  if (price === null) {
    return <td className="px-2 py-2 text-center text-[10px] text-[#3a4033]">—</td>;
  }
  return (
    <td className="px-1 py-1.5 text-center">
      <button
        onClick={onClick}
        className={cn(
          "inline-flex flex-col items-center justify-center rounded-md px-2 py-1 min-w-[52px] border transition-all",
          isSelected
            ? "border-[#3ee68a]/40 bg-[#3ee68a]/10"
            : isBest
            ? "border-[#3ee68a]/20 bg-[#3ee68a]/[0.04] hover:bg-[#3ee68a]/[0.08]"
            : "border-transparent hover:border-[#2e332a] hover:bg-[#161a16]"
        )}
      >
        {point !== undefined && (
          <span className="text-[8px] text-[#6b7068] leading-none mb-[1px]">
            {point > 0 ? `+${point}` : point}
          </span>
        )}
        <span className={cn("text-[11px] font-bold font-mono leading-none", isBest ? "text-[#3ee68a]" : "text-[#d4d7d0]")}>
          {formatAmericanOdds(price)}
        </span>
      </button>
    </td>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export default function GameDetailPanel({
  game,
  onClose,
  onToggleLeg,
  selectedIds,
}: {
  game: Game;
  onClose: () => void;
  onToggleLeg: (leg: SlipLeg) => void;
  selectedIds: string[];
}) {
  const [activeTab, setActiveTab] = useState<"overview" | "books" | "signals" | "alert">("overview");

  const away = game.away_team;
  const home = game.home_team;

  const conf = getConfidenceForGame(game.id, home, away);
  const aiRec = getAIRecommendation(game.id, home, away);
  const signals = getSignalsForGame(game.id, home, away);

  // Alert form state
  const [alertForm, setAlertForm] = useState({
    market: "ml" as "ml" | "spread" | "total",
    side: "away" as "away" | "home" | "over" | "under",
    condition: "drops_below" as "drops_below" | "rises_above",
    threshold: -110,
  });
  const [alertSaved, setAlertSaved] = useState(false);

  // Best odds across all books for edge calculation
  const bestAwayML = bestH2HAcrossBooks(game, away);
  const bestHomeML = bestH2HAcrossBooks(game, home);

  // Edge analysis
  const recOdds = (() => {
    if (!aiRec) return null;
    if (aiRec.market === "ml-away") return bestAwayML;
    if (aiRec.market === "ml-home") return bestHomeML;
    return null;
  })();

  const edge = recOdds !== null ? edgePct(aiRec!.confidence, recOdds) : null;
  const implied = recOdds !== null ? impliedProbability(recOdds) : null;

  // No-vig true probabilities
  const [trueAway, trueHome] = bestAwayML && bestHomeML ? noVigProb(bestAwayML, bestHomeML) : [null, null];

  // All books present
  const books = game.bookmakers.map((b) => b.sportsbook);

  // Best prices per column (for highlighting)
  const colBest = {
    awayML: bestAwayML,
    homeML: bestHomeML,
    awaySpread: Math.max(...game.bookmakers.flatMap((b) => (b.markets.spreads || []).filter((o) => o.name === away).map((o) => o.price)).filter(Boolean)),
    homeSpread: Math.max(...game.bookmakers.flatMap((b) => (b.markets.spreads || []).filter((o) => o.name === home).map((o) => o.price)).filter(Boolean)),
    over: Math.max(...game.bookmakers.flatMap((b) => (b.markets.totals || []).filter((o) => o.name === "Over").map((o) => o.price)).filter(Boolean)),
    under: Math.max(...game.bookmakers.flatMap((b) => (b.markets.totals || []).filter((o) => o.name === "Under").map((o) => o.price)).filter(Boolean)),
  };

  function getDefaultThreshold(market: "ml" | "spread" | "total", side: "away" | "home" | "over" | "under"): number {
    if (market === "ml") return (side === "away" ? bestAwayML : bestHomeML) ?? -110;
    const bks = game.bookmakers;
    if (market === "spread") {
      const team = side === "away" ? away : home;
      const prices = bks.flatMap((b) => (b.markets.spreads || []).filter((o) => o.name === team).map((o) => o.price));
      return prices.length ? Math.max(...prices) : -110;
    }
    const totalSide = side === "over" ? "Over" : "Under";
    const prices = bks.flatMap((b) => (b.markets.totals || []).filter((o) => o.name === totalSide).map((o) => o.price));
    return prices.length ? Math.max(...prices) : -110;
  }

  function updateAlertMarket(market: "ml" | "spread" | "total") {
    const side: "away" | "home" | "over" | "under" =
      market === "total"
        ? alertForm.side === "over" || alertForm.side === "under" ? alertForm.side : "over"
        : alertForm.side === "over" || alertForm.side === "under" ? "away" : alertForm.side;
    setAlertForm((f) => ({ ...f, market, side, threshold: getDefaultThreshold(market, side) }));
  }

  function updateAlertSide(side: "away" | "home" | "over" | "under") {
    setAlertForm((f) => ({ ...f, side, threshold: getDefaultThreshold(f.market, side) }));
  }

  function handleCreateAlert() {
    const team = alertForm.side === "away" ? away
               : alertForm.side === "home" ? home
               : alertForm.side === "over" ? "Over" : "Under";
    saveAlert({
      id: `alert-${Date.now()}`,
      gameId: game.id,
      matchup: `${away} @ ${home}`,
      team,
      market: alertForm.market,
      side: alertForm.side,
      condition: alertForm.condition,
      threshold: alertForm.threshold,
      book: "any",
      status: "active",
      createdAt: new Date().toISOString(),
    });
    setAlertSaved(true);
    setTimeout(() => setAlertSaved(false), 2500);
  }

  const recMarketLabel: Record<string, string> = {
    "ml-away": `${away} ML`,
    "ml-home": `${home} ML`,
    "sp-away": `${away} Spread`,
    "sp-home": `${home} Spread`,
    ov: "Over",
    un: "Under",
  };

  const TABS = [
    { key: "overview", label: "Overview" },
    { key: "books", label: `Books (${books.length})` },
    { key: "signals", label: `Signals (${signals.length})` },
    { key: "alert", label: "+ Alert" },
  ] as const;

  return (
    <div className="flex flex-col h-full overflow-hidden bg-[#0a0b0a]">
      {/* Header */}
      <div className="shrink-0 border-b border-[#22251f] px-4 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[13px] font-bold text-white leading-snug truncate">{away} <span className="text-[#6b7068]">@</span> {home}</p>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[9px] text-[#6b7068] uppercase tracking-wider">{game.sport_title}</span>
              <span className="text-[9px] text-[#3a4033]">·</span>
              <span className="text-[9px] text-[#6b7068]">{timeUntilGame(game.commence_time)}</span>
              {game.status === "live" && (
                <span className="flex items-center gap-1 text-[9px] text-[#ef4444] font-bold uppercase">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#ef4444] animate-pulse" /> Live
                </span>
              )}
            </div>
          </div>
          <button onClick={onClose} className="text-[#6b7068] hover:text-[#9ca39a] transition-colors shrink-0 mt-0.5">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mt-3">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                "px-3 py-1 rounded-md text-[10px] font-semibold transition-all border",
                activeTab === tab.key
                  ? "bg-[#22251f] text-white border-[#2e332a]"
                  : "text-[#6b7068] border-transparent hover:text-[#d4d7d0]"
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto min-h-0">

        {/* ── Overview tab ──────────────────────────────────────────────── */}
        {activeTab === "overview" && (
          <div className="p-4 space-y-4">

            {/* Edge analysis */}
            {aiRec && edge !== null && implied !== null ? (
              <div className={cn(
                "rounded-xl border p-4",
                edge > 5 ? "border-[#3ee68a]/20 bg-[#3ee68a]/[0.04]" : "border-[#22251f] bg-[#121412]"
              )}>
                <div className="flex items-center gap-2 mb-3">
                  <Sparkles className="h-3.5 w-3.5 text-[#3ee68a]" />
                  <span className="text-[11px] font-bold text-white">ACE Edge</span>
                  <span className="ml-auto text-[9px] text-[#6b7068] uppercase tracking-wider">{recMarketLabel[aiRec.market]}</span>
                </div>

                <div className="flex items-end gap-3 mb-3">
                  <div>
                    <p className="text-[9px] text-[#6b7068] uppercase tracking-wider mb-0.5">Our model</p>
                    <p className="text-[22px] font-black font-mono text-white leading-none">{aiRec.confidence.toFixed(0)}%</p>
                  </div>
                  <div className="pb-0.5 text-[#6b7068]">
                    <ChevronRight className="h-4 w-4" />
                  </div>
                  <div>
                    <p className="text-[9px] text-[#6b7068] uppercase tracking-wider mb-0.5">Market implied</p>
                    <p className="text-[22px] font-black font-mono text-[#9ca39a] leading-none">{implied.toFixed(1)}%</p>
                  </div>
                  <div className="ml-auto text-right">
                    <p className="text-[9px] text-[#6b7068] uppercase tracking-wider mb-0.5">Edge</p>
                    <p className={cn(
                      "text-[28px] font-black font-mono leading-none",
                      edge > 8 ? "text-[#3ee68a]" : edge > 3 ? "text-[#7af0aa]" : edge > 0 ? "text-[#d4d7d0]" : "text-[#ef4444]"
                    )}>
                      {edge > 0 ? "+" : ""}{edge.toFixed(1)}%
                    </p>
                  </div>
                </div>

                <p className="text-[10px] text-[#9ca39a] leading-relaxed">{aiRec.reason}</p>
              </div>
            ) : (
              <div className="rounded-xl border border-[#22251f] bg-[#121412] p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Sparkles className="h-3.5 w-3.5 text-[#6b7068]" />
                  <span className="text-[11px] font-bold text-[#6b7068]">ACE Edge</span>
                </div>
                <p className="text-[10px] text-[#6b7068] leading-relaxed">
                  Signal stack not strong enough to identify a clear edge on this game yet.
                </p>
              </div>
            )}

            {/* True probability (no-vig) */}
            {trueAway !== null && trueHome !== null && (
              <div className="rounded-xl border border-[#22251f] bg-[#121412] p-4">
                <p className="text-[9px] text-[#6b7068] uppercase tracking-wider mb-3">No-vig true probability</p>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-[#9ca39a] truncate min-w-0 flex-1 text-right">{away}</span>
                  <span className="text-[14px] font-black font-mono text-white">{trueAway.toFixed(1)}%</span>
                  <span className="text-[9px] text-[#6b7068]">vs</span>
                  <span className="text-[14px] font-black font-mono text-white">{trueHome.toFixed(1)}%</span>
                  <span className="text-[10px] text-[#9ca39a] truncate min-w-0 flex-1">{home}</span>
                </div>
                <div className="mt-2 rounded-full h-1.5 bg-[#22251f] overflow-hidden">
                  <div className="h-full bg-[#3ee68a] transition-all" style={{ width: `${trueAway}%` }} />
                </div>
              </div>
            )}

            {/* Confidence + game overview stats */}
            <div className="flex gap-2">
              <StatBox
                label="Confidence"
                value={conf.tier === "high" ? "High" : conf.tier === "medium" ? "Med" : "Low"}
                sub={`${conf.pct.toFixed(0)}% model read`}
                color={TIER_COLOR[conf.tier]}
              />
              <StatBox
                label="Signals"
                value={String(signals.length)}
                sub={signals.length > 0 ? `${signals.filter(s => s.severity === "high").length} high-impact` : "No signals"}
              />
              <StatBox
                label="Books"
                value={String(books.length)}
                sub="covering this game"
              />
            </div>

            {/* Top signals (preview) */}
            {signals.length > 0 && (
              <div>
                <p className="text-[9px] text-[#6b7068] uppercase tracking-wider mb-2">Top signals</p>
                <div className="space-y-2">
                  {signals.slice(0, 3).map((sig) => {
                    const Icon = SIGNAL_ICON[sig.type] ?? Zap;
                    return (
                      <div key={sig.id} className="flex items-start gap-2.5 rounded-lg border border-[#22251f] bg-[#121412] p-2.5">
                        <Icon className="h-3 w-3 mt-0.5 shrink-0" style={{ color: SEVERITY_COLOR[sig.severity] }} />
                        <div className="min-w-0">
                          <p className="text-[11px] font-semibold text-white leading-snug">{sig.summary}</p>
                          <p className="text-[9px] text-[#6b7068] mt-0.5 leading-relaxed line-clamp-2">{sig.details}</p>
                        </div>
                      </div>
                    );
                  })}
                  {signals.length > 3 && (
                    <button onClick={() => setActiveTab("signals")} className="text-[10px] text-[#3ee68a] hover:text-white transition-colors">
                      View all {signals.length} signals →
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Props placeholder */}
            <div className="rounded-xl border border-dashed border-[#2e332a] p-4 text-center">
              <p className="text-[11px] font-semibold text-[#6b7068]">Player Props</p>
              <p className="text-[9px] text-[#3a4033] mt-1 leading-relaxed">
                Props markets will populate once the data pipeline includes player-level markets from the API.
              </p>
            </div>
          </div>
        )}

        {/* ── Books tab ─────────────────────────────────────────────────── */}
        {activeTab === "books" && (
          <div className="p-4">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[#22251f]">
                    <th className="pb-2 pr-3 text-[9px] text-[#6b7068] font-semibold uppercase tracking-wider">Book</th>
                    <th className="pb-2 px-1 text-[9px] text-[#6b7068] font-semibold uppercase tracking-wider text-center">{away.split(" ").pop()}</th>
                    <th className="pb-2 px-1 text-[9px] text-[#6b7068] font-semibold uppercase tracking-wider text-center">{home.split(" ").pop()}</th>
                    <th className="pb-2 px-1 text-[9px] text-[#6b7068] font-semibold uppercase tracking-wider text-center">Sprd ↓</th>
                    <th className="pb-2 px-1 text-[9px] text-[#6b7068] font-semibold uppercase tracking-wider text-center">Sprd ↑</th>
                    <th className="pb-2 px-1 text-[9px] text-[#6b7068] font-semibold uppercase tracking-wider text-center">O</th>
                    <th className="pb-2 px-1 text-[9px] text-[#6b7068] font-semibold uppercase tracking-wider text-center">U</th>
                  </tr>
                </thead>
                <tbody>
                  {books.map((bk) => {
                    const m = bookMeta(bk);
                    const awayML = getH2H(game, away, bk);
                    const homeML = getH2H(game, home, bk);
                    const awaySprd = getSpread(game, away, bk);
                    const homeSprd = getSpread(game, home, bk);
                    const over = getTotal(game, "Over", bk);
                    const under = getTotal(game, "Under", bk);

                    const awayMLLeg = awayML ? buildLeg(`${game.id}-ml-away`, game, "Moneyline", `${away} ML`, awayML, bk) : null;
                    const homeMLLeg = homeML ? buildLeg(`${game.id}-ml-home`, game, "Moneyline", `${home} ML`, homeML, bk) : null;
                    const awaySpLeg = awaySprd ? buildLeg(`${game.id}-sp-away`, game, "Spread", `${away} ${(awaySprd.point ?? 0) > 0 ? "+" : ""}${awaySprd.point}`, awaySprd.price, bk) : null;
                    const homeSpLeg = homeSprd ? buildLeg(`${game.id}-sp-home`, game, "Spread", `${home} ${(homeSprd.point ?? 0) > 0 ? "+" : ""}${homeSprd.point}`, homeSprd.price, bk) : null;
                    const overLeg = over ? buildLeg(`${game.id}-ov`, game, "Total", `O ${over.point}`, over.price, bk) : null;
                    const underLeg = under ? buildLeg(`${game.id}-un`, game, "Total", `U ${under.point}`, under.price, bk) : null;

                    return (
                      <tr key={bk} className="border-b border-[#161a16] hover:bg-white/[0.01] transition-colors">
                        <td className="py-2 pr-3">
                          <div className="flex items-center gap-2">
                            <img src={bookLogoUrl(bk)} alt={m.name} className="h-4 w-4 rounded-sm opacity-70" />
                            <span className="text-[10px] text-[#9ca39a] font-medium">{m.name}</span>
                          </div>
                        </td>
                        <TableCell price={awayML} isBest={awayML === colBest.awayML} onClick={awayMLLeg ? () => onToggleLeg(awayMLLeg) : undefined} isSelected={awayMLLeg ? selectedIds.includes(awayMLLeg.id) : false} />
                        <TableCell price={homeML} isBest={homeML === colBest.homeML} onClick={homeMLLeg ? () => onToggleLeg(homeMLLeg) : undefined} isSelected={homeMLLeg ? selectedIds.includes(homeMLLeg.id) : false} />
                        <TableCell price={awaySprd?.price ?? null} point={awaySprd?.point} isBest={awaySprd?.price === colBest.awaySpread} onClick={awaySpLeg ? () => onToggleLeg(awaySpLeg) : undefined} isSelected={awaySpLeg ? selectedIds.includes(awaySpLeg.id) : false} />
                        <TableCell price={homeSprd?.price ?? null} point={homeSprd?.point} isBest={homeSprd?.price === colBest.homeSpread} onClick={homeSpLeg ? () => onToggleLeg(homeSpLeg) : undefined} isSelected={homeSpLeg ? selectedIds.includes(homeSpLeg.id) : false} />
                        <TableCell price={over?.price ?? null} point={over?.point} isBest={over?.price === colBest.over} onClick={overLeg ? () => onToggleLeg(overLeg) : undefined} isSelected={overLeg ? selectedIds.includes(overLeg.id) : false} />
                        <TableCell price={under?.price ?? null} point={under?.point} isBest={under?.price === colBest.under} onClick={underLeg ? () => onToggleLeg(underLeg) : undefined} isSelected={underLeg ? selectedIds.includes(underLeg.id) : false} />
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-[9px] text-[#3a4033] text-center">Green = best available price · Click any cell to add to betslip</p>
          </div>
        )}

        {/* ── Signals tab ───────────────────────────────────────────────── */}
        {activeTab === "signals" && (
          <div className="p-4 space-y-2">
            {signals.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-[12px] text-[#6b7068]">No signals for this game</p>
                <p className="text-[10px] text-[#6b7068] mt-1">Check back closer to game time</p>
              </div>
            ) : signals.map((sig) => {
              const Icon = SIGNAL_ICON[sig.type] ?? Zap;
              return (
                <div key={sig.id} className="rounded-xl border border-[#22251f] bg-[#121412] p-3">
                  <div className="flex items-start gap-2.5">
                    <Icon className="h-3.5 w-3.5 mt-0.5 shrink-0" style={{ color: SEVERITY_COLOR[sig.severity] }} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <p className="text-[11px] font-semibold text-white leading-snug">{sig.summary}</p>
                        <span
                          className="shrink-0 text-[7px] font-bold uppercase tracking-widest px-1 py-[1px] rounded"
                          style={{ color: SEVERITY_COLOR[sig.severity], background: `${SEVERITY_COLOR[sig.severity]}18` }}
                        >
                          {sig.severity}
                        </span>
                        <span className="shrink-0 text-[7px] text-[#6b7068] uppercase tracking-widest border border-[#2e332a] px-1 py-[1px] rounded">
                          {sig.certainty}
                        </span>
                      </div>
                      <p className="text-[10px] text-[#9ca39a] leading-relaxed">{sig.details}</p>
                      {sig.benefits.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {sig.benefits.map((b, i) => (
                            <span key={i} className="text-[8px] text-[#3ee68a] bg-[#3ee68a]/8 border border-[#3ee68a]/15 px-1.5 py-0.5 rounded-full">
                              ↑ {b}
                            </span>
                          ))}
                          {sig.harms.map((h, i) => (
                            <span key={i} className="text-[8px] text-[#ef4444] bg-[#ef4444]/8 border border-[#ef4444]/15 px-1.5 py-0.5 rounded-full">
                              ↓ {h}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {/* ── Alert tab ─────────────────────────────────────────────── */}
        {activeTab === "alert" && (
          <div className="p-4 space-y-4">
            <div>
              <p className="text-[9px] text-[#6b7068] uppercase tracking-wider mb-2">Market</p>
              <div className="flex gap-1.5">
                {(["ml", "spread", "total"] as const).map((m) => (
                  <button key={m} onClick={() => updateAlertMarket(m)}
                    className={cn("flex-1 py-2 rounded-lg border text-[10px] font-semibold transition-all",
                      alertForm.market === m ? "border-[#3ee68a]/30 bg-[#3ee68a]/8 text-[#3ee68a]" : "border-[#22251f] text-[#6b7068] hover:text-[#d4d7d0]")}>
                    {m === "ml" ? "Moneyline" : m === "spread" ? "Spread" : "Total"}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="text-[9px] text-[#6b7068] uppercase tracking-wider mb-2">Side</p>
              <div className="flex gap-1.5">
                {alertForm.market === "total" ? (
                  <>
                    {(["over", "under"] as const).map((s) => (
                      <button key={s} onClick={() => updateAlertSide(s)}
                        className={cn("flex-1 py-2 rounded-lg border text-[10px] font-semibold transition-all",
                          alertForm.side === s ? "border-[#3ee68a]/30 bg-[#3ee68a]/8 text-[#3ee68a]" : "border-[#22251f] text-[#6b7068] hover:text-[#d4d7d0]")}>
                        {s === "over" ? "Over" : "Under"}
                      </button>
                    ))}
                  </>
                ) : (
                  <>
                    {(["away", "home"] as const).map((s) => (
                      <button key={s} onClick={() => updateAlertSide(s)}
                        className={cn("flex-1 py-2 rounded-lg border text-[10px] font-semibold transition-all truncate",
                          alertForm.side === s ? "border-[#3ee68a]/30 bg-[#3ee68a]/8 text-[#3ee68a]" : "border-[#22251f] text-[#6b7068] hover:text-[#d4d7d0]")}>
                        {s === "away" ? away.split(" ").pop() : home.split(" ").pop()}
                      </button>
                    ))}
                  </>
                )}
              </div>
            </div>

            <div>
              <p className="text-[9px] text-[#6b7068] uppercase tracking-wider mb-2">Condition</p>
              <div className="flex gap-1.5">
                <button onClick={() => setAlertForm((f) => ({ ...f, condition: "drops_below" }))}
                  className={cn("flex-1 py-2 rounded-lg border text-[10px] font-semibold flex items-center justify-center gap-1.5 transition-all",
                    alertForm.condition === "drops_below" ? "border-[#ef4444]/30 bg-[#ef4444]/8 text-[#ef4444]" : "border-[#22251f] text-[#6b7068] hover:text-[#d4d7d0]")}>
                  <TrendingDown className="h-3 w-3" /> Drops below
                </button>
                <button onClick={() => setAlertForm((f) => ({ ...f, condition: "rises_above" }))}
                  className={cn("flex-1 py-2 rounded-lg border text-[10px] font-semibold flex items-center justify-center gap-1.5 transition-all",
                    alertForm.condition === "rises_above" ? "border-[#3ee68a]/30 bg-[#3ee68a]/8 text-[#3ee68a]" : "border-[#22251f] text-[#6b7068] hover:text-[#d4d7d0]")}>
                  <TrendingUp className="h-3 w-3" /> Rises above
                </button>
              </div>
            </div>

            <div>
              <p className="text-[9px] text-[#6b7068] uppercase tracking-wider mb-2">Target odds</p>
              <input
                type="number"
                value={alertForm.threshold}
                onChange={(e) => setAlertForm((f) => ({ ...f, threshold: Number(e.target.value) }))}
                className="w-full bg-[#121412] border border-[#2e332a] rounded-lg px-3 py-2.5 text-[12px] font-mono text-white outline-none focus:border-[#2e332a]"
              />
            </div>

            <button onClick={handleCreateAlert}
              className={cn("w-full py-3 rounded-xl text-[11px] font-bold transition-all flex items-center justify-center gap-2",
                alertSaved ? "bg-[#1a8a55] text-[#3ee68a]" : "bg-[#3ee68a]/10 border border-[#3ee68a]/20 text-[#3ee68a] hover:bg-[#3ee68a]/15")}>
              {alertSaved ? <><Check className="h-3.5 w-3.5" /> Alert Created</> : "Create Alert"}
            </button>

            <p className="text-[9px] text-[#6b7068] text-center leading-relaxed">
              Watching{" "}
              <span className="text-[#d4d7d0] font-medium">
                {alertForm.side === "away" ? away : alertForm.side === "home" ? home : alertForm.side === "over" ? "Over" : "Under"}
              </span>
              {" · "}{alertForm.market.toUpperCase()}
              {" · "}{alertForm.condition === "drops_below" ? "drops below" : "rises above"}{" "}
              <span className="font-mono">{alertForm.threshold > 0 ? "+" : ""}{alertForm.threshold}</span>
            </p>
          </div>
        )}

      </div>

      {/* Footer — quick open in book */}
      {game.bookmakers.length > 0 && (
        <div className="shrink-0 border-t border-[#22251f] p-3">
          <div className="flex items-center gap-1.5 overflow-x-auto">
            {game.bookmakers.slice(0, 5).map((bk) => {
              const m = bookMeta(bk.sportsbook);
              const url = bookDeepLink(bk.sportsbook, game.sport_title);
              if (!url) return null;
              return (
                <a
                  key={bk.sportsbook}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`Open ${m.name}`}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[#22251f] hover:border-[#2e332a] bg-[#121412] hover:bg-[#161a16] transition-all shrink-0"
                >
                  <img src={bookLogoUrl(bk.sportsbook)} alt={m.name} className="h-3.5 w-3.5 rounded-sm" />
                  <span className="text-[9px] text-[#9ca39a] font-medium">{m.name}</span>
                </a>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
