"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, Database, RefreshCw, Zap } from "lucide-react";
import { ActionButton, EmptyState, KpiCard, LoadingState, OpsFooter, OpsPageHeader, Panel, SectionHead, Tag } from "@/components/ops/shared/primitives";
import { fmtSport, fmtUnits, type ResultsSummaryRow } from "@/components/ops/shared/ledger";

interface ResultsResponse {
  available: boolean;
  message?: string;
  summary: ResultsSummaryRow[];
  picks: unknown[];
  refreshedAt: string;
}

interface OverviewSport {
  key: string;
  label: string;
  worker: { lastPollAt: string | null; lastPollOk: boolean | null };
  jobs: { fetchLastRunAt: string | null; gradeLastRunAt: string | null };
  totals: { total: number; open: number; graded: number; today: number };
  record: { wins: number; losses: number; winRate: number | null; roi: number | null };
  error?: string;
}

interface OverviewResponse {
  sports: OverviewSport[];
  refreshedAt: string;
}

interface QuotaResponse {
  ok: boolean;
  reason?: string;
  plan_credits?: number;
  remaining?: number;
  used?: number;
  pct_used?: number;
  last_cost?: number | null;
  age_seconds?: number;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso.replace(" ", "T")).getTime();
  if (Number.isNaN(ms)) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function DiagnosticsOpsTab() {
  const [results, setResults] = useState<ResultsResponse | null>(null);
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [quota, setQuota] = useState<QuotaResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  async function load() {
    setRefreshing(true);
    try {
      const [resultsRes, overviewRes, quotaRes] = await Promise.all([
        fetch("/api/ops/results", { cache: "no-store" }),
        fetch("/api/ops/overview", { cache: "no-store" }),
        fetch("/api/ops/odds-quota", { cache: "no-store" }),
      ]);
      setResults((await resultsRes.json()) as ResultsResponse);
      setOverview((await overviewRes.json()) as OverviewResponse);
      setQuota((await quotaRes.json()) as QuotaResponse);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const canonical = useMemo(() => {
    const summary = results?.summary ?? [];
    return {
      graded: summary.reduce((sum, row) => sum + (row.graded ?? 0), 0),
      wins: summary.reduce((sum, row) => sum + (row.wins ?? 0), 0),
      losses: summary.reduce((sum, row) => sum + (row.losses ?? 0), 0),
      pnl: summary.reduce((sum, row) => sum + (row.pnl_units ?? 0), 0),
      rows: results?.picks.length ?? 0,
    };
  }, [results]);

  if (loading) return <LoadingState label="Loading diagnostics…" />;

  const pctUsed = quota?.pct_used ?? null;

  return (
    <div className="mx-auto max-w-[1200px] space-y-5 px-6 py-7">
      <OpsPageHeader
        icon={Database}
        title="Diagnostics"
        tag="system health"
        tagColor="#9ca39a"
        actions={<ActionButton icon={RefreshCw} variant="subtle" busy={refreshing} disabled={refreshing} onClick={() => void load()} />}
      />

      <Panel>
        <SectionHead icon={Database} title="Canonical ledger" right={<Tag label={results?.available ? "available" : "missing"} color={results?.available ? "#3ee68a" : "#ef4444"} />} />
        <p className="mb-4 max-w-[760px] text-[12px] leading-relaxed text-[#9ca39a]">
          This is the source used by Today and Results. Legacy sport logs are still shown below for raw diagnostics, but they are not the default performance truth.
        </p>
        {results?.available ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_1fr_1fr]">
            <KpiCard label="Graded rows" value={String(canonical.graded)} />
            <KpiCard label="Record" value={`${canonical.wins}W-${canonical.losses}L`} />
            <KpiCard label="Paper P&L" value={fmtUnits(canonical.pnl)} color={canonical.pnl >= 0 ? "#3ee68a" : "#ef4444"} />
            <KpiCard label="API rows" value={String(canonical.rows)} sub="returned by Results" />
          </div>
        ) : (
          <EmptyState>{results?.message ?? "Canonical tracked-picks ledger is not available yet."}</EmptyState>
        )}
      </Panel>

      <Panel>
        <SectionHead icon={Activity} title="Legacy sport logs" right={<Tag label="diagnostic only" color="#f5c062" />} />
        <p className="mb-4 max-w-[760px] text-[12px] leading-relaxed text-[#9ca39a]">
          These counts come from the older sport-specific logs. Local and production can diverge, so use this panel to spot stale data or worker issues, not as the main Results surface.
        </p>
        {(overview?.sports ?? []).length === 0 ? (
          <EmptyState>No legacy sport-log diagnostics available.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[10px] font-mono">
              <thead className="border-b border-[#22251f] text-[#6b7068] uppercase tracking-[0.12em]">
                <tr>
                  <th className="px-2 py-2 font-semibold">Sport</th>
                  <th className="px-2 py-2 font-semibold text-right">Signals</th>
                  <th className="px-2 py-2 font-semibold text-right">Open</th>
                  <th className="px-2 py-2 font-semibold text-right">Graded</th>
                  <th className="px-2 py-2 font-semibold">Worker</th>
                  <th className="px-2 py-2 font-semibold">Fetch</th>
                  <th className="px-2 py-2 font-semibold">Grade</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#181c18]">
                {(overview?.sports ?? []).map((sport) => (
                  <tr key={sport.key} className="text-[#c4c7c0]">
                    <td className="px-2 py-2 text-white">{fmtSport(sport.label)}</td>
                    <td className="px-2 py-2 text-right">{sport.totals.total}</td>
                    <td className="px-2 py-2 text-right">{sport.totals.open}</td>
                    <td className="px-2 py-2 text-right">{sport.totals.graded}</td>
                    <td className="px-2 py-2 text-[#9ca39a]">{timeAgo(sport.worker.lastPollAt)}</td>
                    <td className="px-2 py-2 text-[#9ca39a]">{timeAgo(sport.jobs.fetchLastRunAt)}</td>
                    <td className="px-2 py-2 text-[#9ca39a]">{timeAgo(sport.jobs.gradeLastRunAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel>
        <SectionHead icon={Zap} title="Odds API quota" />
        {quota?.ok ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <KpiCard label="Used" value={(quota.used ?? 0).toLocaleString()} />
            <KpiCard label="Remaining" value={(quota.remaining ?? 0).toLocaleString()} />
            <KpiCard label="Pct used" value={pctUsed == null ? "—" : `${pctUsed.toFixed(1)}%`} color={(pctUsed ?? 0) >= 85 ? "#ef4444" : (pctUsed ?? 0) >= 60 ? "#f5c062" : "#3ee68a"} />
            <KpiCard label="Last call" value={String(quota.last_cost ?? "—")} sub="credits" />
          </div>
        ) : (
          <EmptyState>{quota?.reason ?? "No quota data available yet."}</EmptyState>
        )}
      </Panel>

      <OpsFooter refreshedAt={results?.refreshedAt ?? overview?.refreshedAt ?? new Date().toISOString()} schemaText="Diagnostics · canonical plus legacy logs" />
    </div>
  );
}
