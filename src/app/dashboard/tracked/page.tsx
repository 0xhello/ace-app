"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { bookMeta, bookLogoUrl } from "@/lib/books";
import { formatAmericanOdds } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { formatEtDate, formatEtTimeLabel } from "@/lib/time-format";
import { TrendingUp, Clock, CheckCircle2, XCircle, BarChart2, RefreshCw, Star } from "lucide-react";

interface BetRecord {
  id: string;
  gameId: string;
  matchup: string;
  market: string;
  label: string;
  odds: number;
  book: string;
  stake: number;
  confidenceTier: "high" | "medium" | "low";
  status: "pending" | "won" | "lost" | "void";
  placedAt: string;
  settledAt?: string;
}

const TIER_COLOR: Record<string, string> = {
  high: "#3ee68a",
  medium: "#f59e0b",
  low: "#ef4444",
};

function decimalOdds(american: number) {
  return american > 0 ? american / 100 + 1 : 100 / Math.abs(american) + 1;
}

function profit(bet: BetRecord): number {
  if (bet.status === "won") return bet.stake * (decimalOdds(bet.odds) - 1);
  if (bet.status === "lost") return -bet.stake;
  return 0;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  return "just now";
}

function computeStats(bets: BetRecord[]) {
  const settled = bets.filter((b) => b.status === "won" || b.status === "lost");
  const wins = settled.filter((b) => b.status === "won");
  const totalStaked = settled.reduce((a, b) => a + b.stake, 0);
  const totalReturned = wins.reduce((a, b) => {
    const dec = b.odds > 0 ? b.odds / 100 + 1 : 100 / Math.abs(b.odds) + 1;
    return a + b.stake * dec;
  }, 0);
  const pnl = totalReturned - totalStaked;
  const roi = totalStaked > 0 ? (pnl / totalStaked) * 100 : 0;
  const winRate = settled.length > 0 ? (wins.length / settled.length) * 100 : 0;

  const byTier = (tier: BetRecord["confidenceTier"]) => {
    const s = settled.filter((b) => b.confidenceTier === tier);
    const w = s.filter((b) => b.status === "won");
    return s.length > 0 ? Math.round((w.length / s.length) * 100) : null;
  };

  return {
    record: `${wins.length}-${settled.length - wins.length}`,
    pending: bets.filter((b) => b.status === "pending").length,
    profit: pnl,
    roi,
    winRate,
    highHit: byTier("high"),
    medHit: byTier("medium"),
    lowHit: byTier("low"),
  };
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="flex-1 rounded-xl border border-[#22251f] bg-[#121412] p-4">
      <p className="text-[9px] text-[#6b7068] uppercase tracking-wider mb-1">{label}</p>
      <p className="text-[22px] font-black font-mono leading-none" style={{ color: color ?? "#e4e4e7" }}>{value}</p>
      {sub && <p className="text-[10px] text-[#6b7068] mt-1">{sub}</p>}
    </div>
  );
}

function BetCard({ bet, onSettle }: { bet: BetRecord; onSettle: (id: string, s: BetRecord["status"]) => void }) {
  const m = bookMeta(bet.book);
  const isPending = bet.status === "pending";
  const p = profit(bet);

  return (
    <div className={cn(
      "rounded-xl border bg-[#121412] p-4 transition-all",
      bet.status === "won" ? "border-[#3ee68a]/20" : bet.status === "lost" ? "border-[#ef4444]/15" : "border-[#22251f]"
    )}>
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-semibold text-white truncate">{bet.label}</p>
          <p className="text-[10px] text-[#6b7068] mt-0.5 truncate">{bet.matchup}</p>
        </div>
        <div className="text-right shrink-0">
          <p className={cn("text-[13px] font-bold font-mono", bet.odds > 0 ? "text-[#3ee68a]" : "text-[#e4e4e7]")}>
            {formatAmericanOdds(bet.odds)}
          </p>
          {!isPending && (
            <p className={cn("text-[11px] font-mono font-bold", p > 0 ? "text-[#3ee68a]" : "text-[#ef4444]")}>
              {p > 0 ? `+$${p.toFixed(2)}` : `-$${Math.abs(p).toFixed(2)}`}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <span className="text-[8px] font-bold uppercase tracking-widest bg-[#111113] border border-[#2e332a] px-1.5 py-0.5 rounded text-[#6b7068]">{bet.market}</span>
        <span className="text-[8px] font-semibold uppercase tracking-wide" style={{ color: TIER_COLOR[bet.confidenceTier] }}>
          {bet.confidenceTier} strength
        </span>
        <div className="flex items-center gap-1 ml-auto">
          <img src={bookLogoUrl(bet.book)} alt={m.name} className="h-3 w-3 rounded-sm opacity-60" />
          <span className="text-[9px] text-[#6b7068]">{m.name}</span>
          <span className="text-[9px] text-[#27272a] ml-1">{timeAgo(bet.placedAt)}</span>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-[10px] text-[#6b7068]">Stake <span className="text-white font-mono">${bet.stake}</span></span>
        {isPending && (
          <div className="flex gap-1.5 ml-auto">
            <button
              onClick={() => onSettle(bet.id, "won")}
              className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-[#3ee68a]/10 border border-[#3ee68a]/20 text-[#3ee68a] text-[9px] font-bold hover:bg-[#3ee68a]/20 transition-colors"
            >
              <CheckCircle2 className="h-3 w-3" /> Won
            </button>
            <button
              onClick={() => onSettle(bet.id, "lost")}
              className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-[#ef4444]/10 border border-[#ef4444]/20 text-[#ef4444] text-[9px] font-bold hover:bg-[#ef4444]/20 transition-colors"
            >
              <XCircle className="h-3 w-3" /> Lost
            </button>
          </div>
        )}
        {!isPending && (
          <div className={cn(
            "ml-auto flex items-center gap-1 text-[9px] font-bold uppercase tracking-wide",
            bet.status === "won" ? "text-[#3ee68a]" : "text-[#ef4444]"
          )}>
            {bet.status === "won" ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
            {bet.status}
          </div>
        )}
      </div>
    </div>
  );
}

export default function TrackedPage() {
  const [bets, setBets] = useState<BetRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"watching" | "active" | "history" | "stats">("active");
  const [watchedGames, setWatchedGames] = useState<any[]>([]);
  const [watchLoading, setWatchLoading] = useState(true);

  const fetchBets = useCallback(async () => {
    try {
      const res = await fetch("/api/bets");
      if (res.ok) {
        const data = await res.json();
        setBets(data.bets ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchBets(); }, [fetchBets]);

  useEffect(() => {
    async function loadWatching() {
      try {
        const [wl, board] = await Promise.all([
          fetch("/api/watchlist").then((r) => r.json()),
          fetch("/api/board").then((r) => r.json()),
        ]);
        const ids = new Set<string>(wl.gameIds ?? []);
        setWatchedGames((board.games ?? []).filter((g: any) => ids.has(g.id)));
      } finally {
        setWatchLoading(false);
      }
    }
    loadWatching();
  }, []);

  async function settle(id: string, status: BetRecord["status"]) {
    await fetch(`/api/bets/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    fetchBets();
  }

  const stats = computeStats(bets);
  const pending = bets.filter((b) => b.status === "pending");
  const settled = bets.filter((b) => b.status === "won" || b.status === "lost");

  if (loading) {
    return (
      <div className="flex-1 overflow-y-auto bg-[#0a0b0a] flex items-center justify-center">
        <RefreshCw className="h-4 w-4 text-[#3a4033] animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto bg-[#0a0b0a]">
      <div className="max-w-4xl mx-auto px-6 py-6">

        <div className="mb-6">
          <h1 className="text-[20px] font-bold text-white">Tracked</h1>
          <p className="text-[12px] text-[#6b7068] mt-1">Your bet history, outcomes, and signal-strength accuracy.</p>
        </div>

        <div className="flex gap-3 mb-6">
          <StatCard label="Record" value={stats.record} sub={`${stats.pending} pending`} />
          <StatCard
            label="Profit / Loss"
            value={`${stats.profit >= 0 ? "+" : ""}$${stats.profit.toFixed(0)}`}
            sub={`${stats.roi >= 0 ? "+" : ""}${stats.roi.toFixed(1)}% ROI`}
            color={stats.profit >= 0 ? "#3ee68a" : "#ef4444"}
          />
          <StatCard
            label="Win Rate"
            value={`${stats.winRate.toFixed(0)}%`}
            sub="on settled bets"
            color={stats.winRate >= 55 ? "#3ee68a" : stats.winRate >= 45 ? "#f59e0b" : "#ef4444"}
          />
        </div>

        <div className="flex gap-1 mb-5 border-b border-[#22251f] pb-0">
          {([
            { key: "watching", label: `Watching (${watchedGames.length})` },
            { key: "active", label: `Active (${pending.length})` },
            { key: "history", label: `History (${settled.length})` },
            { key: "stats", label: "Signal Strength Accuracy" },
          ] as const).map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                "px-4 py-2 text-[11px] font-semibold border-b-2 -mb-px transition-colors",
                tab === t.key
                  ? "text-white border-[#3ee68a]"
                  : "text-[#6b7068] border-transparent hover:text-[#d4d7d0]"
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "watching" && (
          <div className="space-y-3">
            {watchLoading ? (
              <div className="flex items-center justify-center py-12">
                <RefreshCw className="h-4 w-4 text-[#3a4033] animate-spin" />
              </div>
            ) : watchedGames.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-[#2e332a] py-12 text-center">
                <Star className="h-6 w-6 text-[#27272a] mx-auto mb-2" />
                <p className="text-[13px] text-[#6b7068] font-medium">No watched games</p>
                <p className="text-[11px] text-[#6b7068] mt-1">Star a game on the main board to track it here.</p>
              </div>
            ) : watchedGames.map((g: any) => {
              const homeAbbr = g.home_team.split(" ").at(-1);
              const awayAbbr = g.away_team.split(" ").at(-1);
              const isLive = g.status === "live";
              const hs = g.scoreboard?.home_score != null ? Number(g.scoreboard.home_score) : null;
              const as_ = g.scoreboard?.away_score != null ? Number(g.scoreboard.away_score) : null;
              const allSpreads = g.bookmakers?.flatMap((b: any) => b.markets?.spreads ?? []) ?? [];
              const homeSpread = allSpreads.find((s: any) => s.name === g.home_team);
              const homeLine = homeSpread?.point ?? null;
              let coverMargin: number | null = null;
              if (hs !== null && as_ !== null && homeLine !== null) {
                coverMargin = (hs - as_) + homeLine;
              }
              const coverTeam = coverMargin !== null && coverMargin !== 0
                ? (coverMargin > 0 ? homeAbbr : awayAbbr)
                : null;
              return (
                <Link href={`/dashboard/tracked/${g.id}`} key={g.id} className="block rounded-xl border border-[#22251f] bg-[#121412] p-4 hover:border-[#2e332a] transition-all group">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-[12px] font-semibold text-white">{awayAbbr} @ {homeAbbr}</p>
                      <p className="text-[10px] text-[#6b7068] mt-0.5">{g.sport_title} · {formatEtDate(g.commence_time)}</p>
                    </div>
                    {isLive ? (
                      <div className="text-right">
                        <p className="text-[10px] font-bold text-[#ef4444] flex items-center gap-1 justify-end">
                          <span className="h-1.5 w-1.5 rounded-full bg-[#ef4444] animate-pulse inline-block" />LIVE
                        </p>
                        {hs !== null && as_ !== null && (
                          <p className="text-[16px] font-black font-mono text-white">{as_}–{hs}</p>
                        )}
                      </div>
                    ) : hs !== null && as_ !== null ? (
                      <div className="text-right">
                        <p className="text-[10px] text-[#4a524a]">FINAL</p>
                        <p className="text-[16px] font-black font-mono text-white">{as_}–{hs}</p>
                      </div>
                    ) : (
                      <p className="text-[11px] text-[#4a524a]">
                        {formatEtTimeLabel(g.commence_time)}
                      </p>
                    )}
                  </div>
                  {(homeLine !== null || coverTeam) && (
                    <div className="flex items-center gap-3 mt-3 pt-3 border-t border-[#22251f]">
                      {homeLine !== null && (
                        <span className="text-[10px] text-[#6b7068] font-mono">
                          {homeAbbr} {homeLine > 0 ? "+" : ""}{homeLine}
                        </span>
                      )}
                      {coverTeam && (
                        <span className="text-[10px] font-bold text-[#3ee68a]">
                          {coverTeam} covering ✓
                        </span>
                      )}
                      <span className="ml-auto text-[10px] text-[#3ee68a] opacity-0 group-hover:opacity-100 transition-opacity font-medium">
                        View intel →
                      </span>
                    </div>
                  )}
                </Link>
              );
            })}
          </div>
        )}

        {tab === "active" && (
          <div className="space-y-3">
            {pending.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-[#2e332a] py-12 text-center">
                <Clock className="h-6 w-6 text-[#27272a] mx-auto mb-2" />
                <p className="text-[13px] text-[#6b7068] font-medium">No active bets</p>
                <p className="text-[11px] text-[#6b7068] mt-1">Bets appear here after you click "Open in Book" from the betslip.</p>
              </div>
            ) : pending.map((b) => (
              <BetCard key={b.id} bet={b} onSettle={settle} />
            ))}
          </div>
        )}

        {tab === "history" && (
          <div className="space-y-3">
            {settled.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-[#2e332a] py-12 text-center">
                <BarChart2 className="h-6 w-6 text-[#27272a] mx-auto mb-2" />
                <p className="text-[13px] text-[#6b7068] font-medium">No settled bets yet</p>
                <p className="text-[11px] text-[#6b7068] mt-1">Mark active bets as won or lost to build your history.</p>
              </div>
            ) : settled.map((b) => (
              <BetCard key={b.id} bet={b} onSettle={settle} />
            ))}
          </div>
        )}

        {tab === "stats" && (
          <div className="space-y-4">
            <p className="text-[11px] text-[#6b7068]">Win rate by signal-strength tier — heuristic strength versus actual outcomes.</p>
            {(["high", "medium", "low"] as const).map((tier) => {
              const rate = tier === "high" ? stats.highHit : tier === "medium" ? stats.medHit : stats.lowHit;
              return (
                <div key={tier} className="rounded-xl border border-[#22251f] bg-[#121412] p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: TIER_COLOR[tier] }}>
                      {tier} strength
                    </span>
                    <span className="text-[18px] font-black font-mono" style={{ color: rate !== null ? TIER_COLOR[tier] : "#27272a" }}>
                      {rate !== null ? `${rate}%` : "—"}
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-[#22251f] overflow-hidden">
                    {rate !== null && (
                      <div className="h-full rounded-full transition-all" style={{ width: `${rate}%`, background: TIER_COLOR[tier] }} />
                    )}
                  </div>
                  {rate === null && (
                    <p className="text-[9px] text-[#27272a] mt-1">No settled bets at this tier yet</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
