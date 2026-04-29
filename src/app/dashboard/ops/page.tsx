"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import {
  Activity, AlertTriangle, CheckCircle2, XCircle, Clock,
  Database, TrendingUp, Zap, RefreshCw, Terminal, Info,
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

interface PipelineData {
  jobs: { state: JobStatus; grade: JobStatus; fetch: JobStatus; snapshot: JobStatus; pregame: JobStatus };
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
  etToday: string;
  refreshedAt: string;
}

interface RecentSignal {
  id: number; game_date: string; home: string; away: string;
  side: string; line: number; clv: number | null; win: number | null;
  src: string | null;
}

interface SignalsData {
  by_status: Record<string, number>;
  total: number;
  clv: { avg: number | null; median: number | null; pct_positive: number | null; n: number; wins: number; total_graded: number };
  same_book: { clv: number | null; n: number };
  fallback:  { clv: number | null; n: number };
  today: { signals: number; snapshots: number; games: Array<{ home: string; away: string }> };
  stale: Array<{ id: number; game_date: string; home_team: string; away_team: string }>;
  open_signals: Array<{ id: number; game_date: string; home_team: string; away_team: string; bet_side: string; line_at_signal: number; status: string }>;
  recent_graded: RecentSignal[];
  et_today: string;
  edgeStatus: string;
  needFor30: number;
  error?: string;
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

// cronUtcHour: when the cron fires in UTC
function nextRun(cronUtcHour: number): string {
  const nowMs = Date.now();
  const now = new Date();
  const todayRun = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), cronUtcHour, 0, 0));
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
  const last = full.split(" ").at(-1) ?? full;
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

function JobCard({ name, cron, cronPdt, cronUtcHour, job }: {
  name: string; cron: string; cronPdt: string; cronUtcHour: number; job: JobStatus;
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
      <p className="text-[9px] text-[#4a524a] mt-1">next: {nextRun(cronUtcHour)}</p>
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
  const isFallback = s.src?.includes("fallback");
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

// ─── Main page ────────────────────────────────────────────────────────────────

export default function OpsPage() {
  const [pipeline, setPipeline] = useState<PipelineData | null>(null);
  const [signals,  setSignals]  = useState<SignalsData | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [perfTab, setPerfTab] = useState<"all" | "bets" | "conf" | "source">("all");

  useEffect(() => {
    async function load() {
      try {
        const [p, s] = await Promise.all([
          fetch("/api/ops/pipeline").then((r) => r.json()),
          fetch("/api/ops/signals").then((r) => r.json()),
        ]);
        setPipeline(p);
        setSignals(s);
        setLastRefresh(new Date());
      } catch (e) {
        console.error("ops load error", e);
      } finally {
        setLoading(false);
      }
    }
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  // Build alerts
  const alerts: Array<{ icon: React.ElementType; msg: string; color: string }> = [];
  if (pipeline) {
    if (pipeline.latestQuota !== null && pipeline.latestQuota < 60)
      alerts.push({ icon: AlertTriangle, msg: `API quota critical — ${pipeline.latestQuota} requests remaining`, color: "#ef4444" });
    else if (pipeline.latestQuota !== null && pipeline.latestQuota < 150)
      alerts.push({ icon: AlertTriangle, msg: `API quota low — ${pipeline.latestQuota} requests remaining`, color: "#f5c062" });
    const jobs = pipeline.jobs;
    if (jobs.state.hasError)    alerts.push({ icon: XCircle, msg: `Team state errored: ${jobs.state.errorSnippet}`, color: "#ef4444" });
    if (jobs.grade.hasError)    alerts.push({ icon: XCircle, msg: `Grade job errored: ${jobs.grade.errorSnippet}`, color: "#ef4444" });
    if (jobs.fetch.hasError)    alerts.push({ icon: XCircle, msg: `Fetch/predict errored: ${jobs.fetch.errorSnippet}`, color: "#ef4444" });
    if (jobs.snapshot.hasError) alerts.push({ icon: XCircle, msg: `Snapshot errored: ${jobs.snapshot.errorSnippet}`, color: "#ef4444" });
    if (jobs.snapshot.truncated && !jobs.snapshot.hasError)
      alerts.push({ icon: AlertTriangle, msg: "Snapshot output truncated — possible crash or power loss", color: "#f5c062" });
    if (jobs.fetch.truncated && !jobs.fetch.hasError)
      alerts.push({ icon: AlertTriangle, msg: "Fetch/predict output truncated", color: "#f5c062" });
    Object.entries(jobs).forEach(([key, j]) => {
      if (staleness(j.lastRunAt) === "stale")
        alerts.push({ icon: Clock, msg: `${key} job hasn't run in >2 days`, color: "#f5c062" });
    });
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

  const emptyJob: JobStatus = { lastRunAt: null, quotaRemaining: null, hasError: false, errorSnippet: null, truncated: false };

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
          <StatusDot label="State"    color={jobHealthColor(jobs?.state    ?? emptyJob)} />
          <StatusDot label="Grade"    color={jobHealthColor(jobs?.grade    ?? emptyJob)} />
          <StatusDot label="Fetch"    color={jobHealthColor(jobs?.fetch    ?? emptyJob)} />
          <StatusDot label="Snapshot" color={jobHealthColor(jobs?.snapshot ?? emptyJob)} />
          <StatusDot label="Pregame"  color={jobHealthColor(jobs?.pregame  ?? emptyJob)} />
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
          <div className="grid grid-cols-2 gap-3 mb-4">
            <JobCard name="update_team_state"    cronPdt="8:00am"  cron="daily" cronUtcHour={15} job={jobs?.state    ?? emptyJob} />
            <JobCard name="grade_results"        cronPdt="9:00am"  cron="daily" cronUtcHour={16} job={jobs?.grade    ?? emptyJob} />
            <JobCard name="fetch_and_predict"    cronPdt="12:00pm" cron="daily" cronUtcHour={19} job={jobs?.fetch    ?? emptyJob} />
            <JobCard name="snapshot --6pm_proxy" cronPdt="3:00pm"  cron="daily" cronUtcHour={22} job={jobs?.snapshot ?? emptyJob} />
            <JobCard name="snapshot --pregame"   cronPdt="4:15pm"  cron="daily" cronUtcHour={23} job={jobs?.pregame  ?? emptyJob} />
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

          {/* Open signals */}
          {sig?.open_signals && sig.open_signals.length > 0 && (
            <div>
              <p className="text-[9px] text-[#4a524a] uppercase tracking-widest mb-2">Open signals</p>
              <div className="space-y-1.5">
                {sig.open_signals.map((s) => (
                  <div key={s.id} className="flex items-center gap-3 rounded-lg border border-[#22251f] bg-[#0d0f0d] px-3 py-2">
                    <span className="text-[9px] text-[#6b7068] font-mono shrink-0">#{s.id}</span>
                    <span className="text-[10px] text-[#6b7068] shrink-0">{s.game_date}</span>
                    <span className="text-[10px] text-white flex-1">{abbrevTeam(s.away_team)} @ {abbrevTeam(s.home_team)}</span>
                    <span className="text-[9px] font-mono text-[#3ee68a]">{s.bet_side.toUpperCase()} {s.line_at_signal > 0 ? "+" : ""}{s.line_at_signal}</span>
                    <span className={cn(
                      "text-[8px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded border",
                      s.status === "proxy_captured"
                        ? "text-[#f5c062] border-[#f5c062]/20 bg-[#f5c062]/5"
                        : "text-[#6b7068] border-[#2e332a]"
                    )}>{s.status === "proxy_captured" ? "proxy ✓" : "open"}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!sig?.today?.games?.length && !sig?.open_signals?.length && (
            <p className="text-[11px] text-[#6b7068]">No game or signal data for today yet. Noon cron may not have run.</p>
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
              <p className="text-[9px] text-[#3a4033]">High-confidence bets = Pinnacle edge ≥4pp, or conf ≥ threshold when Pinnacle unavailable.</p>
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

              {/* CLV KPIs */}
              <div className="flex gap-3 mb-4">
                <Kpi label="Avg CLV"      value={fmtClv(sig.clv.avg)}    color={sig.clv.avg    !== null ? roiColor(sig.clv.avg)    : "#6b7068"} sub="pts vs closing" />
                <Kpi label="Median CLV"   value={fmtClv(sig.clv.median)} color={sig.clv.median !== null ? roiColor(sig.clv.median) : "#6b7068"} />
                <Kpi label="% Positive"   value={sig.clv.pct_positive !== null ? `${sig.clv.pct_positive}%` : "—"} color={sig.clv.pct_positive !== null ? winRateColor(sig.clv.pct_positive / 100) : "#6b7068"} />
                <Kpi label="CLV W/L"      value={`${sig.clv.wins}–${sig.clv.total_graded - sig.clv.wins}`} color={winRateColor(sig.clv.wins / (sig.clv.total_graded || 1))} />
              </div>

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
                  <p className="text-[20px] font-black font-mono" style={{ color: sig.same_book.clv !== null ? roiColor(sig.same_book.clv) : "#6b7068" }}>
                    {fmtClv(sig.same_book.clv)}
                  </p>
                  <p className="text-[9px] text-[#6b7068] mt-1">n={sig.same_book.n} · signal and close from same book</p>
                </div>
                <div className="rounded-xl border border-[#22251f] bg-[#0d0f0d] p-3">
                  <p className="text-[9px] text-[#4a524a] uppercase tracking-widest mb-1">Fallback CLV</p>
                  <p className="text-[20px] font-black font-mono" style={{ color: sig.fallback.clv !== null ? roiColor(sig.fallback.clv) : "#6b7068" }}>
                    {fmtClv(sig.fallback.clv)}
                  </p>
                  <p className="text-[9px] text-[#6b7068] mt-1">n={sig.fallback.n} · different book used at close</p>
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
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-xl border border-[#22251f] bg-[#0d0f0d] p-4">
              <p className="text-[9px] text-[#4a524a] uppercase tracking-widest mb-1">Model Predictions</p>
              <p className="text-[10px] text-[#6b7068] mb-3">All predictions logged by noon cron</p>
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

            <div className="rounded-xl border border-[#22251f] bg-[#0d0f0d] p-4">
              <p className="text-[9px] text-[#4a524a] uppercase tracking-widest mb-1">Line Movement</p>
              <p className="text-[10px] text-[#6b7068] mb-3">Auto-detected ≥1.5pt moves · 3pm cron</p>
              {sig && !sig.error ? (
                <>
                  <p className="text-[22px] font-black font-mono mb-1" style={{ color: edgeStatusColor(sig.edgeStatus) }}>
                    {sig.edgeStatus.toUpperCase()}
                  </p>
                  <p className="text-[10px] text-[#6b7068]">{sig.total} total · {sig.by_status["graded"] ?? 0} graded</p>
                  <p className="text-[10px] text-[#6b7068] mt-1">avg CLV: <span className="font-mono">{fmtClv(sig.clv.avg)}</span></p>
                </>
              ) : <p className="text-[11px] text-[#6b7068]">—</p>}
            </div>

            <div className="rounded-xl border border-dashed border-[#2e332a] bg-transparent p-4">
              <p className="text-[9px] text-[#3a4033] uppercase tracking-widest mb-1">Hybrid / Aligned</p>
              <p className="text-[10px] text-[#3a4033] mb-3">Model bet + line move on same game</p>
              <p className="text-[11px] text-[#3a4033] font-mono">TODO</p>
              <p className="text-[9px] text-[#3a4033] mt-2">Needs cross-ref of game_id across CSV and signal DB. Enable once signal volume warrants it.</p>
            </div>
          </div>
        </div>

        {/* ── F. Picks Log ── */}
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
