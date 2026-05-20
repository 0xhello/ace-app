"use client";

import { useEffect, useState } from "react";
import { Activity, CheckCircle2, Database, Play, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  KpiCard,
  SectionHead,
  Panel,
  ActionButton,
  JobHealthStrip,
  OpsPageHeader,
  StatusPill,
  OpsFooter,
} from "@/components/ops/shared/primitives";

interface MLBSignal {
  id: number;
  game_id: string;
  game_date: string;
  home_team: string;
  away_team: string;
  market: string;
  bet_side: string;
  line: number | null;
  pinnacle_prob: number | null;
  book: string;
  book_prob: number | null;
  book_odds: number | null;
  edge_pp: number | null;
  status: string;
  correct: number | null;
  result: string | null;
  detected_at: string;
  confidence_tier: "A" | "B" | "C" | null;
  kelly_fraction: number | null;
  closing_pinnacle_prob: number | null;
  clv_pp: number | null;
}

interface MLBResponse {
  worker: { lastPollAt: string | null; lastPollOk: boolean | null };
  jobs: {
    fetch: { lastRunAt: string | null; lastError: string | null };
    grade: { lastRunAt: string | null; lastError: string | null };
  };
  signals: MLBSignal[];
  stats: {
    total: number;
    open: number;
    graded: number;
    wins: number;
    losses: number;
    winRate: number | null;
    roi: number | null;
    h2h:      { graded: number; wins: number };
    run_line: { graded: number; wins: number };
    totals:   { graded: number; wins: number };
  };
  schema: { hasPickFields: boolean | null; migrationRunAt: string | null };
  refreshedAt: string;
  error?: string;
}

function fmtPct(v: number | null): string {
  if (v === null || v === undefined) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

function fmtRoi(v: number | null): string {
  if (v === null || v === undefined) return "—";
  return `${v > 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;
}

// StatCard removed — now uses shared KpiCard from ops/shared/primitives so
// MLB / Soccer / Overview all render KPI cards identically.

export default function MLBOpsTab() {
  const [data, setData] = useState<MLBResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [running, setRunning] = useState<null | "fetch" | "grade">(null);
  const [lastJobResult, setLastJobResult] = useState<{ job: string; ok: boolean; at: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load(silent = false) {
    if (!silent) setRefreshing(true);
    try {
      const res = await fetch("/api/ops/mlb", { cache: "no-store" });
      const json = (await res.json()) as MLBResponse;
      setData(json);
      setError(json.error ?? null);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setLoading(false);
      if (!silent) setRefreshing(false);
    }
  }

  async function runJob(job: "fetch" | "grade") {
    setRunning(job);
    try {
      const apiJob = job === "fetch" ? "fetch_signals" : "grade_results";
      const res = await fetch("/api/ops/mlb", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job: apiJob }),
      });
      const json = await res.json() as { ok: boolean };
      setLastJobResult({ job, ok: !!json.ok, at: new Date().toLocaleTimeString() });
    } catch {
      setLastJobResult({ job, ok: false, at: new Date().toLocaleTimeString() });
    } finally {
      await load(true);
      setRunning(null);
    }
  }

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(true), 30_000);
    return () => clearInterval(id);
  }, []);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-[12px] text-[#6b7068]">
        Loading MLB ops…
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-1 items-center justify-center text-[12px] text-[#ef4444]">
        Failed to load: {error}
      </div>
    );
  }

  const { worker, jobs, signals, stats, schema } = data;
  const recent = signals.slice(0, 20);

  return (
    <div className="flex-1 overflow-y-auto bg-[#0a0b0a] px-6 py-5">
      <div className="mx-auto max-w-[1200px] space-y-5">

        {/* Header */}
        <OpsPageHeader
          badge="⚾ MLB"
          title="Signal Pipeline"
          actions={
            <>
              {lastJobResult && (
                <span className="flex items-center gap-1 text-[10px] text-[#9ca39a]">
                  <CheckCircle2 className={cn("h-3 w-3", lastJobResult.ok ? "text-[#3ee68a]" : "text-[#ef4444]")} />
                  {lastJobResult.job} · {lastJobResult.ok ? "ok" : "failed"} · {lastJobResult.at}
                </span>
              )}
              <ActionButton
                icon={Play}
                label={running === "fetch" ? "Scanning..." : "Scan now"}
                variant="primary"
                busy={running === "fetch"}
                disabled={running !== null}
                onClick={() => void runJob("fetch")}
              />
              <ActionButton
                icon={CheckCircle2}
                label={running === "grade" ? "Grading..." : "Grade now"}
                busy={running === "grade"}
                disabled={running !== null}
                onClick={() => void runJob("grade")}
              />
              <ActionButton
                icon={RefreshCw}
                label="Refresh"
                busy={refreshing}
                disabled={refreshing || running !== null}
                onClick={() => void load(false)}
              />
            </>
          }
        />

        {/* Worker & Job health */}
        <JobHealthStrip worker={worker} fetch={jobs.fetch} grade={jobs.grade} />

        {/* Performance summary */}
        <div className="grid grid-cols-4 gap-3">
          <KpiCard label="Total" value={String(stats.total)} sub="signals fired" />
          <KpiCard label="Open"  value={String(stats.open)}  sub="awaiting grade" />
          <KpiCard label="Win rate" value={fmtPct(stats.winRate)} sub={`${stats.wins}W / ${stats.losses}L`} />
          <KpiCard label="ROI" value={fmtRoi(stats.roi)} sub={`${stats.graded} graded`} />
        </div>

        {/* Per-market breakdown */}
        <Panel>
          <SectionHead icon={Database} title="By market" />
          <div className="grid grid-cols-3 gap-3 text-[11px]">
            {(["h2h", "run_line", "totals"] as const).map((m) => {
              const row = stats[m];
              const wr = row.graded > 0 ? row.wins / row.graded : null;
              return (
                <div key={m} className="rounded border border-[#1a1e1a] bg-[#0a0b0a] px-3 py-2">
                  <p className="text-[9px] text-[#6b7068] uppercase tracking-[0.15em]">{m.replace("_", " ")}</p>
                  <p className="text-[14px] font-bold text-white font-mono mt-1">
                    {row.wins} / {row.graded}
                  </p>
                  <p className="text-[9px] text-[#6b7068] mt-0.5">
                    {wr === null ? "no graded yet" : fmtPct(wr)}
                  </p>
                </div>
              );
            })}
          </div>
        </Panel>

        {/* Recent signals */}
        <Panel>
          <SectionHead icon={Activity} title={`Recent signals · ${signals.length}`} />
          {recent.length === 0 ? (
            <p className="text-[11px] text-[#6b7068] text-center py-6">
              No signals yet. Worker will populate this once MLB games are live.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[10px]">
                <thead className="text-[#6b7068] uppercase tracking-[0.12em] border-b border-[#22251f]">
                  <tr>
                    <th className="py-2 px-2 font-semibold">Date</th>
                    <th className="py-2 px-2 font-semibold">Matchup</th>
                    <th className="py-2 px-2 font-semibold">Pick</th>
                    <th className="py-2 px-2 font-semibold text-right">Line</th>
                    <th className="py-2 px-2 font-semibold text-right">Book / Odds</th>
                    <th className="py-2 px-2 font-semibold text-right">Edge</th>
                    <th className="py-2 px-2 font-semibold text-center">Tier</th>
                    <th className="py-2 px-2 font-semibold text-center">Kelly</th>
                    <th className="py-2 px-2 font-semibold text-right">CLV</th>
                    <th className="py-2 px-2 font-semibold text-center">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#181c18] font-mono">
                  {recent.map((s) => (
                    <tr key={s.id} className="text-[#c4c7c0]">
                      <td className="py-2 px-2 text-[#9ca39a]">{s.game_date}</td>
                      <td className="py-2 px-2 truncate max-w-[180px]">
                        {s.away_team} @ {s.home_team}
                      </td>
                      <td className="py-2 px-2 text-white">
                        {s.market}/{s.bet_side.toUpperCase()}
                      </td>
                      <td className="py-2 px-2 text-right text-[#9ca39a]">
                        {s.line !== null ? (s.market === "totals" ? s.line.toFixed(1) : (s.line > 0 ? `+${s.line}` : s.line)) : "—"}
                      </td>
                      <td className="py-2 px-2 text-right">
                        <span className="text-[#9ca39a]">{s.book}</span>{" "}
                        <span className="text-white">{s.book_odds! > 0 ? `+${s.book_odds}` : s.book_odds}</span>
                      </td>
                      <td className="py-2 px-2 text-right text-[#3ee68a]">
                        {s.edge_pp !== null ? `${(s.edge_pp * 100).toFixed(1)}pp` : "—"}
                      </td>
                      <td className="py-2 px-2 text-center">
                        {s.confidence_tier === "A" && <StatusPill label="A" tone="a" />}
                        {s.confidence_tier === "B" && <StatusPill label="B" tone="b" />}
                        {s.confidence_tier === "C" && <StatusPill label="C" tone="c" />}
                        {!s.confidence_tier && <span className="text-[#3a4033]">—</span>}
                      </td>
                      <td className="py-2 px-2 text-center text-[#9ca39a]">
                        {s.kelly_fraction !== null ? `${(s.kelly_fraction * 100).toFixed(1)}%` : "—"}
                      </td>
                      <td className={cn(
                        "py-2 px-2 text-right",
                        s.clv_pp === null ? "text-[#3a4033]"
                          : s.clv_pp > 0 ? "text-[#3ee68a]" : "text-[#ef4444]",
                      )}>
                        {s.clv_pp !== null ? `${s.clv_pp > 0 ? "+" : ""}${(s.clv_pp * 100).toFixed(1)}pp` : "—"}
                      </td>
                      <td className="py-2 px-2 text-center">
                        {s.status === "graded" && s.correct === 1 && <StatusPill label="WIN"  tone="win"  />}
                        {s.status === "graded" && s.correct === 0 && <StatusPill label="LOSS" tone="loss" />}
                        {s.status === "open"  && <StatusPill label="OPEN" tone="open" />}
                        {s.status === "void"  && <StatusPill label="VOID" tone="void" />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {/* Schema state */}
        <OpsFooter
          refreshedAt={data.refreshedAt}
          schemaText={`Schema migrated · ${schema.migrationRunAt ?? "not yet"}`}
        />
      </div>
    </div>
  );
}
