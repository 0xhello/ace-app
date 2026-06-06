"use client";

import { useEffect, useState } from "react";
import { Clock, RefreshCw, AlertTriangle } from "lucide-react";
import { ActionButton, EmptyState, KpiCard, LoadingState, OpsFooter, OpsPageHeader, Panel, SectionHead, Tag } from "@/components/ops/shared/primitives";
import { formatEtDateTime } from "@/lib/time-format";
import { fmtOdds, fmtPp, fmtSport, marketLabel, sideLabel, type TrackedPickRow } from "@/components/ops/shared/ledger";

interface TodayResponse {
  source: "tracked_picks";
  available: boolean;
  message?: string;
  open: TrackedPickRow[];
  awaitingGrade: TrackedPickRow[];
  refreshedAt: string;
}

function isStale(row: TrackedPickRow): boolean {
  if (!row.commence_time) return false;
  return new Date(row.commence_time).getTime() < Date.now();
}

function PickTable({ rows }: { rows: TrackedPickRow[] }) {
  if (rows.length === 0) {
    return <EmptyState>No open paper-tracked picks. Model picks will land here when they are tracked.</EmptyState>;
  }

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
            <th className="px-2 py-2 font-semibold">Time</th>
            <th className="px-2 py-2 font-semibold text-center">State</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#181c18]">
          {rows.map((row) => {
            const stale = isStale(row);
            return (
              <tr key={`${row.source_table}-${row.source_id}`} className="text-[#c4c7c0]">
                <td className="px-2 py-2 text-[#9ca39a]">{fmtSport(row.sport)}</td>
                <td className="px-2 py-2">
                  <p className="max-w-[260px] truncate text-white">{row.matchup_label ?? "Matchup TBD"}</p>
                  <p className="text-[9px] text-[#4a524a]">{row.league ?? row.tournament ?? "—"}</p>
                </td>
                <td className="px-2 py-2">
                  <p className="text-white">{sideLabel(row)}</p>
                  <p className="text-[9px] text-[#6b7068]">{marketLabel(row.market)}</p>
                </td>
                <td className="px-2 py-2 text-[#9ca39a]">{row.book ?? "—"} {fmtOdds(row.odds_american)}</td>
                <td className="px-2 py-2 text-right font-bold text-[#3ee68a]">{fmtPp(row.edge_pp)}</td>
                <td className="px-2 py-2 text-[#9ca39a]">{row.commence_time ? formatEtDateTime(row.commence_time) : "TBD"}</td>
                <td className="px-2 py-2 text-center">
                  <Tag label={stale ? "Needs grade" : "Open"} color={stale ? "#f5c062" : "#3ee68a"} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function TodayOpsTab() {
  const [data, setData] = useState<TodayResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  async function load() {
    setRefreshing(true);
    try {
      const res = await fetch("/api/ops/today", { cache: "no-store" });
      setData((await res.json()) as TodayResponse);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (loading) return <LoadingState label="Loading tracked picks…" />;

  const open = data?.open ?? [];
  const awaiting = data?.awaitingGrade ?? [];
  const upcoming = open.filter((row) => !isStale(row));

  return (
    <div className="mx-auto max-w-[1200px] space-y-5 px-6 py-7">
      <OpsPageHeader
        icon={Clock}
        title="Today"
        tag="paper tracking"
        tagColor="#3ee68a"
        actions={<ActionButton icon={RefreshCw} variant="subtle" busy={refreshing} disabled={refreshing} onClick={() => void load()} />}
      />

      {!data?.available && (
        <Panel>
          <SectionHead icon={AlertTriangle} title="Ledger unavailable" />
          <p className="text-[12px] text-[#9ca39a]">{data?.message ?? "Canonical tracked-picks ledger has not been imported yet."}</p>
        </Panel>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-[1.3fr_1fr_1fr]">
        <KpiCard label="Open tracked" value={String(open.length)} sub="paper picks awaiting result" />
        <KpiCard label="Upcoming" value={String(upcoming.length)} color="#3ee68a" />
        <KpiCard label="Needs grade" value={String(awaiting.length)} color={awaiting.length > 0 ? "#f5c062" : "#9ca39a"} />
      </div>

      <Panel>
        <SectionHead icon={Clock} title="Open paper-tracked picks" right={<span className="text-[10px] text-[#6b7068]">{open.length} rows</span>} />
        <PickTable rows={open} />
      </Panel>

      <OpsFooter refreshedAt={data?.refreshedAt ?? new Date().toISOString()} schemaText="tracked_picks · Today" />
    </div>
  );
}
