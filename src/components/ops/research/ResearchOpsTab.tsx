"use client";

import { useEffect, useState } from "react";
import { FlaskConical, RefreshCw } from "lucide-react";
import { ActionButton, EmptyState, KpiCard, LoadingState, OpsFooter, OpsPageHeader, Panel, SectionHead, Tag } from "@/components/ops/shared/primitives";
import { formatEtDateTime } from "@/lib/time-format";
import { fmtPp, fmtSport, marketLabel } from "@/components/ops/shared/ledger";

interface SoccerCandidate {
  id: number;
  tournament: string;
  game_date: string;
  home_team: string;
  away_team: string;
  commence_time: string | null;
  market: string;
  bet_side: string;
  total_line: number | null;
  model_prob: number;
  book_prob: number;
  book_odds: number;
  book: string;
  edge_pp: number;
  confidence_tier: "A" | "B" | "C";
  status: string;
  home_score: number | null;
  away_score: number | null;
  result: string | null;
  correct: number | null;
  detected_at: string;
}

interface SoccerResponse {
  candidates: SoccerCandidate[];
  candidateStats?: {
    total: number;
    by_status: Record<string, number>;
    top_edge_pp: number | null;
    record?: { graded: number; wins: number; losses: number; win_rate: number | null };
  };
  refreshedAt: string;
}

function pct(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function candidatePick(row: SoccerCandidate): string {
  const side = row.bet_side.toUpperCase();
  if (row.market === "totals") return `${side}${row.total_line != null ? ` ${row.total_line}` : ""}`;
  return side;
}

export default function ResearchOpsTab() {
  const [data, setData] = useState<SoccerResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  async function load() {
    setRefreshing(true);
    try {
      const res = await fetch("/api/ops/soccer", { cache: "no-store" });
      setData((await res.json()) as SoccerResponse);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (loading) return <LoadingState label="Loading research…" />;

  const stats = data?.candidateStats;
  const record = stats?.record;
  const candidates = data?.candidates ?? [];

  return (
    <div className="mx-auto max-w-[1200px] space-y-5 px-6 py-7">
      <OpsPageHeader
        icon={FlaskConical}
        title="Research"
        tag="model validation"
        tagColor="#f5c062"
        actions={<ActionButton icon={RefreshCw} variant="subtle" busy={refreshing} disabled={refreshing} onClick={() => void load()} />}
      />

      <Panel>
        <SectionHead icon={FlaskConical} title="What belongs here" right={<Tag label="not Results" color="#f5c062" />} />
        <p className="max-w-[780px] text-[12px] leading-relaxed text-[#9ca39a]">
          This surface is for candidates, backtests, calibration, and model validation. These rows can teach ACE, but they are not counted as tracked betting results unless they were intentionally promoted into paper tracking.
        </p>
      </Panel>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-[1.2fr_1fr_1fr_1fr]">
        <KpiCard label="Candidate rows" value={String(stats?.total ?? 0)} />
        <KpiCard label="Graded validation" value={String(record?.graded ?? 0)} />
        <KpiCard label="Validation record" value={record ? `${record.wins}W-${record.losses}L` : "—"} />
        <KpiCard label="Win rate" value={pct(record?.win_rate)} color={(record?.win_rate ?? 0) >= 0.524 ? "#3ee68a" : "#ef4444"} />
      </div>

      <Panel>
        <SectionHead icon={FlaskConical} title="Soccer candidate validation" right={<span className="text-[10px] text-[#6b7068]">sample from research table</span>} />
        {candidates.length === 0 ? (
          <EmptyState>No candidate rows available. Research data will appear here after candidate jobs run.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[10px] font-mono">
              <thead className="border-b border-[#22251f] text-[#6b7068] uppercase tracking-[0.12em]">
                <tr>
                  <th className="px-2 py-2 font-semibold">Sport</th>
                  <th className="px-2 py-2 font-semibold">Match</th>
                  <th className="px-2 py-2 font-semibold">Candidate</th>
                  <th className="px-2 py-2 font-semibold">Book</th>
                  <th className="px-2 py-2 font-semibold text-right">Edge</th>
                  <th className="px-2 py-2 font-semibold text-center">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#181c18]">
                {candidates.slice(0, 24).map((row) => (
                  <tr key={row.id} className="text-[#c4c7c0]">
                    <td className="px-2 py-2 text-[#9ca39a]">{fmtSport("soccer")}</td>
                    <td className="px-2 py-2">
                      <p className="max-w-[260px] truncate text-white">{row.away_team} @ {row.home_team}</p>
                      <p className="text-[9px] text-[#4a524a]">{row.commence_time ? formatEtDateTime(row.commence_time) : row.game_date}</p>
                    </td>
                    <td className="px-2 py-2">
                      <p className="text-white">{candidatePick(row)}</p>
                      <p className="text-[9px] text-[#6b7068]">{marketLabel(row.market)}</p>
                    </td>
                    <td className="px-2 py-2 text-[#9ca39a]">{row.book}</td>
                    <td className="px-2 py-2 text-right font-bold text-[#3ee68a]">{fmtPp(row.edge_pp)}</td>
                    <td className="px-2 py-2 text-center"><Tag label={row.status} color={row.status === "graded" ? "#9ca39a" : "#f5c062"} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <OpsFooter refreshedAt={data?.refreshedAt ?? new Date().toISOString()} schemaText="Research · candidates and validation" />
    </div>
  );
}
