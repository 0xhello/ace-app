"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import {
  Activity, AlertTriangle, CheckCircle2, XCircle, Clock,
  Database, TrendingUp, Zap, RefreshCw, Terminal, Info, Brain,
  BookMarked, PlusCircle, Wifi,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface JobStatus {
  lastRunAt: string | null;
  quotaRemaining: number | null;
  hasError: boolean;
  errorSnippet: string | null;
  truncated: boolean;
}

interface Pick {
  date: string; home: string; away: string; line: number | null; side: string;
  conf: number | null; isBet: boolean; status: string; correct: number | null;
  edge: number | null; version: string;
}

interface SegStats { n: number; wins?: number; win_rate: number | null; avg_conf?: number; avg_edge?: number | null }
interface SegReport {
  sample_note: string;
  overall: SegStats;
  bets_only: SegStats;
  by_regime: Record<string, SegStats>;
  by_direction: Record<string, SegStats>;
  by_rest: Record<string, SegStats>;
  by_conf_tier: Record<string, SegStats>;
  by_edge_tier: Record<string, SegStats>;
  calibration: Array<{ conf_bucket: string; n: number; predicted_avg: number; actual_win_rate: number; delta: number }>;
  weak_spots: Array<{ segment: string; n: number; win_rate: number }>;
}
interface ArchetypeEntry {
  pace_tier: string; offense_style: string; defense_tier: string;
  ball_movement: string; clutch: string; home_skew: string;
  raw: { ortg: number | null; drtg: number | null; pace: number | null; fg3a_pct: number | null; net_rtg: number | null };
  pct_ranks: { offense: number | null; defense: number | null; pace: number | null };
}

interface WorkerStatus {
  lastPollAt: string | null;
  lastPollOk: boolean | null;
}

interface PipelineData {
  jobs: { state: JobStatus; grade: JobStatus; fetch: JobStatus };
  worker: WorkerStatus;
  latestQuota: number | null;
  picks: Pick[];
  model: {
    total: number; graded: number; pending: number; pushed: number;
    wins: number; losses: number; winRate: number | null; roi: number | null;
    betsTotal: number; betsGraded: number; betsWins: number; betsLosses: number;
    betsWinRate: number | null; betsRoi: number | null;
    pinnacleGraded: number; pinnacleWins: number; pinnacleWinRate: number | null;
    fallbackGraded: number; fallbackWins: number; fallbackWinRate: number | null;
    avgConf: number | null;
    buckets: Array<{ label: string; graded: number; wins: number; winRate: number | null }>;
    todayLogged: number;
  };
  segments: SegReport | null;
  archetypes: Record<string, ArchetypeEntry> | null;
  etToday: string;
  refreshedAt: string;
}

interface RecentSignal {
  id: number; game_date: string; home: string; away: string;
  side: string; line: number; clv: number | null; win: number | null;
  src: string | null;
}

interface BookDivergence {
  game_date: string; home: string; away: string;
  pinnacle_line: number; book: string; book_line: number;
  divergence: number; snapshot_label: string;
}

interface SignalsData {
  by_status: Record<string, number>;
  total: number;
  clv: { avg: number | null; median: number | null; pct_positive: number | null; n: number; wins: number; total_graded: number };
  pinnacle_close:     { clv: number | null; n: number };
  non_pinnacle_close: { clv: number | null; n: number };
  today: { signals: number; snapshots: number; games: Array<{ home: string; away: string }> };
  stale: Array<{ id: number; game_date: string; home_team: string; away_team: string }>;
  open_signals: Array<{ id: number; game_date: string; home_team: string; away_team: string; bet_side: string; line_at_signal: number; status: string; signal_type: string }>;
  recent_graded: RecentSignal[];
  book_lines: { total: number; game_days: number; divergences: BookDivergence[] };
  by_type: Record<string, { n: number; avg_clv: number | null; pct_pos: number | null; graded: number }>;
  et_today: string;
  edgeStatus: string;
  needFor30: number;
  error?: string;
}

interface Execution {
  id: number; signal_id: number; mode: "paper" | "real";
  book: string; signal_line: number; fill_line: number | null;
  bet_side: string; stake: number; outcome: 1 | 0 | null;
  pnl_units: number | null; notes: string; created_at: string;
  graded_at: string | null;
  home_team?: string; away_team?: string; game_date?: string; signal_type?: string;
}
interface ExecSummary { total: number; graded: number; wins: number; losses: number; pnl_units: number | null }
interface ExecutionData {
  executions: Execution[];
  summary: { paper: ExecSummary; real: ExecSummary };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(ts: string | null): string {
  if (!ts) return "never";
  const d = new Date(ts.replace(" ", "T"));
  const diffMs = Date.now() - d.getTime();
  const h = Math.floor(diffMs / 3_600_000);
  const m = Math.floor((diffMs % 3_600_000) / 60_000);
  if (h > 48) return `${Math.floor(h / 24)}d ago`;
  if (h > 0)  return `${h}h ${m}m ago`;
  if (m > 0)  return `${m}m ago`;
  return "just now";
}

function staleness(ts: string | null): "ok" | "warn" | "stale" | "unknown" {
  if (!ts) return "unknown";
  const h = (Date.now() - new Date(ts.replace(" ", "T")).getTime()) / 3_600_000;
  if (h < 26) return "ok";
  if (h < 50) return "warn";
  return "stale";
}

// cronUtcHour / cronUtcMinute: when the cron fires in UTC
function nextRun(cronUtcHour: number, cronUtcMinute: number = 0): string {
  const nowMs = Date.now();
  const now = new Date();
  const todayRun = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), cronUtcHour, cronUtcMinute, 0));
  const target = todayRun.getTime() > nowMs ? todayRun.getTime() : todayRun.getTime() + 86_400_000;
  const diffMs = target - nowMs;
  const h = Math.floor(diffMs / 3_600_000);
  const m = Math.floor((diffMs % 3_600_000) / 60_000);
  if (h === 0 && m < 5) return "any moment";
  if (h === 0) return `in ${m}m`;
  if (h < 24)  return `in ${h}h ${m}m`;
  return "tomorrow";
}

function fmtDate(d: string): string {
  const [, mo, day] = d.split("-");
  const months = ["", "Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[parseInt(mo)]} ${parseInt(day)}`;
}

function fmtPct(v: number | null, decimals = 1): string {
  return v !== null ? `${(v * 100).toFixed(decimals)}%` : "—";
}

function fmtRoiPct(v: number | null): string {
  if (v === null) return "—";
  const s = (v * 100).toFixed(1);
  return v >= 0 ? `+${s}%` : `${s}%`;
}

function fmtClv(v: number | null): string {
  if (v === null) return "—";
  return v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2);
}

function roiColor(v: number | null): string {
  if (v === null) return "#6b7068";
  return v >= 0 ? "#3ee68a" : "#ef4444";
}

function winRateColor(v: number | null): string {
  if (v === null) return "#6b7068";
  return v >= 0.524 ? "#3ee68a" : v >= 0.48 ? "#f5c062" : "#ef4444";
}

function edgeStatusColor(s: string): string {
  if (s.startsWith("strong"))      return "#3ee68a";
  if (s.startsWith("promising"))   return "#f5c062";
  if (s.startsWith("inconclusive"))return "#f5c062";
  if (s === "bad")                  return "#ef4444";
  return "#6b7068";
}

function abbrevTeam(full: string): string {
  const parts = full.split(" ");
  const last = parts.length > 0 ? parts[parts.length - 1] : full;
  return last.length > 6 ? last.slice(0, 3).toUpperCase() : last.toUpperCase();
}

function jobHealthColor(job: JobStatus): string {
  if (job.hasError) return "#ef4444";
  if (job.truncated) return "#f5c062";
  const age = staleness(job.lastRunAt);
  if (age === "ok") return "#3ee68a";
  if (age === "warn") return "#f5c062";
  if (age === "stale") return "#ef4444";
  return "#6b7068";
}

// ─── Small components ─────────────────────────────────────────────────────────

function Kpi({ label, value, sub, color, mono = true }: {
  label: string; value: string; sub?: string; color?: string; mono?: boolean;
}) {
  return (
    <div className="flex-1 rounded-xl border border-[#22251f] bg-[#121412] p-4 min-w-0">
      <p className="text-[9px] font-semibold text-[#4a524a] uppercase tracking-[0.14em] mb-1.5">{label}</p>
      <p className={cn("text-[22px] font-black leading-none", mono && "font-mono")}
         style={{ color: color ?? "#e4e4e7" }}>{value}</p>
      {sub && <p className="text-[10px] text-[#6b7068] mt-1.5 leading-tight">{sub}</p>}
    </div>
  );
}

function SectionHead({ title, icon: Icon }: { title: string; icon: React.ElementType }) {
  return (
    <div className="flex items-center gap-2 mb-4">
      <Icon className="h-3.5 w-3.5 text-[#3ee68a]" />
      <p className="text-[11px] font-bold text-[#3ee68a] uppercase tracking-[0.18em]">{title}</p>
    </div>
  );
}

function StatusDot({ label, color }: { label: string; color: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="h-2 w-2 rounded-full shrink-0" style={{ background: color }} />
      <span className="text-[10px] text-[#9ca39a]">{label}</span>
    </div>
  );
}

function JobCard({ name, cron, cronPdt, cronUtcHour, cronUtcMinute = 0, job }: {
  name: string; cron: string; cronPdt: string; cronUtcHour: number; cronUtcMinute?: number; job: JobStatus;
}) {
  const age = staleness(job.lastRunAt);
  const color = jobHealthColor(job);
  const statusIcon = job.hasError
    ? <XCircle className="h-3.5 w-3.5 text-[#ef4444] shrink-0" />
    : job.truncated
    ? <AlertTriangle className="h-3.5 w-3.5 text-[#f5c062] shrink-0" />
    : age === "unknown"
    ? <Clock className="h-3.5 w-3.5 text-[#6b7068] shrink-0" />
    : <CheckCircle2 className="h-3.5 w-3.5 shrink-0" style={{ color }} />;

  return (
    <div className={cn(
      "rounded-xl border bg-[#121412] p-4",
      job.hasError ? "border-[#ef4444]/25" : job.truncated ? "border-[#f5c062]/20" : "border-[#22251f]"
    )}>
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold text-white truncate">{name}</p>
          <p className="text-[9px] text-[#6b7068] font-mono mt-0.5">{cronPdt} PDT · {cron}</p>
        </div>
        {statusIcon}
      </div>
      <p className="text-[10px] font-mono leading-tight" style={{ color }}>
        {job.lastRunAt
          ? `last: ${job.lastRunAt.slice(0, 10)}  ${job.lastRunAt.slice(11, 16)}  ·  ${timeAgo(job.lastRunAt)}`
          : "no run recorded"}
      </p>
      <p className="text-[9px] text-[#4a524a] mt-1">next: {nextRun(cronUtcHour, cronUtcMinute)}</p>
      {job.quotaRemaining !== null && (
        <p className="text-[9px] text-[#6b7068] mt-1">quota after run: {job.quotaRemaining}</p>
      )}
      {job.hasError && job.errorSnippet && (
        <p className="text-[9px] text-[#ef4444] mt-1.5 leading-tight truncate">{job.errorSnippet}</p>
      )}
      {job.truncated && !job.hasError && (
        <p className="text-[9px] text-[#f5c062] mt-1.5">output truncated — possible crash</p>
      )}
    </div>
  );
}

function AlertRow({ icon: Icon, msg, color }: { icon: React.ElementType; msg: string; color: string }) {
  return (
    <div className="flex items-start gap-2.5 py-2.5 border-b border-[#1a1e1a] last:border-0">
      <Icon className="h-3.5 w-3.5 mt-0.5 shrink-0" style={{ color }} />
      <p className="text-[11px] text-[#d4d7d0] leading-tight">{msg}</p>
    </div>
  );
}

function BarRow({ label, wins, graded, winRate }: { label: string; wins: number; graded: number; winRate: number | null }) {
  const pct = winRate !== null ? winRate * 100 : 0;
  const color = winRateColor(winRate);
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] text-[#9ca39a] font-mono">{label}</span>
        <span className="text-[10px] font-mono" style={{ color }}>
          {graded > 0 ? `${wins}W / ${graded - wins}L · ${pct.toFixed(0)}%` : "no data"}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-[#22251f] overflow-hidden">
        {graded > 0 && (
          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
        )}
      </div>
    </div>
  );
}

function FunnelStep({ label, count, color, arrow }: { label: string; count: number; color: string; arrow?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <div className="text-center">
        <p className="text-[18px] font-black font-mono leading-none" style={{ color }}>{count}</p>
        <p className="text-[8px] text-[#4a524a] uppercase tracking-widest mt-0.5">{label}</p>
      </div>
      {arrow && <span className="text-[#3a4033] text-[14px] mx-1">→</span>}
    </div>
  );
}

function RecentSignalRow({ s }: { s: RecentSignal }) {
  const isFallback = s.src && s.src !== "pinnacle";
  return (
    <div className="grid grid-cols-[28px_52px_1fr_52px_44px_52px_40px] gap-2 items-center py-2 border-b border-[#161a16] last:border-0">
      <span className="text-[9px] text-[#3a4033] font-mono">#{s.id}</span>
      <span className="text-[9px] text-[#6b7068]">{fmtDate(s.game_date)}</span>
      <span className="text-[10px] text-[#9ca39a] truncate">{abbrevTeam(s.away)} @ {abbrevTeam(s.home)}</span>
      <span className="text-[9px] font-mono text-[#9ca39a]">{s.side?.toUpperCase()} {s.line > 0 ? "+" : ""}{s.line}</span>
      <span className="text-[9px] font-mono" style={{ color: roiColor(s.clv) }}>{fmtClv(s.clv)}</span>
      <span className="text-[8px] text-[#4a524a]">{isFallback ? "fallback" : "same-bk"}</span>
      <span className={cn("text-[9px] font-bold text-right", s.win === 1 ? "text-[#3ee68a]" : "text-[#ef4444]")}>
        {s.win === 1 ? "WIN" : "LOSS"}
      </span>
    </div>
  );
}

function computeEdgeStatus(n: number, avgClv: number | null, pctPos: number | null): string {
  if (n < 30 || avgClv === null) return "accumulating";
  if (avgClv < 0) return "bad";
  const suffix = pctPos !== null && pctPos <= 50 ? "?" : "";
  if (avgClv < 0.5) return `inconclusive${suffix}`;
  if (avgClv < 1.0) return `promising${suffix}`;
  return `strong${suffix}`;
}

function sigTypeLabel(t: string): string {
  if (t === "soft_book_divergence") return "divergence";
  if (t === "line_movement")        return "line move";
  return t.replace(/_/g, " ");
}

function sigTypeBadgeColor(t: string): string {
  if (t === "soft_book_divergence") return "#3ee68a";
  if (t === "line_movement")        return "#f5c062";
  return "#9ca39a";
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function OpsPage() {
  const [pipeline,   setPipeline]   = useState<PipelineData | null>(null);
  const [signals,    setSignals]    = useState<SignalsData | null>(null);
  const [execData,   setExecData]   = useState<ExecutionData | null>(null);
  const [loading,    setLoading]    = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [perfTab, setPerfTab] = useState<"all" | "bets" | "conf" | "source">("all");
  const [loggingBet, setLoggingBet] = useState<number | null>(null);

  async function loadAll() {
    try {
      const [p, s, e] = await Promise.all([
        fetch("/api/ops/pipeline").then((r) => r.json()),
        fetch("/api/ops/signals").then((r) => r.json()),
        fetch("/api/ops/execution").then((r) => r.json()),
      ]);
      setPipeline(p);
      setSignals(s);
      setExecData(e);
      setLastRefresh(new Date());
    } catch (e) {
      console.error("ops load error", e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
    const t = setInterval(loadAll, 60_000);
    return () => clearInterval(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function logRealBet(signalId: number) {
    setLoggingBet(signalId);
    try {
      const resp = await fetch("/api/ops/execution", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signal_id: signalId, notes: "manual from ops" }),
      });
      const data = await resp.json();
      if (data.ok) await loadAll();
      else console.error("log bet failed", data);
    } finally {
      setLoggingBet(null);
    }
  }

  // Build alerts
  const alerts: Array<{ icon: React.ElementType; msg: string; color: string }> = [];
  if (pipeline) {
    if (pipeline.latestQuota !== null && pipeline.latestQuota < 60)
      alerts.push({ icon: AlertTriangle, msg: `API quota critical — ${pipeline.latestQuota} requests remaining`, color: "#ef4444" });
    else if (pipeline.latestQuota !== null && pipeline.latestQuota < 150)
      alerts.push({ icon: AlertTriangle, msg: `API quota low — ${pipeline.latestQuota} requests remaining`, color: "#f5c062" });
    const jobs = pipeline.jobs;
    if (jobs.state.hasError) alerts.push({ icon: XCircle, msg: `Team state errored: ${jobs.state.errorSnippet}`, color: "#ef4444" });
    if (jobs.grade.hasError) alerts.push({ icon: XCircle, msg: `Grade job errored: ${jobs.grade.errorSnippet}`, color: "#ef4444" });
    if (jobs.fetch.hasError) alerts.push({ icon: XCircle, msg: `Fetch/predict errored: ${jobs.fetch.errorSnippet}`, color: "#ef4444" });
    if (jobs.fetch.truncated && !jobs.fetch.hasError)
      alerts.push({ icon: AlertTriangle, msg: "Fetch/predict output truncated", color: "#f5c062" });
    Object.entries(jobs).forEach(([key, j]) => {
      if (staleness(j.lastRunAt) === "stale")
        alerts.push({ icon: Clock, msg: `${key} job hasn't run in >2 days`, color: "#f5c062" });
    });
    if (pipeline.worker.lastPollOk === false)
      alerts.push({ icon: XCircle, msg: "Worker daemon last poll failed", color: "#ef4444" });
    if (pipeline.worker.lastPollAt && staleness(pipeline.worker.lastPollAt) === "stale")
      alerts.push({ icon: AlertTriangle, msg: "Worker daemon hasn't polled in >2 days", color: "#f5c062" });
  }
  if (signals && !signals.error) {
    if (signals.stale.length > 0)
      alerts.push({ icon: AlertTriangle, msg: `${signals.stale.length} stale open signal(s) older than 3 days — auto-void pending`, color: "#f5c062" });
    if ((signals.by_status["proxy_captured"] ?? 0) > 0)
      alerts.push({ icon: Info, msg: `${signals.by_status["proxy_captured"]} signal(s) have proxy captured, awaiting game scores`, color: "#6b7068" });
  }

  if (loading) {
    return (
      <div className="flex-1 overflow-y-auto bg-[#0a0b0a] flex items-center justify-center">
        <div className="flex items-center gap-2 text-[#6b7068]">
          <RefreshCw className="h-4 w-4 animate-spin" />
          <span className="text-[12px]">Loading ops data...</span>
        </div>
      </div>
    );
  }

  const m = pipeline?.model;
  const sig = signals;
  const jobs = pipeline?.jobs;
  const worker = pipeline?.worker;

  const emptyJob: JobStatus = { lastRunAt: null, quotaRemaining: null, hasError: false, errorSnippet: null, truncated: false };

  function workerHealthColor(w: WorkerStatus | undefined): string {
    if (!w) return "#6b7068";
    if (w.lastPollOk === false) return "#ef4444";
    if (!w.lastPollAt) return "#6b7068";
    const age = staleness(w.lastPollAt);
    if (age === "ok") return "#3ee68a";
    if (age === "warn") return "#f5c062";
    return "#ef4444";
  }

  return (
    <div className="flex-1 overflow-y-auto bg-[#0a0b0a]">
      <div className="max-w-5xl mx-auto px-6 py-6 space-y-5">

        {/* ── Header ── */}
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Terminal className="h-4 w-4 text-[#3ee68a]" />
              <h1 className="text-[18px] font-bold text-white tracking-tight">ACE Ops</h1>
              <span className="text-[8px] font-bold text-[#6b7068] border border-[#2e332a] rounded px-1.5 py-0.5 uppercase tracking-widest">Internal</span>
            </div>
            <p className="text-[11px] text-[#6b7068]">Pipeline diagnostics · CLV validation · System health</p>
          </div>
          <div className="text-right">
            {lastRefresh && (
              <p className="text-[9px] text-[#6b7068] font-mono">
                refreshed {Math.round((Date.now() - lastRefresh.getTime()) / 1000)}s ago
              </p>
            )}
            <p className="text-[9px] text-[#3a4033] font-mono mt-0.5">ET: {pipeline?.etToday ?? sig?.et_today ?? "—"}</p>
          </div>
        </div>

        {/* ── System status strip ── */}
        <div className="flex items-center gap-4 rounded-xl border border-[#1a1e1a] bg-[#0d0f0d] px-4 py-3 flex-wrap">
          <StatusDot label="Worker"  color={workerHealthColor(worker)} />
          <StatusDot label="State"   color={jobHealthColor(jobs?.state ?? emptyJob)} />
          <StatusDot label="Grade"   color={jobHealthColor(jobs?.grade ?? emptyJob)} />
          <StatusDot label="Fetch"   color={jobHealthColor(jobs?.fetch ?? emptyJob)} />
          <div className="h-3 w-px bg-[#22251f]" />
          <span className="text-[10px] text-[#6b7068]">
            Quota <span className="font-mono text-[#9ca39a]">{pipeline?.latestQuota ?? "—"} / 500</span>
          </span>
          <div className="h-3 w-px bg-[#22251f]" />
          <span className="text-[10px] text-[#6b7068]">
            Edge{" "}
            <span className="font-mono font-bold" style={{ color: edgeStatusColor(sig?.edgeStatus ?? "") }}>
              {sig?.edgeStatus?.toUpperCase() ?? "—"}
            </span>
            {sig && !sig.error && sig.needFor30 > 0 && (
              <span className="text-[#4a524a]"> ({sig.clv.n}/30)</span>
            )}
          </span>
          {alerts.length > 0 && (
            <>
              <div className="h-3 w-px bg-[#22251f]" />
              <span className="text-[9px] font-bold text-[#f5c062]">⚠ {alerts.length} alert{alerts.length !== 1 ? "s" : ""}</span>
            </>
          )}
        </div>

        {/* ── A. Pipeline Health ── */}
        <div className="ace-panel p-5">
          <SectionHead title="Pipeline Health" icon={Activity} />

          {/* Worker Daemon card */}
          {(() => {
            const w = worker;
            const color = workerHealthColor(w);
            const pollTs = w?.lastPollAt ? w.lastPollAt.replace("T", " ").slice(0, 19) : null;
            const hasError = w?.lastPollOk === false;
            return (
              <div className={cn(
                "rounded-xl border bg-[#121412] p-4 mb-3",
                hasError ? "border-[#ef4444]/25" : "border-[#3ee68a]/15"
              )}>
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <Wifi className="h-3.5 w-3.5 shrink-0" style={{ color }} />
                      <p className="text-[11px] font-semibold text-white">Worker Daemon</p>
                      <span className="text-[8px] font-bold text-[#3ee68a] border border-[#3ee68a]/30 rounded px-1 py-0.5 uppercase tracking-widest">supervisord</span>
                    </div>
                    <p className="text-[9px] text-[#6b7068] font-mono mt-0.5">continuous poll · 60s near tip · 10min otherwise</p>
                  </div>
                  {hasError
                    ? <XCircle className="h-3.5 w-3.5 text-[#ef4444] shrink-0" />
                    : pollTs
                    ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" style={{ color }} />
                    : <Clock className="h-3.5 w-3.5 text-[#6b7068] shrink-0" />}
                </div>
                <p className="text-[10px] font-mono leading-tight" style={{ color }}>
                  {pollTs
                    ? `last poll: ${pollTs.slice(0, 10)} ${pollTs.slice(11, 16)} · ${timeAgo(pollTs)}`
                    : "no poll recorded yet"}
                </p>
                {hasError && <p className="text-[9px] text-[#ef4444] mt-1.5">last poll failed — check Railway logs</p>}
              </div>
            );
          })()}

          <div className="grid grid-cols-3 gap-3 mb-4">
            <JobCard name="update_team_state" cronPdt="8:00am ET" cron="daily" cronUtcHour={13} job={jobs?.state ?? emptyJob} />
            <JobCard name="grade_results"     cronPdt="9:00am ET" cron="daily" cronUtcHour={14} job={jobs?.grade ?? emptyJob} />
            <JobCard name="fetch_and_predict" cronPdt="12:00pm ET" cron="daily" cronUtcHour={17} job={jobs?.fetch ?? emptyJob} />
          </div>
          {pipeline?.latestQuota != null && (
            <div className="flex items-center gap-3">
              <div className="flex-1 h-1.5 rounded-full bg-[#22251f] overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${Math.min(100, (pipeline.latestQuota / 500) * 100)}%`,
                    background: pipeline.latestQuota < 60 ? "#ef4444" : pipeline.latestQuota < 150 ? "#f5c062" : "#3ee68a",
                  }}
                />
              </div>
              <p className="text-[10px] font-mono text-[#9ca39a] shrink-0">
                {pipeline.latestQuota} / 500 remaining
              </p>
            </div>
          )}
        </div>

        {/* ── Needs Attention ── */}
        {alerts.length > 0 && (
          <div className="rounded-xl border border-[#f5c062]/20 bg-[#f5c062]/[0.03] p-4">
            <div className="flex items-center gap-2 mb-1">
              <AlertTriangle className="h-3.5 w-3.5 text-[#f5c062]" />
              <p className="text-[10px] font-bold text-[#f5c062] uppercase tracking-[0.18em]">Needs Attention</p>
            </div>
            <div>
              {alerts.map((a, i) => <AlertRow key={i} icon={a.icon} msg={a.msg} color={a.color} />)}
            </div>
          </div>
        )}

        {/* ── B. Today's Activity ── */}
        <div className="ace-panel p-5">
          <SectionHead title={`Today's Activity · ${pipeline?.etToday ?? sig?.et_today ?? "—"}`} icon={Zap} />

          {/* KPIs */}
          <div className="flex gap-3 mb-5">
            <Kpi label="Games on slate"     value={String(sig?.today?.games?.length ?? "—")} />
            <Kpi label="Predictions logged" value={String(m?.todayLogged ?? "—")} />
            <Kpi label="Snapshots captured" value={String(sig?.today?.snapshots ?? "—")} />
            <Kpi label="Signals fired"      value={String(sig?.today?.signals ?? "—")}
                 color={(sig?.today?.signals ?? 0) > 0 ? "#3ee68a" : "#6b7068"} />
          </div>

          {/* Signal pipeline funnel */}
          {sig && !sig.error && (
            <div className="rounded-xl border border-[#1a1e1a] bg-[#0d0f0d] p-4 mb-4">
              <p className="text-[9px] text-[#4a524a] uppercase tracking-widest mb-3">Signal pipeline (all-time)</p>
              <div className="flex items-center gap-1 flex-wrap">
                <FunnelStep label="Open"    count={sig.by_status["open"] ?? 0}            color="#f5c062" arrow />
                <FunnelStep label="Proxy ✓" count={sig.by_status["proxy_captured"] ?? 0}  color="#9ca39a" arrow />
                <FunnelStep label="Graded"  count={sig.by_status["graded"] ?? 0}           color="#3ee68a" arrow />
                <FunnelStep label="Voided"  count={sig.by_status["no_action"] ?? 0}        color="#3a4033" />
              </div>
            </div>
          )}

          {/* Games on slate */}
          {sig?.today?.games && sig.today.games.length > 0 && (
            <div className="mb-4">
              <p className="text-[9px] text-[#4a524a] uppercase tracking-widest mb-2">Games on slate</p>
              <div className="flex flex-wrap gap-2">
                {sig.today.games.map((g, i) => (
                  <div key={i} className="rounded-lg border border-[#22251f] bg-[#0d0f0d] px-3 py-1.5 flex items-center gap-1.5">
                    <span className="text-[10px] text-[#9ca39a]">{abbrevTeam(g.away)}</span>
                    <span className="text-[9px] text-[#3a4033]">@</span>
                    <span className="text-[10px] text-white font-semibold">{abbrevTeam(g.home)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Open signals with Log Bet button */}
          {sig?.open_signals && sig.open_signals.length > 0 && (
            <div>
              <p className="text-[9px] text-[#4a524a] uppercase tracking-widest mb-2">Open signals</p>
              <div className="space-y-1.5">
                {sig.open_signals.map((s) => {
                  const alreadyLogged = execData?.executions.some(
                    (e) => e.signal_id === s.id && e.mode === "real"
                  );
                  return (
                    <div key={s.id} className="flex items-center gap-3 rounded-lg border border-[#22251f] bg-[#0d0f0d] px-3 py-2">
                      <span className="text-[9px] text-[#6b7068] font-mono shrink-0">#{s.id}</span>
                      <span className="text-[10px] text-[#6b7068] shrink-0">{s.game_date}</span>
                      <span className="text-[10px] text-white flex-1">{abbrevTeam(s.away_team)} @ {abbrevTeam(s.home_team)}</span>
                      <span className="text-[9px] font-mono text-[#3ee68a]">{s.bet_side.toUpperCase()} {s.line_at_signal > 0 ? "+" : ""}{s.line_at_signal}</span>
                      <span className="text-[8px] font-semibold px-1.5 py-0.5 rounded border border-[#2e332a]"
                            style={{ color: sigTypeBadgeColor(s.signal_type) }}>
                        {sigTypeLabel(s.signal_type)}
                      </span>
                      <span className={cn(
                        "text-[8px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded border",
                        s.status === "proxy_captured"
                          ? "text-[#f5c062] border-[#f5c062]/20 bg-[#f5c062]/5"
                          : "text-[#6b7068] border-[#2e332a]"
                      )}>{s.status === "proxy_captured" ? "proxy ✓" : "open"}</span>
                      {alreadyLogged ? (
                        <span className="text-[8px] font-bold text-[#3ee68a] shrink-0">BET ✓</span>
                      ) : (
                        <button
                          onClick={() => logRealBet(s.id)}
                          disabled={loggingBet === s.id}
                          className="flex items-center gap-1 text-[8px] font-bold text-[#f5c062] border border-[#f5c062]/30 rounded px-1.5 py-0.5 hover:bg-[#f5c062]/10 transition-colors disabled:opacity-50 shrink-0"
                        >
                          <PlusCircle className="h-3 w-3" />
                          {loggingBet === s.id ? "..." : "Log Bet"}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {!sig?.today?.games?.length && !sig?.open_signals?.length && (
            <p className="text-[11px] text-[#6b7068]">No game or signal data for today yet. Noon cron may not have run.</p>
          )}
        </div>

        {/* ── B2. Execution Tracker ── */}
        <div className="ace-panel p-5">
          <SectionHead title="Execution Tracker" icon={BookMarked} />
          <p className="text-[10px] text-[#6b7068] mb-4">
            Paper trades auto-log on every divergence signal · use "Log Bet" above to record real money bets
          </p>

          {execData?.summary ? (
            <div>
              {/* Summary KPIs */}
              <div className="grid grid-cols-2 gap-3 mb-5">
                {/* Paper */}
                <div className="rounded-xl border border-[#22251f] bg-[#0d0f0d] p-4">
                  <div className="flex items-center gap-1.5 mb-3">
                    <p className="text-[9px] font-bold text-[#9ca39a] uppercase tracking-widest">Paper trades</p>
                    <span className="text-[7px] text-[#4a524a] border border-[#22251f] rounded px-1 py-0.5 uppercase">auto</span>
                  </div>
                  {execData.summary.paper.total === 0 ? (
                    <p className="text-[11px] text-[#4a524a]">None yet — fires on next divergence signal</p>
                  ) : (
                    <div className="space-y-2">
                      <div className="flex gap-3">
                        <div>
                          <p className="text-[8px] text-[#4a524a] mb-0.5">total</p>
                          <p className="text-[20px] font-black font-mono text-[#9ca39a] leading-none">{execData.summary.paper.total}</p>
                        </div>
                        <div>
                          <p className="text-[8px] text-[#4a524a] mb-0.5">graded</p>
                          <p className="text-[20px] font-black font-mono text-[#9ca39a] leading-none">{execData.summary.paper.graded}</p>
                        </div>
                        {execData.summary.paper.graded > 0 && (
                          <>
                            <div>
                              <p className="text-[8px] text-[#4a524a] mb-0.5">record</p>
                              <p className="text-[20px] font-black font-mono leading-none"
                                 style={{ color: winRateColor(execData.summary.paper.wins / execData.summary.paper.graded) }}>
                                {execData.summary.paper.wins}–{execData.summary.paper.losses}
                              </p>
                            </div>
                            <div>
                              <p className="text-[8px] text-[#4a524a] mb-0.5">P&L (units)</p>
                              <p className="text-[20px] font-black font-mono leading-none"
                                 style={{ color: roiColor(execData.summary.paper.pnl_units) }}>
                                {execData.summary.paper.pnl_units !== null
                                  ? (execData.summary.paper.pnl_units >= 0 ? "+" : "") + execData.summary.paper.pnl_units.toFixed(2)
                                  : "—"}
                              </p>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* Real */}
                <div className="rounded-xl border border-[#22251f] bg-[#0d0f0d] p-4">
                  <div className="flex items-center gap-1.5 mb-3">
                    <p className="text-[9px] font-bold text-[#f5c062] uppercase tracking-widest">Real bets</p>
                    <span className="text-[7px] text-[#4a524a] border border-[#22251f] rounded px-1 py-0.5 uppercase">manual</span>
                  </div>
                  {execData.summary.real.total === 0 ? (
                    <p className="text-[11px] text-[#4a524a]">None logged yet — click "Log Bet" on an open signal above</p>
                  ) : (
                    <div className="flex gap-3">
                      <div>
                        <p className="text-[8px] text-[#4a524a] mb-0.5">total</p>
                        <p className="text-[20px] font-black font-mono text-[#f5c062] leading-none">{execData.summary.real.total}</p>
                      </div>
                      <div>
                        <p className="text-[8px] text-[#4a524a] mb-0.5">graded</p>
                        <p className="text-[20px] font-black font-mono text-[#9ca39a] leading-none">{execData.summary.real.graded}</p>
                      </div>
                      {execData.summary.real.graded > 0 && (
                        <>
                          <div>
                            <p className="text-[8px] text-[#4a524a] mb-0.5">record</p>
                            <p className="text-[20px] font-black font-mono leading-none"
                               style={{ color: winRateColor(execData.summary.real.wins / execData.summary.real.graded) }}>
                              {execData.summary.real.wins}–{execData.summary.real.losses}
                            </p>
                          </div>
                          <div>
                            <p className="text-[8px] text-[#4a524a] mb-0.5">P&L (units)</p>
                            <p className="text-[20px] font-black font-mono leading-none"
                               style={{ color: roiColor(execData.summary.real.pnl_units) }}>
                              {execData.summary.real.pnl_units !== null
                                ? (execData.summary.real.pnl_units >= 0 ? "+" : "") + execData.summary.real.pnl_units.toFixed(2)
                                : "—"}
                            </p>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Execution log table */}
              {execData.executions.length > 0 && (
                <div>
                  <p className="text-[9px] text-[#4a524a] uppercase tracking-widest mb-2">Recent executions</p>
                  <div className="rounded-xl border border-[#1a1e1a] bg-[#0d0f0d] overflow-hidden">
                    <div className="grid grid-cols-[28px_56px_1fr_56px_60px_52px_44px_44px] gap-2 px-3 py-2 border-b border-[#22251f]">
                      {["#", "Date", "Game", "Side", "Book", "Mode", "Line", "Result"].map((h) => (
                        <span key={h} className="text-[8px] font-bold text-[#3a4033] uppercase tracking-widest">{h}</span>
                      ))}
                    </div>
                    {execData.executions.slice(0, 20).map((e) => {
                      const isPush = e.graded_at !== null && e.outcome === null;
                      const outcomeColor = e.outcome === 1 ? "#3ee68a" : e.outcome === 0 ? "#ef4444" : isPush ? "#6b7068" : "#3a4033";
                      const outcomeLabel = e.outcome === 1 ? "WIN" : e.outcome === 0 ? "LOSS" : isPush ? "PUSH" : "—";
                      return (
                        <div key={e.id} className="grid grid-cols-[28px_56px_1fr_56px_60px_52px_44px_44px] gap-2 items-center px-3 py-2 border-b border-[#0f110f] last:border-0">
                          <span className="text-[9px] text-[#3a4033] font-mono">#{e.signal_id}</span>
                          <span className="text-[9px] text-[#6b7068]">{e.game_date ? fmtDate(e.game_date) : "—"}</span>
                          <span className="text-[10px] text-[#9ca39a] truncate">
                            {e.away_team && e.home_team ? `${abbrevTeam(e.away_team)} @ ${abbrevTeam(e.home_team)}` : "—"}
                          </span>
                          <span className="text-[9px] font-mono text-[#9ca39a]">{e.bet_side?.toUpperCase()} {e.signal_line > 0 ? "+" : ""}{e.signal_line}</span>
                          <span className="text-[9px] text-[#6b7068] truncate">{e.book || "—"}</span>
                          <span className={cn("text-[8px] font-bold uppercase tracking-widest",
                            e.mode === "real" ? "text-[#f5c062]" : "text-[#6b7068]"
                          )}>{e.mode}</span>
                          <span className="text-[9px] font-mono text-[#6b7068]">
                            {e.fill_line !== null ? `${e.fill_line > 0 ? "+" : ""}${e.fill_line}` : `${e.signal_line > 0 ? "+" : ""}${e.signal_line}`}
                          </span>
                          <span className="text-[9px] font-bold text-right" style={{ color: outcomeColor }}>{outcomeLabel}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="text-[11px] text-[#6b7068]">Loading execution data...</p>
          )}
        </div>

        {/* ── C. Prediction Performance ── */}
        <div className="ace-panel p-5">
          <SectionHead title="Prediction Performance" icon={TrendingUp} />

          <div className="flex gap-0.5 mb-5 border-b border-[#22251f]">
            {(["all", "bets", "conf", "source"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setPerfTab(t)}
                className={cn(
                  "px-3 py-2 text-[11px] font-semibold border-b-2 -mb-px transition-colors",
                  perfTab === t ? "text-white border-[#3ee68a]" : "text-[#6b7068] border-transparent hover:text-[#d4d7d0]"
                )}
              >
                {t === "all" ? "All" : t === "bets" ? "Bets Only" : t === "conf" ? "Confidence" : "Pinnacle vs Fallback"}
              </button>
            ))}
          </div>

          {perfTab === "all" && m && (
            <div>
              <div className="flex gap-3 mb-3">
                <Kpi label="Total logged" value={String(m.total)} />
                <Kpi label="Graded"       value={String(m.graded)} sub={`${m.pending} pending · ${m.pushed} push`} />
                <Kpi label="Record"       value={`${m.wins}–${m.losses}`} color={winRateColor(m.winRate)} />
                <Kpi label="Win rate"     value={fmtPct(m.winRate)} color={winRateColor(m.winRate)} sub="break-even 52.4%" />
                <Kpi label="ROI"          value={fmtRoiPct(m.roi)} color={roiColor(m.roi)} sub="flat-bet −110" />
              </div>
              {m.avgConf !== null && (
                <p className="text-[10px] text-[#6b7068]">
                  avg confidence: <span className="font-mono text-[#9ca39a]">{(m.avgConf * 100).toFixed(1)}%</span>
                </p>
              )}
              <p className="text-[9px] text-[#3a4033] mt-2">Graded predictions only. ROI = flat-bet at −110 vig.</p>
            </div>
          )}

          {perfTab === "bets" && m && (
            <div>
              <div className="flex gap-3 mb-3">
                <Kpi label="Bets logged"  value={String(m.betsTotal)} sub="is_bet=1" />
                <Kpi label="Bets graded"  value={String(m.betsGraded)} />
                <Kpi label="Record"       value={`${m.betsWins}–${m.betsLosses}`} color={winRateColor(m.betsWinRate)} />
                <Kpi label="Win rate"     value={fmtPct(m.betsWinRate)} color={winRateColor(m.betsWinRate)} />
                <Kpi label="ROI"          value={fmtRoiPct(m.betsRoi)} color={roiColor(m.betsRoi)} />
              </div>
              <p className="text-[9px] text-[#3a4033]">Pinnacle-edge bets only — model must disagree with Pinnacle by ≥4pp in the pick direction.</p>
            </div>
          )}

          {perfTab === "conf" && m && (
            <div>
              <p className="text-[10px] text-[#6b7068] mb-4">Win rate by model confidence bucket (graded only)</p>
              {m.buckets.map((b) => <BarRow key={b.label} label={b.label} wins={b.wins} graded={b.graded} winRate={b.winRate} />)}
              <p className="text-[9px] text-[#3a4033] mt-2">Buckets are meaningful once each has 20+ graded predictions.</p>
            </div>
          )}

          {perfTab === "source" && m && (
            <div>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div className="rounded-xl border border-[#22251f] bg-[#0d0f0d] p-4">
                  <p className="text-[9px] text-[#4a524a] uppercase tracking-widest mb-1">Pinnacle-backed</p>
                  <p className="text-[10px] text-[#6b7068] mb-3">edge_vs_pinnacle present</p>
                  <BarRow label={`${m.pinnacleWins}W / ${m.pinnacleGraded - m.pinnacleWins}L`} wins={m.pinnacleWins} graded={m.pinnacleGraded} winRate={m.pinnacleWinRate} />
                </div>
                <div className="rounded-xl border border-[#22251f] bg-[#0d0f0d] p-4">
                  <p className="text-[9px] text-[#4a524a] uppercase tracking-widest mb-1">Fallback (no Pinnacle)</p>
                  <p className="text-[10px] text-[#6b7068] mb-3">confidence threshold only</p>
                  <BarRow label={`${m.fallbackWins}W / ${m.fallbackGraded - m.fallbackWins}L`} wins={m.fallbackWins} graded={m.fallbackGraded} winRate={m.fallbackWinRate} />
                </div>
              </div>
              <p className="text-[9px] text-[#3a4033]">Pinnacle-backed = model disagreed with Pinnacle ≥4pp. Fallback = Pinnacle line unavailable.</p>
            </div>
          )}
        </div>

        {/* ── D. CLV / Signal Validation ── */}
        <div className="ace-panel p-5">
          <SectionHead title="CLV / Signal Validation" icon={Database} />

          {sig?.error ? (
            <p className="text-[11px] text-[#ef4444]">Signal DB unavailable: {sig.error}</p>
          ) : sig ? (
            <div>
              {/* Counts */}
              <div className="flex gap-3 mb-4">
                <Kpi label="Total signals"  value={String(sig.total)} />
                <Kpi label="Open"           value={String(sig.by_status["open"] ?? 0)} color={(sig.by_status["open"] ?? 0) > 0 ? "#f5c062" : "#6b7068"} />
                <Kpi label="Proxy captured" value={String(sig.by_status["proxy_captured"] ?? 0)} color={(sig.by_status["proxy_captured"] ?? 0) > 0 ? "#f5c062" : "#6b7068"} />
                <Kpi label="Graded"         value={String(sig.by_status["graded"] ?? 0)} color="#3ee68a" />
                <Kpi label="Voided"         value={String(sig.by_status["no_action"] ?? 0)} color="#6b7068" />
              </div>

              {/* Edge status + progress */}
              <div className="rounded-xl border border-[#22251f] bg-[#0d0f0d] p-4 mb-4">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <p className="text-[9px] text-[#4a524a] uppercase tracking-widest mb-1">Edge Status</p>
                    <p className="text-[22px] font-black font-mono" style={{ color: edgeStatusColor(sig.edgeStatus) }}>
                      {sig.edgeStatus.toUpperCase()}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-[9px] text-[#4a524a] mb-1">graded signals</p>
                    <p className="text-[22px] font-black font-mono text-[#9ca39a]">{sig.clv.n}<span className="text-[14px] text-[#4a524a]"> / 30</span></p>
                  </div>
                </div>
                <div className="h-1.5 rounded-full bg-[#22251f] overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${Math.min(100, (sig.clv.n / 30) * 100)}%`,
                      background: edgeStatusColor(sig.edgeStatus),
                    }}
                  />
                </div>
                {sig.needFor30 > 0 && (
                  <p className="text-[9px] text-[#4a524a] mt-2">{sig.needFor30} more graded signal{sig.needFor30 !== 1 ? "s" : ""} needed for edge assessment</p>
                )}
              </div>

              {/* CLV KPIs — aggregate across all signal types */}
              <div className="flex gap-3 mb-4">
                <Kpi label="Avg CLV"      value={fmtClv(sig.clv.avg)}    color={sig.clv.avg    !== null ? roiColor(sig.clv.avg)    : "#6b7068"} sub="all types" />
                <Kpi label="Median CLV"   value={fmtClv(sig.clv.median)} color={sig.clv.median !== null ? roiColor(sig.clv.median) : "#6b7068"} />
                <Kpi label="% Positive"   value={sig.clv.pct_positive !== null ? `${sig.clv.pct_positive}%` : "—"} color={sig.clv.pct_positive !== null ? winRateColor(sig.clv.pct_positive / 100) : "#6b7068"} />
                <Kpi label="CLV W/L"      value={`${sig.clv.wins}–${sig.clv.total_graded - sig.clv.wins}`} color={winRateColor(sig.clv.wins / (sig.clv.total_graded || 1))} />
              </div>

              {/* Per-signal-type CLV breakdown */}
              {sig.by_type && Object.keys(sig.by_type).length > 0 && (
                <div className="mb-4">
                  <p className="text-[9px] text-[#4a524a] uppercase tracking-widest mb-2">CLV by signal type</p>
                  <div className="grid grid-cols-2 gap-3">
                    {(["soft_book_divergence", "line_movement"] as const).map((type) => {
                      const stats = sig.by_type[type];
                      const edgeSt = stats ? computeEdgeStatus(stats.graded, stats.avg_clv, stats.pct_pos) : "accumulating";
                      return (
                        <div key={type} className="rounded-xl border border-[#22251f] bg-[#0d0f0d] p-3">
                          <div className="flex items-center justify-between mb-2">
                            <p className="text-[9px] font-bold uppercase tracking-widest"
                               style={{ color: sigTypeBadgeColor(type) }}>
                              {sigTypeLabel(type)}
                            </p>
                            <p className="text-[8px] font-bold uppercase tracking-widest"
                               style={{ color: edgeStatusColor(edgeSt) }}>
                              {edgeSt}
                            </p>
                          </div>
                          {stats ? (
                            <div className="flex gap-4">
                              <div>
                                <p className="text-[8px] text-[#4a524a] mb-0.5">avg CLV</p>
                                <p className="text-[18px] font-black font-mono leading-none"
                                   style={{ color: roiColor(stats.avg_clv) }}>
                                  {fmtClv(stats.avg_clv)}
                                </p>
                              </div>
                              <div>
                                <p className="text-[8px] text-[#4a524a] mb-0.5">graded</p>
                                <p className="text-[18px] font-black font-mono leading-none text-[#9ca39a]">
                                  {stats.graded}
                                </p>
                              </div>
                              <div>
                                <p className="text-[8px] text-[#4a524a] mb-0.5">% pos</p>
                                <p className="text-[18px] font-black font-mono leading-none"
                                   style={{ color: stats.pct_pos !== null ? winRateColor(stats.pct_pos / 100) : "#6b7068" }}>
                                  {stats.pct_pos !== null ? `${stats.pct_pos}%` : "—"}
                                </p>
                              </div>
                            </div>
                          ) : (
                            <p className="text-[11px] text-[#4a524a] font-mono mt-1">no graded signals yet</p>
                          )}
                          {stats && <p className="text-[9px] text-[#3a4033] mt-1.5">n={stats.n} total</p>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Recent graded signals */}
              {sig.recent_graded && sig.recent_graded.length > 0 && (
                <div className="mb-4">
                  <p className="text-[9px] text-[#4a524a] uppercase tracking-widest mb-2">Recent graded signals</p>
                  <div className="rounded-xl border border-[#1a1e1a] bg-[#0d0f0d] px-3 py-1">
                    {/* Header */}
                    <div className="grid grid-cols-[28px_52px_1fr_52px_44px_52px_40px] gap-2 py-1.5 border-b border-[#22251f]">
                      {["#", "Date", "Game", "Side", "CLV", "Source", "Result"].map((h) => (
                        <span key={h} className="text-[8px] font-bold text-[#3a4033] uppercase tracking-widest">{h}</span>
                      ))}
                    </div>
                    {sig.recent_graded.map((s) => <RecentSignalRow key={s.id} s={s} />)}
                  </div>
                </div>
              )}

              {/* Same-book vs fallback */}
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-[#22251f] bg-[#0d0f0d] p-3">
                  <p className="text-[9px] text-[#4a524a] uppercase tracking-widest mb-1">Same-book CLV</p>
                  <p className="text-[20px] font-black font-mono" style={{ color: sig.pinnacle_close.clv !== null ? roiColor(sig.pinnacle_close.clv) : "#6b7068" }}>
                    {fmtClv(sig.pinnacle_close.clv)}
                  </p>
                  <p className="text-[9px] text-[#6b7068] mt-1">n={sig.pinnacle_close.n} · close from Pinnacle (canonical)</p>
                </div>
                <div className="rounded-xl border border-[#22251f] bg-[#0d0f0d] p-3">
                  <p className="text-[9px] text-[#4a524a] uppercase tracking-widest mb-1">Fallback CLV</p>
                  <p className="text-[20px] font-black font-mono" style={{ color: sig.non_pinnacle_close.clv !== null ? roiColor(sig.non_pinnacle_close.clv) : "#6b7068" }}>
                    {fmtClv(sig.non_pinnacle_close.clv)}
                  </p>
                  <p className="text-[9px] text-[#6b7068] mt-1">n={sig.non_pinnacle_close.n} · no Pinnacle at close</p>
                </div>
              </div>
              <p className="text-[9px] text-[#3a4033] mt-3">CLV = direction × (line_at_signal − closing_line). Positive = beat the close.</p>
            </div>
          ) : (
            <p className="text-[11px] text-[#6b7068]">Signal data unavailable.</p>
          )}
        </div>

        {/* ── E. Strategy Breakdown ── */}
        <div className="ace-panel p-5">
          <SectionHead title="Strategy Breakdown" icon={TrendingUp} />
          <p className="text-[10px] text-[#6b7068] mb-4">
            Primary signal: soft book divergence from Pinnacle. Model and line movement are comparison signals.
          </p>
          <div className="grid grid-cols-3 gap-3">
            {/* PRIMARY: Soft Book Divergence */}
            <div className="rounded-xl border border-[#3ee68a]/20 bg-[#0d0f0d] p-4">
              <div className="flex items-center gap-1.5 mb-1">
                <p className="text-[9px] text-[#3a4033] uppercase tracking-widest">Soft Book Divergence</p>
                <span className="text-[7px] font-bold text-[#3ee68a] border border-[#3ee68a]/30 rounded px-1 py-0.5 uppercase tracking-widest">Primary</span>
              </div>
              <p className="text-[10px] text-[#6b7068] mb-3">Soft book lags Pinnacle · bet in pin's direction</p>
              {sig && !sig.error && sig.by_type?.["soft_book_divergence"] ? (() => {
                const st = sig.by_type["soft_book_divergence"];
                const es = computeEdgeStatus(st.graded, st.avg_clv, st.pct_pos);
                return (
                  <>
                    <p className="text-[22px] font-black font-mono mb-1"
                       style={{ color: edgeStatusColor(es) }}>{es.toUpperCase()}</p>
                    <p className="text-[10px] text-[#6b7068]">{st.n} total · {st.graded} graded</p>
                    <p className="text-[10px] text-[#6b7068] mt-1">avg CLV: <span className="font-mono">{fmtClv(st.avg_clv)}</span></p>
                  </>
                );
              })() : (
                <p className="text-[11px] text-[#4a524a] font-mono">accumulating</p>
              )}
            </div>

            {/* SECONDARY: Line Movement */}
            <div className="rounded-xl border border-[#22251f] bg-[#0d0f0d] p-4">
              <p className="text-[9px] text-[#4a524a] uppercase tracking-widest mb-1">Line Movement</p>
              <p className="text-[10px] text-[#6b7068] mb-3">Auto-detected ≥1.5pt moves · 3pm cron</p>
              {sig && !sig.error && sig.by_type?.["line_movement"] ? (() => {
                const st = sig.by_type["line_movement"];
                const es = computeEdgeStatus(st.graded, st.avg_clv, st.pct_pos);
                return (
                  <>
                    <p className="text-[22px] font-black font-mono mb-1"
                       style={{ color: edgeStatusColor(es) }}>{es.toUpperCase()}</p>
                    <p className="text-[10px] text-[#6b7068]">{st.n} total · {st.graded} graded</p>
                    <p className="text-[10px] text-[#6b7068] mt-1">avg CLV: <span className="font-mono">{fmtClv(st.avg_clv)}</span></p>
                  </>
                );
              })() : <p className="text-[11px] text-[#6b7068]">—</p>}
            </div>

            {/* REFERENCE: Model Predictions */}
            <div className="rounded-xl border border-[#22251f] bg-[#0d0f0d] p-4">
              <p className="text-[9px] text-[#4a524a] uppercase tracking-widest mb-1">Model Predictions</p>
              <p className="text-[10px] text-[#6b7068] mb-3">Reference · noon cron · not primary signal</p>
              {m ? (
                <>
                  <p className="text-[22px] font-black font-mono mb-1" style={{ color: winRateColor(m.winRate) }}>
                    {fmtPct(m.winRate, 0)}
                  </p>
                  <p className="text-[10px] text-[#6b7068]">{m.wins}W / {m.losses}L · {m.graded} graded</p>
                  <p className="text-[10px] font-mono mt-1" style={{ color: roiColor(m.roi) }}>ROI {fmtRoiPct(m.roi)}</p>
                </>
              ) : <p className="text-[11px] text-[#6b7068]">—</p>}
            </div>
          </div>
        </div>

        {/* ── E2. Model Intelligence ── */}
        {(pipeline?.segments || pipeline?.archetypes) && (
          <div className="ace-panel p-5">
            <SectionHead title="Model Intelligence" icon={Brain} />

            {/* Segmentation summary */}
            {pipeline.segments && (() => {
              const seg = pipeline.segments;
              const reg  = seg.by_regime?.["regular_season"];
              const play = seg.by_regime?.["playoffs"];
              const home = seg.by_direction?.["home"];
              const away = seg.by_direction?.["away"];
              return (
                <div>
                  <p className="text-[9px] text-[#4a524a] uppercase tracking-widest mb-3">
                    Model segmentation · {seg.sample_note}
                  </p>

                  {/* Regime split */}
                  <div className="grid grid-cols-2 gap-3 mb-4">
                    {[
                      { label: "Regular Season", s: reg },
                      { label: "Playoffs", s: play },
                    ].map(({ label, s }) => s && (
                      <div key={label} className="rounded-xl border border-[#22251f] bg-[#0d0f0d] p-3">
                        <p className="text-[9px] text-[#4a524a] uppercase tracking-widest mb-2">{label}</p>
                        <div className="flex gap-4 items-end">
                          <div>
                            <p className="text-[8px] text-[#4a524a] mb-0.5">win rate</p>
                            <p className="text-[22px] font-black font-mono leading-none"
                               style={{ color: winRateColor(s.win_rate) }}>
                              {s.win_rate !== null ? `${(s.win_rate * 100).toFixed(0)}%` : "—"}
                            </p>
                          </div>
                          <p className="text-[10px] text-[#4a524a] pb-0.5">n={s.n}</p>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Direction + calibration highlights */}
                  <div className="grid grid-cols-3 gap-3 mb-4">
                    {[
                      { label: "Home bets", s: home },
                      { label: "Away bets", s: away },
                      { label: "Bets only", s: seg.bets_only },
                    ].map(({ label, s }) => s && s.n > 0 && (
                      <div key={label} className="rounded-xl border border-[#22251f] bg-[#0d0f0d] p-3">
                        <p className="text-[9px] text-[#4a524a] uppercase tracking-widest mb-1">{label}</p>
                        <p className="text-[18px] font-black font-mono"
                           style={{ color: winRateColor(s.win_rate) }}>
                          {s.win_rate !== null ? `${(s.win_rate * 100).toFixed(0)}%` : "—"}
                        </p>
                        <p className="text-[9px] text-[#4a524a]">n={s.n}</p>
                      </div>
                    ))}
                  </div>

                  {/* Weak spots */}
                  {seg.weak_spots && seg.weak_spots.length > 0 && (
                    <div className="rounded-xl border border-[#ef4444]/15 bg-[#ef4444]/[0.03] p-3 mb-4">
                      <p className="text-[9px] font-bold text-[#ef4444] uppercase tracking-widest mb-2">Weak spots (win rate &lt; 40%)</p>
                      <div className="space-y-1">
                        {seg.weak_spots.map((w) => (
                          <div key={w.segment} className="flex items-center justify-between">
                            <span className="text-[10px] text-[#9ca39a] font-mono">{w.segment.replace("by_", "").replace(/_/g, " → ")}</span>
                            <span className="text-[10px] font-bold text-[#ef4444]">{(w.win_rate * 100).toFixed(0)}% <span className="text-[#4a524a] font-normal">n={w.n}</span></span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Calibration table */}
                  {seg.calibration && seg.calibration.length > 0 && (
                    <div>
                      <p className="text-[9px] text-[#4a524a] uppercase tracking-widest mb-2">Calibration — predicted vs actual win rate</p>
                      <div className="rounded-xl border border-[#1a1e1a] bg-[#0d0f0d] overflow-hidden">
                        <div className="grid grid-cols-[80px_40px_64px_72px_64px] gap-2 px-3 py-2 border-b border-[#22251f]">
                          {["Bucket","n","Predicted","Actual","Delta"].map(h => (
                            <span key={h} className="text-[8px] font-bold text-[#3a4033] uppercase tracking-widest">{h}</span>
                          ))}
                        </div>
                        {seg.calibration.map((r) => {
                          const over = r.delta < -0.05;
                          const under = r.delta > 0.05;
                          return (
                            <div key={r.conf_bucket} className="grid grid-cols-[80px_40px_64px_72px_64px] gap-2 items-center px-3 py-2 border-b border-[#0f110f] last:border-0">
                              <span className="text-[9px] font-mono text-[#9ca39a]">{r.conf_bucket}%</span>
                              <span className="text-[9px] text-[#6b7068]">{r.n}</span>
                              <span className="text-[9px] font-mono text-[#6b7068]">{(r.predicted_avg * 100).toFixed(1)}%</span>
                              <span className="text-[9px] font-mono font-bold"
                                    style={{ color: winRateColor(r.actual_win_rate) }}>
                                {(r.actual_win_rate * 100).toFixed(1)}%
                              </span>
                              <span className="text-[9px] font-mono font-bold"
                                    style={{ color: over ? "#ef4444" : under ? "#f5c062" : "#6b7068" }}>
                                {r.delta > 0 ? "+" : ""}{(r.delta * 100).toFixed(1)}%
                                {over && " ↑over"}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                      <p className="text-[9px] text-[#3a4033] mt-2">Overconfident = predicted higher than actual (↑over). Meaningful at n≥100.</p>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Team archetypes table */}
            {pipeline.archetypes && (() => {
              const teams = Object.entries(pipeline.archetypes).sort(([a], [b]) => a.localeCompare(b));
              const tierColor = (t: string) => {
                if (t === "elite" || t === "fast" || t === "high" || t === "high_assist" || t === "three_heavy" || t === "strong" || t === "road_capable") return "#3ee68a";
                if (t === "good" || t === "medium" || t === "balanced") return "#9ca39a";
                return "#ef4444";
              };
              return (
                <div className="mt-5">
                  <p className="text-[9px] text-[#4a524a] uppercase tracking-widest mb-3">Team archetypes — current season</p>
                  <div className="rounded-xl border border-[#1a1e1a] bg-[#0d0f0d] overflow-hidden">
                    <div className="grid grid-cols-[40px_72px_88px_64px_80px_56px_52px_52px] gap-1 px-3 py-2 border-b border-[#22251f]">
                      {["Team","Pace","Offense","Defense","Movement","Clutch","oRtg","dRtg"].map(h => (
                        <span key={h} className="text-[8px] font-bold text-[#3a4033] uppercase tracking-widest">{h}</span>
                      ))}
                    </div>
                    <div className="max-h-64 overflow-y-auto">
                      {teams.map(([code, a]) => (
                        <div key={code} className="grid grid-cols-[40px_72px_88px_64px_80px_56px_52px_52px] gap-1 items-center px-3 py-1.5 border-b border-[#0f110f] last:border-0">
                          <span className="text-[10px] font-bold text-white uppercase">{code}</span>
                          <span className="text-[9px] font-mono" style={{ color: tierColor(a.pace_tier) }}>{a.pace_tier}</span>
                          <span className="text-[9px] font-mono" style={{ color: tierColor(a.offense_style) }}>{a.offense_style.replace("_", " ")}</span>
                          <span className="text-[9px] font-mono" style={{ color: tierColor(a.defense_tier) }}>{a.defense_tier}</span>
                          <span className="text-[9px] font-mono" style={{ color: tierColor(a.ball_movement) }}>{a.ball_movement.replace("_", " ")}</span>
                          <span className="text-[9px] font-mono" style={{ color: tierColor(a.clutch) }}>{a.clutch}</span>
                          <span className="text-[9px] font-mono text-[#9ca39a]">{a.raw.ortg ?? "—"}</span>
                          <span className="text-[9px] font-mono text-[#9ca39a]">{a.raw.drtg ?? "—"}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {/* ── F. Multi-Book Line Tracking ── */}
        <div className="ace-panel p-5">
          <SectionHead title="Multi-Book Line Tracking" icon={Database} />

          {sig && !sig.error ? (
            <div>
              {/* Collection stats */}
              <div className="flex gap-3 mb-5">
                <Kpi
                  label="Book lines collected"
                  value={String(sig.book_lines?.total ?? 0)}
                  sub={`across ${sig.book_lines?.game_days ?? 0} game day(s)`}
                  color={(sig.book_lines?.total ?? 0) > 0 ? "#3ee68a" : "#6b7068"}
                />
                <Kpi
                  label="Divergences today/tomorrow"
                  value={String(sig.book_lines?.divergences?.length ?? 0)}
                  sub="soft book vs Pinnacle ≥0.5 pts"
                  color={(sig.book_lines?.divergences?.length ?? 0) > 0 ? "#f5c062" : "#6b7068"}
                />
              </div>

              {/* Divergence table */}
              {(sig.book_lines?.divergences?.length ?? 0) > 0 ? (
                <div>
                  <p className="text-[9px] text-[#4a524a] uppercase tracking-widest mb-2">
                    Current divergences vs Pinnacle
                  </p>
                  <div className="rounded-xl border border-[#1a1e1a] bg-[#0d0f0d] overflow-hidden">
                    {/* Header */}
                    <div className="grid grid-cols-[64px_1fr_90px_72px_72px_56px_60px] gap-2 px-3 py-2 border-b border-[#22251f]">
                      {["Date","Game","Pinnacle","Book","Line","Diff","Edge"].map(h => (
                        <span key={h} className="text-[8px] font-bold text-[#3a4033] uppercase tracking-widest">{h}</span>
                      ))}
                    </div>
                    {sig.book_lines.divergences.map((d, i) => {
                      const isPos = d.divergence > 0;
                      const edgeSide = isPos ? "home" : "away";
                      const diffColor = Math.abs(d.divergence) >= 1.0 ? "#f5c062" : "#9ca39a";
                      return (
                        <div key={i} className="grid grid-cols-[64px_1fr_90px_72px_72px_56px_60px] gap-2 items-center px-3 py-2 border-b border-[#0f110f] last:border-0">
                          <span className="text-[9px] text-[#6b7068]">{fmtDate(d.game_date)}</span>
                          <span className="text-[10px] text-[#9ca39a] truncate">{abbrevTeam(d.away)} @ {abbrevTeam(d.home)}</span>
                          <span className="text-[9px] font-mono text-[#6b7068]">{d.pinnacle_line > 0 ? "+" : ""}{d.pinnacle_line}</span>
                          <span className="text-[9px] text-[#6b7068] truncate">{d.book}</span>
                          <span className="text-[9px] font-mono text-[#9ca39a]">{d.book_line > 0 ? "+" : ""}{d.book_line}</span>
                          <span className="text-[9px] font-mono font-bold" style={{ color: diffColor }}>
                            {d.divergence > 0 ? "+" : ""}{d.divergence}
                          </span>
                          <span className="text-[8px] font-bold uppercase" style={{ color: diffColor }}>
                            {edgeSide}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-[9px] text-[#3a4033] mt-2">
                    Edge = side with better number at soft book vs Pinnacle.
                    Positive diff = home is easier to cover at soft book.
                    Data accumulates over time — more signal after 2–3 weeks.
                  </p>
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-[#22251f] bg-transparent p-4">
                  <p className="text-[11px] text-[#4a524a]">
                    {(sig.book_lines?.total ?? 0) === 0
                      ? "No book lines collected yet — will populate on next cron run."
                      : "No divergences ≥0.5 pts for today or tomorrow's games."}
                  </p>
                </div>
              )}
            </div>
          ) : (
            <p className="text-[11px] text-[#6b7068]">Signal data unavailable.</p>
          )}
        </div>

        {/* ── G. Picks Log ── */}
        {pipeline?.picks && pipeline.picks.length > 0 && (
          <div className="ace-panel p-5">
            <SectionHead title="Picks Log" icon={Database} />
            <p className="text-[10px] text-[#6b7068] mb-4">
              All model predictions · auto-updates each morning when grade cron runs · {pipeline.picks.length} total
            </p>

            {/* Column headers */}
            <div className="grid grid-cols-[60px_1fr_80px_44px_52px_36px_52px_44px] gap-2 px-3 pb-1.5 border-b border-[#22251f]">
              {["Date","Game","Pick","Conf","Edge","Bet","Status","Result"].map((h) => (
                <span key={h} className="text-[8px] font-bold text-[#3a4033] uppercase tracking-widest">{h}</span>
              ))}
            </div>

            <div className="divide-y divide-[#0f110f]">
              {pipeline.picks.map((p, i) => {
                const pickLine = p.line !== null
                  ? (p.side === "home" ? p.line : -p.line)
                  : null;
                const pickLabel = p.side === "home"
                  ? abbrevTeam(p.home)
                  : abbrevTeam(p.away);
                const lineStr = pickLine !== null
                  ? ` ${pickLine > 0 ? "+" : ""}${pickLine}`
                  : "";
                const resultColor = p.correct === 1 ? "#3ee68a" : p.correct === 0 ? "#ef4444" : "#6b7068";
                const resultLabel = p.correct === 1 ? "WIN" : p.correct === 0 ? "LOSS" : p.status === "pending" ? "–" : "PUSH";
                const edgeColor = p.edge !== null ? (p.edge >= 0.04 ? "#3ee68a" : p.edge <= -0.04 ? "#ef4444" : "#9ca39a") : "#3a4033";
                const rowBg = p.status === "pending" ? "bg-[#0d0f0d]" : "";

                return (
                  <div key={i} className={cn(
                    "grid grid-cols-[60px_1fr_80px_44px_52px_36px_52px_44px] gap-2 items-center px-3 py-2",
                    rowBg
                  )}>
                    <span className="text-[9px] text-[#6b7068]">{fmtDate(p.date)}</span>
                    <span className="text-[10px] text-[#9ca39a] truncate">{abbrevTeam(p.away)} @ {abbrevTeam(p.home)}</span>
                    <span className="text-[9px] font-mono text-white truncate">{pickLabel}{lineStr}</span>
                    <span className="text-[9px] font-mono text-[#6b7068]">{p.conf !== null ? `${(p.conf * 100).toFixed(0)}%` : "—"}</span>
                    <span className="text-[9px] font-mono" style={{ color: edgeColor }}>
                      {p.edge !== null ? `${p.edge >= 0 ? "+" : ""}${(p.edge * 100).toFixed(1)}pp` : "—"}
                    </span>
                    <span className={cn("text-[9px] font-bold", p.isBet ? "text-[#3ee68a]" : "text-[#3a4033]")}>
                      {p.isBet ? "✓" : "—"}
                    </span>
                    <span className={cn(
                      "text-[8px] uppercase tracking-widest font-semibold",
                      p.status === "pending" ? "text-[#f5c062]" : "text-[#4a524a]"
                    )}>{p.status}</span>
                    <span className="text-[9px] font-bold text-right" style={{ color: resultColor }}>{resultLabel}</span>
                  </div>
                );
              })}
            </div>

            <p className="text-[9px] text-[#3a4033] mt-3">
              Source: ml/nba_spread/data/model_performance.csv · Edge = model prob − Pinnacle implied prob · Bet = high-confidence flag (is_bet=1)
            </p>
          </div>
        )}

        {/* ── Footer ── */}
        <p className="text-[9px] text-[#27272a] text-center pb-4">
          ACE Ops · Internal only · Auto-refreshes every 60s · ml/logs · data/model_performance.csv · data/signal_log.db
        </p>
      </div>
    </div>
  );
}
