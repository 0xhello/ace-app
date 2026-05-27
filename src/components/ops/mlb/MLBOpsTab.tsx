"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Database, Play, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  KpiCard,
  SectionHead,
  Panel,
  ActionButton,
  WorkerStatusStrip,
  OpsPageHeader,
  OpsFooter,
  LoadingState,
  EngineInternals,
} from "@/components/ops/shared/primitives";
import {
  TodaySlatePanel,
  OpenSignalsPanel,
  CLVStatsPanel,
  ByBookPanel,
  StaleSignalsPanel,
  ActivityStreamPanel,
} from "@/components/ops/shared/panels";
import { Trophy } from "lucide-react";

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

  if (loading) return <LoadingState label="Loading MLB ops…" />;

  if (!data) {
    return (
      <div className="flex flex-1 items-center justify-center text-[12px] text-[#ef4444]">
        Failed to load: {error}
      </div>
    );
  }

  const { worker, jobs, signals, stats, schema } = data;
  // Local ET-date string, used by panels that split by "today vs past".
  // Matches the convention the API routes use.
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  return (
    <div className="flex-1 overflow-y-auto bg-[#0a0b0a]">
      <div className="max-w-[1200px] mx-auto px-6 py-7 space-y-5">

        {/* Header — slim. Refresh is the only always-visible action; the
            worker runs Grade + Scan on schedule so they live inside Engine
            internals for the rare manual override. */}
        <OpsPageHeader
          icon={Trophy}
          title="MLB"
          tag="live"
          tagColor="#3ee68a"
          actions={
            <>
              {lastJobResult && (
                <span className="flex items-center gap-1 text-[10px] text-[#9ca39a]">
                  <CheckCircle2 className={cn("h-3 w-3", lastJobResult.ok ? "text-[#3ee68a]" : "text-[#ef4444]")} />
                  {lastJobResult.job} · {lastJobResult.ok ? "ok" : "failed"} · {lastJobResult.at}
                </span>
              )}
              <ActionButton
                icon={RefreshCw}
                variant="subtle"
                busy={refreshing}
                disabled={refreshing || running !== null}
                onClick={() => void load(false)}
              />
            </>
          }
        />

        {/* Headline metrics — three numbers a human actually scans for */}
        <div className="flex gap-3 flex-wrap">
          <KpiCard
            label="Track record"
            value={stats.graded > 0 ? `${stats.wins}–${stats.losses}` : "—"}
            sub={stats.graded > 0 ? `${stats.graded} graded · ${fmtPct(stats.winRate)} win rate` : "no graded picks yet"}
            color={stats.winRate !== null && stats.winRate >= 0.524 ? "#3ee68a" : "#d4d7d0"}
          />
          <KpiCard
            label="ROI"
            value={fmtRoi(stats.roi)}
            sub="vs market closing prices"
            color={stats.roi !== null ? (stats.roi >= 0 ? "#3ee68a" : "#ef4444") : "#6b7068"}
          />
          <KpiCard
            label="Open signals"
            value={String(stats.open)}
            sub="awaiting kickoff"
            color={stats.open > 0 ? "#f5c062" : "#6b7068"}
          />
        </div>

        {/* Today's slate + open signals — the only two panels a bettor actually
            scans before deciding what to play. CLV stats live alongside since
            it's the headline "are we beating closing line" measure. */}
        <TodaySlatePanel signals={signals} today={today} />
        <OpenSignalsPanel signals={signals} today={today} />
        <CLVStatsPanel signals={signals} />

        {/* ══ ENGINE INTERNALS — collapsed by default ═════════════════════════
            Manual triggers, per-market breakdown, by-book divergences, stale
            signals, activity stream. All useful when debugging, all noise
            when looking for plays. */}
        <EngineInternals subtitle="raw metrics, manual job triggers, per-market & by-book detail">
          <WorkerStatusStrip worker={worker} fetch={jobs.fetch} grade={jobs.grade} />

          <div className="flex flex-wrap gap-2">
            <ActionButton
              icon={Play}
              label={running === "fetch" ? "Scanning…" : "Scan odds"}
              variant="primary"
              busy={running === "fetch"}
              disabled={running !== null}
              onClick={() => void runJob("fetch")}
            />
            <ActionButton
              icon={CheckCircle2}
              label={running === "grade" ? "Grading…" : "Grade signals"}
              busy={running === "grade"}
              disabled={running !== null}
              onClick={() => void runJob("grade")}
            />
          </div>

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

          <ByBookPanel signals={signals} />
          <StaleSignalsPanel signals={signals} today={today} />
          <ActivityStreamPanel signals={signals} />

          <OpsFooter
            refreshedAt={data.refreshedAt}
            schemaText={`Schema migrated · ${schema.migrationRunAt ?? "not yet"}`}
          />
        </EngineInternals>
      </div>
    </div>
  );
}
