"use client";

import { useEffect, useState } from "react";
import { loadBets, updateBetStatus, ensureSeedData, computeStats, type BetRecord } from "@/lib/bet-history";
import { bookMeta, bookLogoUrl } from "@/lib/books";
import { formatAmericanOdds } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { TrendingUp, Clock, CheckCircle2, XCircle, BarChart2, Trash2 } from "lucide-react";

const TIER_COLOR: Record<string, string> = {
  high: "#4ade80",
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

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="flex-1 rounded-xl border border-[#141417] bg-[#0c0c0e] p-4">
      <p className="text-[9px] text-[#52525b] uppercase tracking-wider mb-1">{label}</p>
      <p className="text-[22px] font-black font-mono leading-none" style={{ color: color ?? "#e4e4e7" }}>{value}</p>
      {sub && <p className="text-[10px] text-[#3f3f46] mt-1">{sub}</p>}
    </div>
  );
}

function BetCard({ bet, onSettle }: { bet: BetRecord; onSettle: (id: string, s: BetRecord["status"]) => void }) {
  const m = bookMeta(bet.book);
  const isPending = bet.status === "pending";
  const p = profit(bet);

  return (
    <div className={cn(
      "rounded-xl border bg-[#0c0c0e] p-4 transition-all",
      bet.status === "won" ? "border-[#4ade80]/20" : bet.status === "lost" ? "border-[#ef4444]/15" : "border-[#141417]"
    )}>
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-semibold text-white truncate">{bet.label}</p>
          <p className="text-[10px] text-[#52525b] mt-0.5 truncate">{bet.matchup}</p>
        </div>
        <div className="text-right shrink-0">
          <p className={cn("text-[13px] font-bold font-mono", bet.odds > 0 ? "text-[#4ade80]" : "text-[#e4e4e7]")}>
            {formatAmericanOdds(bet.odds)}
          </p>
          {!isPending && (
            <p className={cn("text-[11px] font-mono font-bold", p > 0 ? "text-[#4ade80]" : "text-[#ef4444]")}>
              {p > 0 ? `+$${p.toFixed(2)}` : `-$${Math.abs(p).toFixed(2)}`}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <span className="text-[8px] font-bold uppercase tracking-widest bg-[#111113] border border-[#1e1e24] px-1.5 py-0.5 rounded text-[#52525b]">{bet.market}</span>
        <span className="text-[8px] font-semibold uppercase tracking-wide" style={{ color: TIER_COLOR[bet.confidenceTier] }}>
          {bet.confidenceTier} conf
        </span>
        <div className="flex items-center gap-1 ml-auto">
          <img src={bookLogoUrl(bet.book)} alt={m.name} className="h-3 w-3 rounded-sm opacity-60" />
          <span className="text-[9px] text-[#52525b]">{m.name}</span>
          <span className="text-[9px] text-[#27272a] ml-1">{timeAgo(bet.placedAt)}</span>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-[10px] text-[#52525b]">Stake <span className="text-white font-mono">${bet.stake}</span></span>
        {isPending && (
          <div className="flex gap-1.5 ml-auto">
            <button
              onClick={() => onSettle(bet.id, "won")}
              className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-[#4ade80]/10 border border-[#4ade80]/20 text-[#4ade80] text-[9px] font-bold hover:bg-[#4ade80]/20 transition-colors"
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
            bet.status === "won" ? "text-[#4ade80]" : "text-[#ef4444]"
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
  const [tab, setTab] = useState<"active" | "history" | "stats">("active");

  useEffect(() => {
    ensureSeedData();
    setBets(loadBets());
  }, []);

  function settle(id: string, status: BetRecord["status"]) {
    updateBetStatus(id, status);
    setBets(loadBets());
  }

  const stats = computeStats(bets);
  const pending = bets.filter((b) => b.status === "pending");
  const settled = bets.filter((b) => b.status === "won" || b.status === "lost");

  return (
    <div className="flex-1 overflow-y-auto bg-[#09090b]">
      <div className="max-w-4xl mx-auto px-6 py-6">

        {/* Header */}
        <div className="mb-6">
          <h1 className="text-[20px] font-bold text-white">Tracked</h1>
          <p className="text-[12px] text-[#52525b] mt-1">Your bet history, outcomes, and confidence accuracy.</p>
        </div>

        {/* Stats */}
        <div className="flex gap-3 mb-6">
          <StatCard label="Record" value={stats.record} sub={`${stats.pending} pending`} />
          <StatCard
            label="Profit / Loss"
            value={`${stats.profit >= 0 ? "+" : ""}$${stats.profit.toFixed(0)}`}
            sub={`${stats.roi >= 0 ? "+" : ""}${stats.roi.toFixed(1)}% ROI`}
            color={stats.profit >= 0 ? "#4ade80" : "#ef4444"}
          />
          <StatCard
            label="Win Rate"
            value={`${stats.winRate.toFixed(0)}%`}
            sub="on settled bets"
            color={stats.winRate >= 55 ? "#4ade80" : stats.winRate >= 45 ? "#f59e0b" : "#ef4444"}
          />
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-5 border-b border-[#141417] pb-0">
          {([
            { key: "active", label: `Active (${pending.length})` },
            { key: "history", label: `History (${settled.length})` },
            { key: "stats", label: "Confidence Accuracy" },
          ] as const).map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                "px-4 py-2 text-[11px] font-semibold border-b-2 -mb-px transition-colors",
                tab === t.key
                  ? "text-white border-[#00ff7f]"
                  : "text-[#52525b] border-transparent hover:text-[#a1a1aa]"
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Active tab */}
        {tab === "active" && (
          <div className="space-y-3">
            {pending.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-[#1e1e24] py-12 text-center">
                <Clock className="h-6 w-6 text-[#27272a] mx-auto mb-2" />
                <p className="text-[13px] text-[#52525b] font-medium">No active bets</p>
                <p className="text-[11px] text-[#3f3f46] mt-1">Bets appear here after you click "Open in Book" from the betslip.</p>
              </div>
            ) : pending.map((b) => (
              <BetCard key={b.id} bet={b} onSettle={settle} />
            ))}
          </div>
        )}

        {/* History tab */}
        {tab === "history" && (
          <div className="space-y-3">
            {settled.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-[#1e1e24] py-12 text-center">
                <BarChart2 className="h-6 w-6 text-[#27272a] mx-auto mb-2" />
                <p className="text-[13px] text-[#52525b] font-medium">No settled bets yet</p>
                <p className="text-[11px] text-[#3f3f46] mt-1">Mark active bets as won or lost to build your history.</p>
              </div>
            ) : settled.map((b) => (
              <BetCard key={b.id} bet={b} onSettle={settle} />
            ))}
          </div>
        )}

        {/* Stats tab */}
        {tab === "stats" && (
          <div className="space-y-4">
            <p className="text-[11px] text-[#52525b]">Win rate by confidence tier — how accurate the ACE model has been on your bets.</p>
            {(["high", "medium", "low"] as const).map((tier) => {
              const rate = tier === "high" ? stats.highHit : tier === "medium" ? stats.medHit : stats.lowHit;
              return (
                <div key={tier} className="rounded-xl border border-[#141417] bg-[#0c0c0e] p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: TIER_COLOR[tier] }}>
                        {tier} confidence
                      </span>
                    </div>
                    <span className="text-[18px] font-black font-mono" style={{ color: rate !== null ? TIER_COLOR[tier] : "#27272a" }}>
                      {rate !== null ? `${rate}%` : "—"}
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-[#141417] overflow-hidden">
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
