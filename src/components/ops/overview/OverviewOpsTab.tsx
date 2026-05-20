"use client";

import { useEffect, useState } from "react";
import { Activity, LayoutGrid, RefreshCw, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  KpiCard,
  Panel,
  SectionHead,
  ActionButton,
  OpsPageHeader,
  OpsFooter,
  StatusPill,
  Tag,
  Dot,
  LoadingState,
  EmptyState,
} from "@/components/ops/shared/primitives";
import PerformanceOverTimePanel from "@/components/ops/shared/PerformanceOverTimePanel";
import EdgeBucketsPanel from "@/components/ops/shared/EdgeBucketsPanel";
import ComparisonPanel from "@/components/ops/shared/ComparisonPanel";

type SportKey = "nba" | "wc" | "mlb";

interface SportSummary {
  key: SportKey;
  label: string;
  worker: { lastPollAt: string | null; lastPollOk: boolean | null };
  jobs:   { fetchLastRunAt: string | null; gradeLastRunAt: string | null };
  totals: { total: number; open: number; graded: number; today: number };
  record: { wins: number; losses: number; winRate: number | null; roi: number | null };
  schemaMigratedAt: string | null;
  error?: string;
}

interface RecentSignal {
  sport: SportKey;
  game_id: string;
  game_date: string;
  matchup: string;
  market: string;
  bet_side: string;
  book: string;
  edge_pp: number | null;
  confidence_tier: "A" | "B" | "C" | null;
  status: string;
  correct: number | null;
  detected_at: string;
}

interface OverviewResponse {
  sports: SportSummary[];
  recent: RecentSignal[];
  refreshedAt: string;
}

interface QuotaResponse {
  ok: boolean;
  reason?: string;
  plan_credits?: number;
  remaining?: number;
  used?: number;
  pct_used?: number;
  pct_remaining?: number;
  last_cost?: number | null;
  source?: string;
  endpoint?: string;
  seen_at?: string;
  age_seconds?: number;
}

const SPORT_EMOJI: Record<SportKey, string> = {
  nba: "🏀",
  wc:  "⚽",
  mlb: "⚾",
};

const SPORT_ACCENT: Record<SportKey, string> = {
  nba: "#f5c062",   // amber
  wc:  "#3ee68a",   // green
  mlb: "#7ab8ff",   // soft blue
};

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60)        return `${s}s ago`;
  if (s < 3600)      return `${Math.floor(s / 60)}m ago`;
  if (s < 86400)     return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function fmtPct(v: number | null): string {
  if (v === null || v === undefined) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

function fmtRoi(v: number | null): string {
  if (v === null || v === undefined) return "—";
  return `${v > 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;
}

function SportCard({ sport }: { sport: SportSummary }) {
  const accent = SPORT_ACCENT[sport.key];
  const emoji  = SPORT_EMOJI[sport.key];
  const healthy = sport.worker.lastPollAt && (sport.worker.lastPollOk !== false);
  const healthDotColor = sport.worker.lastPollOk === false
    ? "#ef4444"
    : sport.worker.lastPollAt
    ? accent
    : "#6b7068";

  return (
    <div className="rounded-xl border border-[#22251f] bg-[#0d0f0d] p-5 flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div
            className="h-9 w-9 rounded-lg flex items-center justify-center text-[18px]"
            style={{ background: `${accent}15`, border: `1px solid ${accent}30` }}
          >
            {emoji}
          </div>
          <div>
            <p className="text-[14px] font-bold text-white">{sport.label}</p>
            <p className="text-[9px] text-[#6b7068] uppercase tracking-[0.15em] flex items-center gap-1.5">
              <span
                className={cn("h-1.5 w-1.5 rounded-full", healthy && "animate-pulse")}
                style={{ background: healthDotColor }}
              />
              worker · {timeAgo(sport.worker.lastPollAt)}
            </p>
          </div>
        </div>
        {sport.totals.today > 0 && (
          <span
            className="text-[10px] font-bold px-2 py-1 rounded uppercase tracking-[0.15em]"
            style={{ background: `${accent}15`, color: accent, border: `1px solid ${accent}30` }}
          >
            {sport.totals.today} today
          </span>
        )}
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-2.5">
        <div className="rounded border border-[#1a1e1a] bg-[#0a0b0a] px-3 py-2">
          <p className="text-[9px] text-[#6b7068] uppercase tracking-[0.15em]">Signals</p>
          <p className="text-[16px] font-bold text-white font-mono mt-1">{sport.totals.total}</p>
          <p className="text-[9px] text-[#6b7068] mt-0.5">{sport.totals.open} open · {sport.totals.graded} graded</p>
        </div>
        <div className="rounded border border-[#1a1e1a] bg-[#0a0b0a] px-3 py-2">
          <p className="text-[9px] text-[#6b7068] uppercase tracking-[0.15em]">Win rate</p>
          <p className="text-[16px] font-bold text-white font-mono mt-1">{fmtPct(sport.record.winRate)}</p>
          <p className="text-[9px] text-[#6b7068] mt-0.5">{sport.record.wins}W / {sport.record.losses}L</p>
        </div>
        <div className="rounded border border-[#1a1e1a] bg-[#0a0b0a] px-3 py-2 col-span-2">
          <p className="text-[9px] text-[#6b7068] uppercase tracking-[0.15em]">ROI</p>
          <p
            className="text-[16px] font-bold font-mono mt-1"
            style={{ color: (sport.record.roi ?? 0) > 0 ? accent : (sport.record.roi !== null && sport.record.roi < 0 ? "#ef4444" : "#9ca39a") }}
          >
            {fmtRoi(sport.record.roi)}
          </p>
        </div>
      </div>

      {/* Schema/job footer */}
      <div className="text-[9px] text-[#6b7068] uppercase tracking-[0.12em] flex flex-col gap-1 pt-1 border-t border-[#1a1e1a]">
        <span>fetch · {timeAgo(sport.jobs.fetchLastRunAt)}</span>
        <span>grade · {timeAgo(sport.jobs.gradeLastRunAt)}</span>
        {sport.error && <span className="text-[#ef4444]">⚠ {sport.error}</span>}
      </div>
    </div>
  );
}

function QuotaStrip({ quota }: { quota: QuotaResponse | null }) {
  if (!quota || quota.ok === false) {
    return (
      <Panel>
        <SectionHead icon={Zap} title="Odds API quota" />
        <p className="text-[12px] text-[#9ca39a]">
          No quota data yet — will populate after the next paying Odds API call.
        </p>
      </Panel>
    );
  }

  const pctUsed = quota.pct_used ?? 0;
  // Banded color: green / amber / red so you can eyeball headroom without
  // doing math. 60%/85% thresholds line up with "comfortable / getting tight /
  // start throttling" for a 100K monthly budget.
  const usedColor = pctUsed >= 85 ? "#ef4444" : pctUsed >= 60 ? "#f5c062" : "#3ee68a";

  return (
    <Panel>
      <SectionHead
        icon={Zap}
        title="Odds API quota"
        right={
          <p className="text-[9px] text-[#6b7068] uppercase tracking-[0.12em]">
            last seen {quota.age_seconds != null ? `${quota.age_seconds}s ago` : "—"}
            {quota.source ? ` · ${quota.source}` : ""}
          </p>
        }
      />
      <div className="flex gap-3 flex-wrap">
        <KpiCard label="% Used"     value={`${pctUsed.toFixed(1)}%`} color={usedColor} />
        <KpiCard label="Used"       value={(quota.used ?? 0).toLocaleString()} />
        <KpiCard
          label="Remaining"
          value={(quota.remaining ?? 0).toLocaleString()}
          sub={`of ${(quota.plan_credits ?? 100000).toLocaleString()}`}
        />
        <KpiCard
          label="Last call"
          value={`${quota.last_cost ?? "—"}`}
          sub="credits"
        />
      </div>
      {/* Linear bar — the at-a-glance "are we red?" indicator */}
      <div className="mt-3 h-1.5 rounded-full bg-[#1a1e1a] overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${Math.min(100, pctUsed)}%`, background: usedColor }}
        />
      </div>
    </Panel>
  );
}

export default function OverviewOpsTab() {
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [quota, setQuota] = useState<QuotaResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  async function load(silent = false) {
    if (!silent) setRefreshing(true);
    try {
      // Overview + quota fetched in parallel — both small JSON, both cheap
      const [overviewRes, quotaRes] = await Promise.all([
        fetch("/api/ops/overview", { cache: "no-store" }),
        fetch("/api/ops/odds-quota", { cache: "no-store" }),
      ]);
      setData((await overviewRes.json()) as OverviewResponse);
      setQuota((await quotaRes.json()) as QuotaResponse);
    } catch {
      // silent
    } finally {
      setLoading(false);
      if (!silent) setRefreshing(false);
    }
  }

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(true), 30_000);
    return () => clearInterval(id);
  }, []);

  if (loading) return <LoadingState label="Loading overview…" />;
  if (!data) {
    return (
      <div className="flex flex-1 items-center justify-center text-[12px] text-[#ef4444]">
        Failed to load overview
      </div>
    );
  }

  // Cross-sport aggregate
  const totalAcross = data.sports.reduce((a, s) => a + s.totals.total, 0);
  const todayAcross = data.sports.reduce((a, s) => a + s.totals.today, 0);
  const gradedAcross = data.sports.reduce((a, s) => a + s.record.wins + s.record.losses, 0);
  const winsAcross   = data.sports.reduce((a, s) => a + s.record.wins, 0);
  const lossesAcross = data.sports.reduce((a, s) => a + s.record.losses, 0);
  const aggWinRate   = gradedAcross > 0 ? winsAcross / gradedAcross : null;
  const aggRoi       = gradedAcross > 0
    ? (winsAcross * (100 / 110) + lossesAcross * -1) / gradedAcross
    : null;

  return (
    <div className="flex-1 overflow-y-auto bg-[#0a0b0a]">
      <div className="max-w-[1200px] mx-auto px-6 py-7 space-y-5">

        {/* Header — same shape as the per-sport tabs */}
        <OpsPageHeader
          icon={LayoutGrid}
          title="All sports overview"
          tag="cross-sport"
          tagColor="#3ee68a"
          actions={
            <ActionButton
              icon={RefreshCw}
              variant="subtle"
              busy={refreshing}
              disabled={refreshing}
              onClick={() => void load(false)}
            />
          }
        />

        {/* Cross-sport aggregate KPI row */}
        <div className="flex gap-3 flex-wrap">
          <KpiCard label="Signals (all-time)" value={String(totalAcross)} />
          <KpiCard label="Today" value={String(todayAcross)} color="#3ee68a" />
          <KpiCard
            label="Win rate"
            value={fmtPct(aggWinRate)}
            sub={`${winsAcross}W / ${lossesAcross}L`}
          />
          <KpiCard
            label="ROI"
            value={fmtRoi(aggRoi)}
            color={(aggRoi ?? 0) > 0 ? "#3ee68a" : (aggRoi !== null && aggRoi < 0 ? "#ef4444" : "#9ca39a")}
          />
        </div>

        {/* Odds API credit headroom — surfaces /api/ops/odds-quota.
            Color scales: green <60% used, amber 60-85%, red >85%. */}
        <QuotaStrip quota={quota} />

        {/* The lab tool — performance trend across sports + metrics over time.
            Lives above per-sport cards because "are we getting better?" is
            the question every operator opens this dashboard to answer. */}
        <PerformanceOverTimePanel />

        {/* Edge-bucket validator — "is edge magnitude actually predictive?"
            If high-edge picks don't beat low-edge picks, our tiering is
            broken and a tier-A label is just decoration. */}
        <EdgeBucketsPanel />

        {/* Comparison — hypothesis tester for any two slices of the data.
            Pick Tier A vs B, FanDuel vs DraftKings, last-30d vs prior-30d,
            etc. — answers questions that the other panels surface but
            don't isolate. The lab's free-form workbench. */}
        <ComparisonPanel />

        {/* Per-sport cards */}
        <div className="grid grid-cols-3 gap-3">
          {data.sports.map((s) => (
            <SportCard key={s.key} sport={s} />
          ))}
        </div>

        {/* Recent cross-sport signal stream */}
        <Panel>
          <SectionHead icon={Activity} title="Recent signals · all sports" />
          {data.recent.length === 0 ? (
            <EmptyState>No signals across any sport yet. Workers populate this as games come in.</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[10px]">
                <thead className="text-[#6b7068] uppercase tracking-[0.12em] border-b border-[#22251f]">
                  <tr>
                    <th className="py-2 px-2 font-semibold">Sport</th>
                    <th className="py-2 px-2 font-semibold">Matchup</th>
                    <th className="py-2 px-2 font-semibold">Pick</th>
                    <th className="py-2 px-2 font-semibold">Book</th>
                    <th className="py-2 px-2 font-semibold text-right">Edge</th>
                    <th className="py-2 px-2 font-semibold text-center">Tier</th>
                    <th className="py-2 px-2 font-semibold">When</th>
                    <th className="py-2 px-2 font-semibold text-center">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#181c18] font-mono">
                  {data.recent.map((s, i) => (
                    <tr key={`${s.sport}-${s.game_id}-${s.market}-${s.bet_side}-${i}`} className="text-[#c4c7c0]">
                      <td className="py-2 px-2">
                        <span style={{ color: SPORT_ACCENT[s.sport] }}>{SPORT_EMOJI[s.sport]}</span>
                        <span className="ml-1.5 text-[#9ca39a] uppercase">{s.sport}</span>
                      </td>
                      <td className="py-2 px-2 truncate max-w-[180px]">{s.matchup}</td>
                      <td className="py-2 px-2 text-white">{s.market}/{s.bet_side.toUpperCase()}</td>
                      <td className="py-2 px-2 text-[#9ca39a]">{s.book || "—"}</td>
                      <td className="py-2 px-2 text-right text-[#3ee68a]">
                        {s.edge_pp !== null ? `${(s.edge_pp * 100).toFixed(1)}pp` : "—"}
                      </td>
                      <td className="py-2 px-2 text-center">
                        {s.confidence_tier ? (
                          <span className={cn(
                            "inline-block px-1.5 py-[1px] rounded text-[8px] font-bold",
                            s.confidence_tier === "A" && "bg-[#3ee68a]/20 text-[#3ee68a]",
                            s.confidence_tier === "B" && "bg-[#f5c062]/15 text-[#f5c062]",
                            s.confidence_tier === "C" && "bg-[#6b7068]/15 text-[#6b7068]",
                          )}>{s.confidence_tier}</span>
                        ) : <span className="text-[#3a4033]">—</span>}
                      </td>
                      <td className="py-2 px-2 text-[#9ca39a]">{timeAgo(s.detected_at)}</td>
                      <td className="py-2 px-2 text-center">
                        {s.status === "graded" && s.correct === 1 && <span className="text-[#3ee68a]">WIN</span>}
                        {s.status === "graded" && s.correct === 0 && <span className="text-[#ef4444]">LOSS</span>}
                        {s.status === "open" && <span className="text-[#9ca39a]">open</span>}
                        {s.status === "void" && <span className="text-[#6b7068]">void</span>}
                        {s.status === "proxy_captured" && <span className="text-[#9ca39a]">pending</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {/* Footer */}
        <OpsFooter
          refreshedAt={data.refreshedAt}
          schemaText="ACE multi-sport · live signal layer"
        />
      </div>
    </div>
  );
}
