"use client";

import { useEffect, useState } from "react";
import { Activity, CheckCircle2, Database, Play, RefreshCw, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

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

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-[#22251f] bg-[#0d0f0d] px-4 py-3">
      <p className="text-[9px] text-[#6b7068] uppercase tracking-[0.15em] mb-1.5">{label}</p>
      <p className="text-[18px] font-bold text-white font-mono tabular-nums">{value}</p>
      {sub && <p className="text-[10px] text-[#6b7068] mt-0.5">{sub}</p>}
    </div>
  );
}

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
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <p className="text-[10px] font-bold text-[#3ee68a] uppercase tracking-[0.18em] mb-1">
              ⚾ MLB
            </p>
            <h1 className="text-[20px] font-bold text-white">Signal Pipeline</h1>
          </div>
          <div className="flex items-center gap-2">
            {lastJobResult && (
              <span className="flex items-center gap-1 text-[10px] text-[#9ca39a]">
                <CheckCircle2 className={cn("h-3 w-3", lastJobResult.ok ? "text-[#3ee68a]" : "text-[#ef4444]")} />
                {lastJobResult.job} · {lastJobResult.ok ? "ok" : "failed"} · {lastJobResult.at}
              </span>
            )}
            <button
              onClick={() => void runJob("fetch")}
              disabled={running !== null}
              className={cn(
                "flex items-center gap-1.5 text-[10px] uppercase tracking-[0.15em] font-bold",
                "px-3 py-2 rounded-lg border border-[#3ee68a]/20 bg-[#3ee68a]/[0.05]",
                "text-[#3ee68a] hover:bg-[#3ee68a]/10 hover:border-[#3ee68a]/40",
                "transition-colors disabled:opacity-50",
              )}
            >
              <Play className={cn("h-3 w-3", running === "fetch" && "animate-pulse")} />
              {running === "fetch" ? "Scanning..." : "Scan now"}
            </button>
            <button
              onClick={() => void runJob("grade")}
              disabled={running !== null}
              className={cn(
                "flex items-center gap-1.5 text-[10px] uppercase tracking-[0.15em] font-bold",
                "px-3 py-2 rounded-lg border border-[#22251f] bg-[#0d0f0d]",
                "text-[#9ca39a] hover:text-white hover:border-[#3ee68a]/30",
                "transition-colors disabled:opacity-50",
              )}
            >
              <CheckCircle2 className={cn("h-3 w-3", running === "grade" && "animate-pulse")} />
              {running === "grade" ? "Grading..." : "Grade now"}
            </button>
            <button
              onClick={() => void load(false)}
              disabled={refreshing || running !== null}
              className={cn(
                "flex items-center gap-1.5 text-[10px] uppercase tracking-[0.15em] font-bold",
                "px-3 py-2 rounded-lg border border-[#22251f] bg-[#0d0f0d]",
                "text-[#9ca39a] hover:text-white hover:border-[#3ee68a]/30",
                "transition-colors",
                refreshing && "opacity-50",
              )}
            >
              <RefreshCw className={cn("h-3 w-3", refreshing && "animate-spin")} />
              Refresh
            </button>
          </div>
        </div>

        {/* Worker & Job health */}
        <div className="grid grid-cols-3 gap-3">
          <StatCard
            label="Worker"
            value={worker.lastPollOk === null ? "—" : worker.lastPollOk ? "OK" : "Error"}
            sub={worker.lastPollAt ?? "no polls yet"}
          />
          <StatCard
            label="Fetch job"
            value={jobs.fetch.lastRunAt ? "ran" : "—"}
            sub={jobs.fetch.lastError || jobs.fetch.lastRunAt || "no runs yet"}
          />
          <StatCard
            label="Grade job"
            value={jobs.grade.lastRunAt ? "ran" : "—"}
            sub={jobs.grade.lastError || jobs.grade.lastRunAt || "no runs yet"}
          />
        </div>

        {/* Performance summary */}
        <div className="grid grid-cols-4 gap-3">
          <StatCard label="Total" value={String(stats.total)} sub="signals fired" />
          <StatCard label="Open"  value={String(stats.open)}  sub="awaiting grade" />
          <StatCard label="Win rate" value={fmtPct(stats.winRate)} sub={`${stats.wins}W / ${stats.losses}L`} />
          <StatCard label="ROI" value={fmtRoi(stats.roi)} sub={`${stats.graded} graded`} />
        </div>

        {/* Per-market breakdown */}
        <div className="rounded-lg border border-[#22251f] bg-[#0d0f0d] p-5">
          <p className="text-[10px] font-bold text-[#3ee68a] uppercase tracking-[0.15em] mb-3 flex items-center gap-1.5">
            <Database className="h-3 w-3" />
            By market
          </p>
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
        </div>

        {/* Recent signals */}
        <div className="rounded-lg border border-[#22251f] bg-[#0d0f0d] p-5">
          <p className="text-[10px] font-bold text-[#3ee68a] uppercase tracking-[0.15em] mb-3 flex items-center gap-1.5">
            <Activity className="h-3 w-3" />
            Recent signals · {signals.length}
          </p>
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
                        <span className={cn(
                          "inline-block px-1.5 py-[1px] rounded text-[8px] font-bold",
                          s.confidence_tier === "A" && "bg-[#3ee68a]/20 text-[#3ee68a]",
                          s.confidence_tier === "B" && "bg-[#f5c062]/15 text-[#f5c062]",
                          s.confidence_tier === "C" && "bg-[#6b7068]/15 text-[#6b7068]",
                        )}>{s.confidence_tier ?? "—"}</span>
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
                        {s.status === "graded" && s.correct === 1 && (
                          <span className="text-[#3ee68a]">WIN</span>
                        )}
                        {s.status === "graded" && s.correct === 0 && (
                          <span className="text-[#ef4444]">LOSS</span>
                        )}
                        {s.status === "open" && <span className="text-[#9ca39a]">open</span>}
                        {s.status === "void" && <span className="text-[#6b7068]">void</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Schema state */}
        <div className="flex items-center justify-between text-[9px] text-[#6b7068] uppercase tracking-[0.15em]">
          <span className="flex items-center gap-1.5">
            <Zap className="h-3 w-3 text-[#3ee68a]/60" />
            Schema migrated · {schema.migrationRunAt ?? "not yet"}
          </span>
          <span>refreshed · {new Date(data.refreshedAt).toLocaleTimeString()}</span>
        </div>
      </div>
    </div>
  );
}
