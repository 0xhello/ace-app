"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, BarChart3, Database, RefreshCw, Zap } from "lucide-react";
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

interface CalibrationBucket {
  tier: string;
  n: number;
  wins: number;
  losses: number;
  raw_hit_rate: number | null;
  shrunk_hit_rate: number | null;
  avg_score: number | null;
  avg_clv_pp: number | null;
  maturity: string;
}

interface CalibrationResponse {
  ok: boolean;
  error?: string;
  calibration?: {
    model_version: string;
    generated_at: string;
    source: string;
    sample: { n: number; wins: number; losses: number; hit_rate: number | null; maturity: string };
    buckets: CalibrationBucket[];
    warnings: string[];
  };
}

function pct(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—";
}

function pp(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(1)}pp` : "—";
}

function maturityColor(maturity: string | null | undefined): string {
  if (maturity === "validated") return "#3ee68a";
  if (maturity === "provisional") return "#f5c062";
  return "#ef4444";
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
  const [calibration, setCalibration] = useState<CalibrationResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  async function load() {
    setRefreshing(true);
    try {
      const [resultsRes, overviewRes, quotaRes, calibrationRes] = await Promise.all([
        fetch("/api/ops/results", { cache: "no-store" }),
        fetch("/api/ops/overview", { cache: "no-store" }),
        fetch("/api/ops/odds-quota", { cache: "no-store" }),
        fetch("/api/ops/confidence-calibration", { cache: "no-store" }),
      ]);
      setResults((await resultsRes.json()) as ResultsResponse);
      setOverview((await overviewRes.json()) as OverviewResponse);
      setQuota((await quotaRes.json()) as QuotaResponse);
      setCalibration((await calibrationRes.json()) as CalibrationResponse);
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
        <SectionHead
          icon={BarChart3}
          title="Confidence calibration"
          right={<Tag label={calibration?.calibration?.sample.maturity ?? (calibration?.ok ? "unknown" : "unavailable")} color={maturityColor(calibration?.calibration?.sample.maturity)} />}
        />
        <p className="mb-4 max-w-[760px] text-[12px] leading-relaxed text-[#9ca39a]">
          This is the current Low / Medium / High confidence model. It is built from graded paper outcomes and NBA model prediction history, then used by the canonical tracking ledger when edge data exists.
        </p>
        {calibration?.ok && calibration.calibration ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
              <KpiCard label="Samples" value={String(calibration.calibration.sample.n)} sub={calibration.calibration.source} />
              <KpiCard label="Record" value={`${calibration.calibration.sample.wins}W-${calibration.calibration.sample.losses}L`} />
              <KpiCard label="Hit rate" value={pct(calibration.calibration.sample.hit_rate)} />
              <KpiCard label="Version" value={calibration.calibration.model_version.replace("ace_confidence_calibration_", "")} sub="tier model" />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[10px] font-mono">
                <thead className="border-b border-[#22251f] text-[#6b7068] uppercase tracking-[0.12em]">
                  <tr>
                    <th className="px-2 py-2 font-semibold">Tier</th>
                    <th className="px-2 py-2 font-semibold text-right">Samples</th>
                    <th className="px-2 py-2 font-semibold text-right">Record</th>
                    <th className="px-2 py-2 font-semibold text-right">Raw hit</th>
                    <th className="px-2 py-2 font-semibold text-right">Shrunk hit</th>
                    <th className="px-2 py-2 font-semibold text-right">Avg score</th>
                    <th className="px-2 py-2 font-semibold text-right">Avg CLV</th>
                    <th className="px-2 py-2 font-semibold">Maturity</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#181c18]">
                  {calibration.calibration.buckets.map((bucket) => (
                    <tr key={bucket.tier} className="text-[#c4c7c0]">
                      <td className="px-2 py-2 text-white capitalize">{bucket.tier}</td>
                      <td className="px-2 py-2 text-right">{bucket.n}</td>
                      <td className="px-2 py-2 text-right">{bucket.wins}W-{bucket.losses}L</td>
                      <td className="px-2 py-2 text-right">{pct(bucket.raw_hit_rate)}</td>
                      <td className="px-2 py-2 text-right">{pct(bucket.shrunk_hit_rate)}</td>
                      <td className="px-2 py-2 text-right">{pp(bucket.avg_score)}</td>
                      <td className="px-2 py-2 text-right">{pp(bucket.avg_clv_pp)}</td>
                      <td className="px-2 py-2"><Tag label={bucket.maturity} color={maturityColor(bucket.maturity)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {calibration.calibration.warnings.length > 0 && (
              <div className="rounded-xl border border-[#3a2f16] bg-[#171309] px-4 py-3 text-[11px] leading-relaxed text-[#f5c062]">
                {calibration.calibration.warnings[0]}
              </div>
            )}
          </div>
        ) : (
          <EmptyState>{calibration?.error ?? "Confidence calibration is not available yet."}</EmptyState>
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
