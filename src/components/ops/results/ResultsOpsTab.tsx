"use client";

import { useEffect, useMemo, useState } from "react";
import { BarChart2, RefreshCw, AlertTriangle } from "lucide-react";
import { ActionButton, EmptyState, KpiCard, LoadingState, OpsFooter, OpsPageHeader, Panel, SectionHead, Tag } from "@/components/ops/shared/primitives";
import { formatEtDateTime } from "@/lib/time-format";
import { fmtOdds, fmtPp, fmtSport, fmtUnits, marketLabel, resultColor, resultLabel, rowMatchesSearch, rowMatchesSport, sideLabel, type ResultsSummaryRow, type SportFilter, type TrackedPickRow } from "@/components/ops/shared/ledger";
import OpsFilters from "@/components/ops/shared/Filters";

interface ResultsResponse {
  source: "tracked_picks";
  available: boolean;
  message?: string;
  summary: ResultsSummaryRow[];
  picks: TrackedPickRow[];
  refreshedAt: string;
}

function ResultTable({ rows }: { rows: TrackedPickRow[] }) {
  if (rows.length === 0) return <EmptyState>No graded paper-tracked picks yet.</EmptyState>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[10px] font-mono">
        <thead className="border-b border-[#22251f] text-[#6b7068] uppercase tracking-[0.12em]">
          <tr>
            <th className="px-2 py-2 font-semibold">Sport</th>
            <th className="px-2 py-2 font-semibold">Game</th>
            <th className="px-2 py-2 font-semibold">Pick</th>
            <th className="px-2 py-2 font-semibold">Book</th>
            <th className="px-2 py-2 font-semibold text-right">Edge</th>
            <th className="px-2 py-2 font-semibold text-right">CLV</th>
            <th className="px-2 py-2 font-semibold text-right">P&L</th>
            <th className="px-2 py-2 font-semibold text-center">Result</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#181c18]">
          {rows.map((row) => (
            <tr key={`${row.source_table}-${row.source_id}`} className="text-[#c4c7c0]">
              <td className="px-2 py-2 text-[#9ca39a]">{fmtSport(row.sport)}</td>
              <td className="px-2 py-2">
                <p className="max-w-[260px] truncate text-white">{row.matchup_label ?? "Matchup TBD"}</p>
                <p className="text-[9px] text-[#4a524a]">{row.commence_time ? formatEtDateTime(row.commence_time) : row.game_date ?? "—"}</p>
              </td>
              <td className="px-2 py-2">
                <p className="text-white">{sideLabel(row)}</p>
                <p className="text-[9px] text-[#6b7068]">{marketLabel(row.market)}</p>
              </td>
              <td className="px-2 py-2 text-[#9ca39a]">{row.book ?? "—"} {fmtOdds(row.odds_american)}</td>
              <td className="px-2 py-2 text-right font-bold text-[#3ee68a]">{fmtPp(row.edge_pp)}</td>
              <td className="px-2 py-2 text-right text-[#9ca39a]">{row.clv_pp != null ? fmtPp(row.clv_pp) : row.clv_points != null ? String(row.clv_points) : "—"}</td>
              <td className="px-2 py-2 text-right text-[#9ca39a]">{fmtUnits(row.pnl_units)}</td>
              <td className="px-2 py-2 text-center"><Tag label={resultLabel(row.result)} color={resultColor(row.result)} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ResultsOpsTab() {
  const [data, setData] = useState<ResultsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sportFilter, setSportFilter] = useState<SportFilter>("all");
  const [query, setQuery] = useState("");

  async function load() {
    setRefreshing(true);
    try {
      const res = await fetch("/api/ops/results", { cache: "no-store" });
      setData((await res.json()) as ResultsResponse);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const filteredPicks = useMemo(() => (data?.picks ?? []).filter((row) => rowMatchesSport(row, sportFilter) && rowMatchesSearch(row, query)), [data, sportFilter, query]);

  const totals = useMemo(() => {
    const summary = data?.summary ?? [];
    const graded = summary.reduce((sum, row) => sum + (row.graded ?? 0), 0);
    const wins = summary.reduce((sum, row) => sum + (row.wins ?? 0), 0);
    const losses = summary.reduce((sum, row) => sum + (row.losses ?? 0), 0);
    const pnl = summary.reduce((sum, row) => sum + (row.pnl_units ?? 0), 0);
    return { graded, wins, losses, pnl, winRate: wins + losses > 0 ? wins / (wins + losses) : null };
  }, [data]);

  if (loading) return <LoadingState label="Loading results…" />;

  return (
    <div className="mx-auto max-w-[1200px] space-y-5 px-6 py-7">
      <OpsPageHeader
        icon={BarChart2}
        title="Results"
        tag="graded paper picks"
        tagColor="#3ee68a"
        actions={<ActionButton icon={RefreshCw} variant="subtle" busy={refreshing} disabled={refreshing} onClick={() => void load()} />}
      />

      {!data?.available && (
        <Panel>
          <SectionHead icon={AlertTriangle} title="Ledger unavailable" />
          <p className="text-[12px] text-[#9ca39a]">{data?.message ?? "Canonical tracked-picks ledger has not been imported yet."}</p>
        </Panel>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-[1.2fr_1fr_1fr_1fr]">
        <KpiCard label="Graded" value={String(totals.graded)} />
        <KpiCard label="Record" value={`${totals.wins}W-${totals.losses}L`} />
        <KpiCard label="Win rate" value={totals.winRate == null ? "—" : `${(totals.winRate * 100).toFixed(1)}%`} />
        <KpiCard label="Paper P&L" value={fmtUnits(totals.pnl)} color={totals.pnl >= 0 ? "#3ee68a" : "#ef4444"} />
      </div>

      <Panel>
        <SectionHead icon={BarChart2} title="Sport records" />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {(data?.summary ?? []).map((row) => {
            const winRate = row.wins + row.losses > 0 ? row.wins / (row.wins + row.losses) : null;
            return (
              <div key={row.sport} className="rounded-xl border border-[#1a1e1a] bg-[#0a0b0a] p-4">
                <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#6b7068]">{fmtSport(row.sport)}</p>
                <p className="mt-3 font-mono text-[22px] font-black text-white">{row.wins}W-{row.losses}L</p>
                <p className="mt-1 text-[10px] text-[#6b7068]">{row.graded} graded · {winRate == null ? "—" : `${(winRate * 100).toFixed(1)}%`} · {fmtUnits(row.pnl_units)}</p>
              </div>
            );
          })}
        </div>
      </Panel>

      <Panel>
        <SectionHead icon={BarChart2} title="Graded tracked picks" right={<span className="text-[10px] text-[#6b7068]">{filteredPicks.length} rows</span>} />
        <div className="mb-4">
          <OpsFilters
            sport={sportFilter}
            onSportChange={setSportFilter}
            query={query}
            onQueryChange={setQuery}
            resultCount={filteredPicks.length}
            totalCount={data?.picks.length ?? 0}
          />
        </div>
        <ResultTable rows={filteredPicks} />
      </Panel>

      <OpsFooter refreshedAt={data?.refreshedAt ?? new Date().toISOString()} schemaText="tracked_picks · Results" />
    </div>
  );
}
