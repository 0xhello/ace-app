"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import {
  Activity, AlertTriangle, CheckCircle2, XCircle, Clock,
  Database, TrendingUp, Zap, RefreshCw, Terminal, Brain,
  BookMarked, PlusCircle, Target, BarChart2, Info,
  Radio, Eye,
} from "lucide-react";
import {
  KpiCard,
  SectionHead,
  Panel,
  ActionButton,
  WorkerStatusStrip,
  OpsPageHeader,
  StatusPill,
  OpsFooter,
  ErrorBanner,
  LoadingState,
  EmptyState,
  Tag,
  Dot,
  EngineInternals,
} from "@/components/ops/shared/primitives";

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
  overall: SegStats; bets_only: SegStats;
  by_regime: Record<string, SegStats>; by_direction: Record<string, SegStats>;
  by_rest: Record<string, SegStats>; by_conf_tier: Record<string, SegStats>;
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
interface WorkerStatus { lastPollAt: string | null; lastPollOk: boolean | null }
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
  etToday: string; refreshedAt: string;
}

interface RecentSignal {
  id: number; game_date: string; home: string; away: string;
  side: string; line: number; clv: number | null; win: number | null; src: string | null;
}
interface BookDivergence {
  game_date: string; home: string; away: string;
  pinnacle_line: number; book: string; book_line: number;
  divergence: number; snapshot_label: string;
}
interface SignalsData {
  by_status: Record<string, number>; total: number;
  clv: { avg: number | null; median: number | null; pct_positive: number | null; n: number; wins: number; total_graded: number };
  pinnacle_close: { clv: number | null; n: number };
  non_pinnacle_close: { clv: number | null; n: number };
  today: { signals: number; snapshots: number; games: Array<{ home: string; away: string }> };
  stale: Array<{ id: number; game_date: string; home_team: string; away_team: string }>;
  open_signals: Array<{ id: number; game_date: string; home_team: string; away_team: string; bet_side: string; line_at_signal: number; status: string; signal_type: string; home_cover_prob: number | null; edge_vs_pinnacle: number | null; kelly_fraction: number | null }>;
  recent_graded: RecentSignal[];
  book_lines: { total: number; game_days: number; divergences: BookDivergence[] };
  by_type: Record<string, { n: number; avg_clv: number | null; pct_pos: number | null; graded: number }>;
  et_today: string; edgeStatus: string; needFor30: number; error?: string;
}
interface Execution {
  id: number; signal_id: number; mode: "paper" | "real";
  book: string; signal_line: number; fill_line: number | null;
  bet_side: string; stake: number; outcome: 1 | 0 | null;
  pnl_units: number | null; notes: string; created_at: string; graded_at: string | null;
  home_team?: string; away_team?: string; game_date?: string; signal_type?: string;
  live_home_score?: number; live_away_score?: number;
  live_covering?: boolean | null; live_completed?: boolean;
  pick_side?: string | null; is_bet?: number | null;
}
interface ExecSummary {
  total: number; graded: number; pending: number;
  wins: number; losses: number; pushes: number;
  pnl_units: number | null; total_staked_units: number;
  start_units: number | null; current_units: number | null;
  roi_pct: number | null; unit_value: number;
}
interface ExecutionData {
  executions: Execution[];
  summary: { paper: ExecSummary; real: ExecSummary };
}
interface WatchedGame {
  game_id: string;
  home_team: string | null;
  away_team: string | null;
  game_date: string | null;
  bet_side: string | null;
  line: number | null;
  stake: number | null;
  exec_id: number | null;
  prob_for_side: number | null;
  edge_vs_pinnacle: number | null;
  source: "real_bet" | "watchlist" | "bet+watch";
  live_home_score: number | null;
  live_away_score: number | null;
  live_completed: boolean;
  has_scores: boolean;
  live_covering: boolean | null;
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

function nextRun(cronUtcHour: number, cronUtcMinute = 0): string {
  const nowMs = Date.now();
  const now = new Date();
  const todayRun = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), cronUtcHour, cronUtcMinute));
  const target = todayRun.getTime() > nowMs ? todayRun.getTime() : todayRun.getTime() + 86_400_000;
  const diff = target - nowMs;
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h === 0 && m < 5) return "any moment";
  if (h === 0) return `in ${m}m`;
  if (h < 24)  return `in ${h}h ${m}m`;
  return "tomorrow";
}

function fmtDate(d: string): string {
  const [, mo, day] = d.split("-");
  const months = ["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[parseInt(mo)]} ${parseInt(day)}`;
}
function fmtPct(v: number | null, dec = 1)  { return v !== null ? `${(v * 100).toFixed(dec)}%` : "—"; }
function fmtRoi(v: number | null)            { if (!v && v !== 0) return "—"; const s = (v*100).toFixed(1); return v >= 0 ? `+${s}%` : `${s}%`; }
function fmtClv(v: number | null)            { if (v === null) return "—"; return v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2); }
function fmtPnl(v: number | null)            { if (v === null) return "—"; return (v >= 0 ? "+" : "") + v.toFixed(2) + "u"; }
function fmtDollars(units: number | null, unitVal: number) {
  if (units === null) return "—";
  const d = units * unitVal;
  return (d >= 0 ? "+" : "") + "$" + Math.abs(d).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
const TEAM_CODE_LABELS: Record<string, string> = {
  atl: "Hawks", bos: "Celtics", bkn: "Nets", cha: "Hornets", chi: "Bulls",
  cle: "Cavaliers", dal: "Mavericks", den: "Nuggets", det: "Pistons", gs: "Warriors",
  hou: "Rockets", ind: "Pacers", lac: "Clippers", lal: "Lakers", mem: "Grizzlies",
  mia: "Heat", mil: "Bucks", min: "Timberwolves", no: "Pelicans", ny: "Knicks",
  okc: "Thunder", orl: "Magic", phi: "76ers", phx: "Suns", por: "Trail Blazers",
  sa: "Spurs", sac: "Kings", tor: "Raptors", utah: "Jazz", wsh: "Wizards",
};

function teamLabelFromCode(code: string) {
  return TEAM_CODE_LABELS[code.toLowerCase()] ?? code.toUpperCase();
}

function abbrevTeam(full: string)            { const p = full.split(" "); const l = p[p.length - 1]; return (l.length > 6 ? l.slice(0,3) : l).toUpperCase(); }

function kellyColor(k: number | null): string {
  if (k === null || k === 0) return "#3a4033";
  if (k >= 0.06) return "#3ee68a";
  if (k >= 0.03) return "#f5c062";
  return "#9ca39a";
}

function green(v: number | null) { return v !== null && v >= 0 ? "#3ee68a" : "#ef4444"; }
function winColor(v: number | null) { if (v === null) return "#6b7068"; return v >= 0.524 ? "#3ee68a" : v >= 0.48 ? "#f5c062" : "#ef4444"; }
function edgeColor(s: string) {
  if (s.startsWith("strong")) return "#3ee68a";
  if (s.startsWith("promising") || s.startsWith("inconclusive")) return "#f5c062";
  if (s === "bad") return "#ef4444";
  return "#6b7068";
}

function jobColor(job: JobStatus): string {
  if (job.hasError) return "#ef4444";
  if (job.truncated) return "#f5c062";
  const a = staleness(job.lastRunAt);
  return a === "ok" ? "#3ee68a" : a === "warn" ? "#f5c062" : a === "stale" ? "#ef4444" : "#6b7068";
}

function computeEdge(n: number, avg: number | null, pct: number | null): string {
  if (n < 30 || avg === null) return "accumulating";
  if (avg < 0) return "bad";
  const s = pct !== null && pct <= 50 ? "?" : "";
  if (avg < 0.5) return `inconclusive${s}`;
  if (avg < 1.0) return `promising${s}`;
  return `strong${s}`;
}

function sigLabel(t: string) {
  if (t === "soft_book_divergence") return "divergence";
  if (t === "line_movement") return "line move";
  if (t === "steam_move") return "steam";
  return t.replace(/_/g, " ");
}
function sigColor(t: string) {
  if (t === "soft_book_divergence") return "#3ee68a";
  if (t === "line_movement") return "#f5c062";
  if (t === "steam_move") return "#a78bfa";
  return "#9ca39a";
}

// ─── NBA-only primitives ─────────────────────────────────────────────────────
// Dot, Tag, KpiCard, SectionHead come from shared/primitives. The two helpers
// below (Num, Bar) are NBA-specific micro-helpers used inside the model
// performance and calibration panels.

function Num({ value, color, size = 28, sub }: { value: string; color?: string; size?: number; sub?: string }) {
  return (
    <div>
      <p className="font-black font-mono leading-none" style={{ fontSize: size, color: color ?? "#e4e4e7" }}>{value}</p>
      {sub && <p className="text-[9px] text-[#4a524a] mt-1.5">{sub}</p>}
    </div>
  );
}

function Bar({ wins, total, color }: { wins: number; total: number; color: string }) {
  const pct = total > 0 ? (wins / total) * 100 : 0;
  return (
    <div className="h-1.5 rounded-full bg-[#1a1e1a] overflow-hidden">
      <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function NBAOpsTab() {
  const [pipeline,    setPipeline]    = useState<PipelineData | null>(null);
  const [signals,     setSignals]     = useState<SignalsData | null>(null);
  const [execData,    setExecData]    = useState<ExecutionData | null>(null);
  const [loading,     setLoading]     = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [perfTab,     setPerfTab]     = useState<"all" | "bets" | "conf" | "source">("all");
  const [loggingBet,  setLoggingBet]  = useState<number | null>(null);
  const [liveWatch,   setLiveWatch]   = useState<WatchedGame[]>([]);
  const [running,     setRunning]     = useState<null | "fetch" | "grade" | "both">(null);

  async function loadAll() {
    try {
      const [p, s, e] = await Promise.all([
        fetch("/api/ops/pipeline").then(r => r.json()),
        fetch("/api/ops/signals").then(r => r.json()),
        fetch("/api/ops/execution").then(r => r.json()),
      ]);
      setPipeline(p); setSignals(s); setExecData(e);
      setLastRefresh(new Date());
    } catch (err) {
      console.error("ops load", err);
    } finally {
      setLoading(false);
    }
  }

  async function loadLiveWatch() {
    try {
      const r = await fetch("/api/ops/live-watch");
      if (r.ok) {
        const d = await r.json();
        setLiveWatch(d.games ?? []);
      }
    } catch {}
  }

  useEffect(() => {
    loadAll();
    loadLiveWatch();
    const t1 = setInterval(loadAll, 60_000);
    const t2 = setInterval(loadLiveWatch, 30_000);
    return () => { clearInterval(t1); clearInterval(t2); };
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
    } finally {
      setLoggingBet(null);
    }
  }

  async function runPipeline(job: "fetch" | "grade" | "both") {
    setRunning(job);
    try {
      // Blocking request — backend runs the job synchronously and returns when done.
      // Railway web services support up to 120s; grade takes ~15s, fetch ~60s.
      await fetch("/api/ops/pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job: job === "fetch" ? "fetch_and_predict" : job === "grade" ? "grade_results" : "both" }),
      });
    } catch {
      // Network error — still reload so we at least get fresh state
    } finally {
      await loadAll();
      setRunning(null);
    }
  }

  // ── Derived ──────────────────────────────────────────────────────────────────

  const m      = pipeline?.model;
  const sig    = signals;
  const jobs   = pipeline?.jobs;
  const worker = pipeline?.worker;
  const emptyJob: JobStatus = { lastRunAt: null, quotaRemaining: null, hasError: false, errorSnippet: null, truncated: false };

  function workerColor(w?: WorkerStatus) {
    if (!w) return "#6b7068";
    if (w.lastPollOk === false) return "#ef4444";
    if (!w.lastPollAt) return "#6b7068";
    const a = staleness(w.lastPollAt);
    return a === "ok" ? "#3ee68a" : a === "warn" ? "#f5c062" : "#ef4444";
  }
  const wColor = workerColor(worker);
  const wLive  = wColor === "#3ee68a";

  const quotaColor = pipeline?.latestQuota != null
    ? (pipeline.latestQuota < 60 ? "#ef4444" : pipeline.latestQuota < 150 ? "#f5c062" : "#3ee68a")
    : "#6b7068";

  const alerts: Array<{ icon: React.ElementType; msg: string; level: "error" | "warn" | "info" }> = [];
  if (pipeline) {
    if ((pipeline.latestQuota ?? 999) < 60)  alerts.push({ icon: AlertTriangle, msg: `API quota critical — ${pipeline.latestQuota} remaining`, level: "error" });
    else if ((pipeline.latestQuota ?? 999) < 150) alerts.push({ icon: AlertTriangle, msg: `API quota low — ${pipeline.latestQuota} remaining`, level: "warn" });
    if (jobs?.state.hasError)  alerts.push({ icon: XCircle, msg: `team_state error: ${jobs.state.errorSnippet}`, level: "error" });
    if (jobs?.grade.hasError)  alerts.push({ icon: XCircle, msg: `grade_results error: ${jobs.grade.errorSnippet}`, level: "error" });
    if (jobs?.fetch.hasError)  alerts.push({ icon: XCircle, msg: `fetch_and_predict error: ${jobs.fetch.errorSnippet}`, level: "error" });
    if (jobs?.fetch.truncated && !jobs.fetch.hasError) alerts.push({ icon: AlertTriangle, msg: "fetch_and_predict truncated — possible crash", level: "warn" });
    if (worker?.lastPollOk === false) alerts.push({ icon: XCircle, msg: "Worker last poll failed", level: "error" });
    if (worker?.lastPollAt && staleness(worker.lastPollAt) === "stale") alerts.push({ icon: AlertTriangle, msg: "Worker hasn't polled in >2 days", level: "warn" });
  }
  if (sig && !sig.error) {
    if (sig.stale.length > 0) alerts.push({ icon: AlertTriangle, msg: `${sig.stale.length} stale signal(s) pending auto-void`, level: "warn" });
    if ((sig.by_status["proxy_captured"] ?? 0) > 0) alerts.push({ icon: Info, msg: `${sig.by_status["proxy_captured"]} signal(s) awaiting game scores`, level: "info" });
  }

  const allOpenSignals   = sig?.open_signals ?? [];
  const paperBets        = execData?.executions.filter(e => e.mode === "paper") ?? [];
  const realBets         = execData?.executions.filter(e => e.mode === "real") ?? [];
  const signalTrack      = execData?.summary.paper;
  const realSummary      = execData?.summary.real;
  const today            = pipeline?.etToday ?? sig?.et_today ?? "—";

  // Split open signals: actionable (game today or future) vs awaiting grading (game already played)
  const actionableSignals = allOpenSignals.filter(s => s.game_date >= today);
  const awaitingSignals   = allOpenSignals.filter(s => s.game_date < today);

  if (loading) {
    return (
      <div className="flex-1 overflow-y-auto bg-[#0a0b0a] flex items-center justify-center">
        <div className="flex items-center gap-2 text-[#4a524a]">
          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          <span className="text-[12px]">Loading…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto bg-[#0a0b0a]">
      <div className="max-w-[1200px] mx-auto px-6 py-7 space-y-5">

        {/* Header — slim. Grade + Run Picks moved into Diagnostics
            (the worker runs them on schedule; manual triggers are debug-only). */}
        <OpsPageHeader
          icon={Terminal}
          title="NBA"
          tag={today}
          tagColor="#6b7068"
          actions={
            <ActionButton
              icon={RefreshCw}
              variant="subtle"
              label={lastRefresh ? `${Math.round((Date.now() - lastRefresh.getTime()) / 1000)}s` : "—"}
              onClick={loadAll}
            />
          }
        />

        {/* ══ STATUS STRIP ════════════════════════════════════════════════════ */}
        <div className="flex items-center gap-4 rounded-xl border border-[#181c18] bg-[#0d0f0d] px-4 py-3 flex-wrap gap-y-2">
          {[
            { label: "Worker",  color: wColor,                          live: wLive },
            { label: "State",   color: jobColor(jobs?.state ?? emptyJob), live: false },
            { label: "Grade",   color: jobColor(jobs?.grade ?? emptyJob), live: false },
            { label: "Fetch",   color: jobColor(jobs?.fetch ?? emptyJob), live: false },
          ].map(({ label, color, live }) => (
            <div key={label} className="flex items-center gap-1.5">
              <Dot color={color} pulse={live} />
              <span className="text-[10px] text-[#6b7068]">{label}</span>
            </div>
          ))}

          <div className="h-3 w-px bg-[#1e2220]" />

          <div className="flex items-center gap-2">
            <span className="text-[9px] text-[#3a4033]">quota</span>
            <div className="w-16 h-1 rounded-full bg-[#1a1e1a]">
              {pipeline?.latestQuota != null && (
                <div className="h-full rounded-full" style={{ width: `${(pipeline.latestQuota / 500) * 100}%`, background: quotaColor }} />
              )}
            </div>
            <span className="text-[10px] font-mono" style={{ color: quotaColor }}>{pipeline?.latestQuota ?? "—"}</span>
          </div>

          <div className="h-3 w-px bg-[#1e2220]" />

          <div className="flex items-center gap-1.5">
            <span className="text-[9px] text-[#3a4033]">edge</span>
            <span className="text-[10px] font-bold font-mono" style={{ color: edgeColor(sig?.edgeStatus ?? "") }}>
              {sig?.edgeStatus?.toUpperCase() ?? "—"}
            </span>
            {sig && !sig.error && sig.clv.n < 30 && (
              <span className="text-[9px] text-[#2e3328]">({sig.clv.n}/30)</span>
            )}
          </div>

          {alerts.length > 0 && (
            <>
              <div className="h-3 w-px bg-[#1e2220]" />
              <div className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-[#f5c062] animate-pulse" />
                <span className="text-[9px] font-bold text-[#f5c062]">{alerts.length} alert{alerts.length !== 1 ? "s" : ""}</span>
              </div>
            </>
          )}
        </div>

        {/* ══ ALERTS ══════════════════════════════════════════════════════════ */}
        {alerts.length > 0 && (
          <div className="rounded-xl border border-[#f5c062]/20 bg-[#f5c062]/[0.03] px-4 py-3.5 space-y-2">
            {alerts.map((a, i) => {
              const c = a.level === "error" ? "#ef4444" : a.level === "warn" ? "#f5c062" : "#6b7068";
              return (
                <div key={i} className="flex items-start gap-2.5">
                  <a.icon className="h-3.5 w-3.5 shrink-0 mt-0.5" style={{ color: c }} />
                  <p className="text-[11px] text-[#c4c7c0]">{a.msg}</p>
                </div>
              );
            })}
          </div>
        )}


        {/* ══ PERFORMANCE — Paper Bankroll ═════════════════════════════════════ */}
        {signalTrack && (
          <div className="rounded-xl border border-[#1e2220] bg-[#0d0f0d] px-5 py-4">
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div>
                <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-[#3a4033] mb-1">Paper Bankroll</p>
                <div className="flex items-baseline gap-2">
                  <p className="text-[28px] font-black font-mono leading-none"
                     style={{ color: signalTrack.current_units !== null && signalTrack.current_units >= signalTrack.start_units! ? "#3ee68a" : "#ef4444" }}>
                    ${((signalTrack.current_units ?? signalTrack.start_units!) * signalTrack.unit_value).toLocaleString()}
                  </p>
                  {signalTrack.pnl_units !== null && signalTrack.pnl_units !== 0 && (
                    <p className="text-[13px] font-bold font-mono pb-0.5" style={{ color: green(signalTrack.pnl_units) }}>
                      {fmtDollars(signalTrack.pnl_units, signalTrack.unit_value)}
                    </p>
                  )}
                </div>
                <p className="text-[10px] text-[#4a524a] mt-1">
                  Started at ${(signalTrack.start_units! * signalTrack.unit_value).toLocaleString()} · ${signalTrack.unit_value}/unit flat
                </p>
              </div>

              <div className="flex items-center gap-6">
                <div className="text-center">
                  <p className="text-[9px] text-[#3a4033] uppercase tracking-wider mb-1">Record</p>
                  {signalTrack.graded > 0 ? (
                    <p className="text-[16px] font-black font-mono" style={{ color: winColor(signalTrack.wins / signalTrack.graded) }}>
                      {signalTrack.wins}W–{signalTrack.losses}L{signalTrack.pushes > 0 ? `–${signalTrack.pushes}P` : ""}
                    </p>
                  ) : (
                    <p className="text-[16px] font-black font-mono text-[#3a4033]">—</p>
                  )}
                  {signalTrack.pending > 0 && (
                    <p className="text-[9px] text-[#4a524a]">{signalTrack.pending} pending</p>
                  )}
                </div>
                <div className="text-center">
                  <p className="text-[9px] text-[#3a4033] uppercase tracking-wider mb-1">Win rate</p>
                  <p className="text-[16px] font-black font-mono"
                     style={{ color: signalTrack.graded > 0 ? winColor(signalTrack.wins / signalTrack.graded) : "#3a4033" }}>
                    {signalTrack.graded > 0 ? fmtPct(signalTrack.wins / signalTrack.graded, 0) : "—"}
                  </p>
                </div>
                <div className="text-center">
                  <p className="text-[9px] text-[#3a4033] uppercase tracking-wider mb-1">Staked</p>
                  <p className="text-[16px] font-black font-mono text-[#6b7068]">
                    ${(signalTrack.total_staked_units * signalTrack.unit_value).toLocaleString()}
                  </p>
                </div>
                {signalTrack.roi_pct !== null && (
                  <div className="text-center">
                    <p className="text-[9px] text-[#3a4033] uppercase tracking-wider mb-1">ROI on staked</p>
                    <p className="text-[16px] font-black font-mono" style={{ color: green(signalTrack.roi_pct) }}>
                      {signalTrack.roi_pct >= 0 ? "+" : ""}{signalTrack.roi_pct.toFixed(1)}%
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ══ PERFORMANCE — Paper Bet History ════════════════════════════════ */}
        {paperBets.length > 0 && signalTrack && (
          <div className="rounded-xl border border-[#1e2220] bg-[#0d0f0d] overflow-hidden">
            <div className="px-4 py-2.5 border-b border-[#181c18]">
              <span className="text-[9px] font-bold uppercase tracking-[0.18em] text-[#3a4033]">Paper Bet History</span>
            </div>
            <div className="grid grid-cols-[40px_52px_1fr_76px_60px_52px_56px_72px] gap-2 px-4 py-2 border-b border-[#181c18]">
              {["#", "Date", "Game", "Side", "Book", "Line", "Stake", "P&L"].map(h => (
                <span key={h} className="text-[8px] font-bold uppercase tracking-[0.14em] text-[#2e3328]">{h}</span>
              ))}
            </div>
            {paperBets.map((e) => {
              const isPush = e.graded_at !== null && e.outcome === null;
              const oColor = e.outcome === 1 ? "#3ee68a" : e.outcome === 0 ? "#ef4444" : isPush ? "#6b7068" : "#3a4033";
              const pnlDollars = e.pnl_units !== null ? e.pnl_units * signalTrack.unit_value : null;
              const stakeDollars = e.stake * signalTrack.unit_value;
              const line = e.fill_line ?? e.signal_line;
              // Use pick_side (model's endorsement) for display; fall back to bet_side.
              // is_bet=0 means the model rejected this signal — mark it clearly.
              const modelRejected = e.is_bet === 0;
              const displaySide = e.pick_side ?? e.bet_side;
              const dLine = displaySide === "home" ? line : -line;

              // Live status for open bets
              const hasLive = e.graded_at === null && e.live_home_score !== undefined && e.live_away_score !== undefined;
              const liveLabel = hasLive
                ? (e.live_completed ? "FINAL" : "LIVE")
                : null;
              const liveCover = hasLive ? e.live_covering : undefined;
              const liveColor = liveCover === true ? "#3ee68a" : liveCover === false ? "#ef4444" : "#6b7068";
              const liveScore = hasLive
                ? (displaySide === "home"
                    ? `${e.live_home_score}-${e.live_away_score}`
                    : `${e.live_away_score}-${e.live_home_score}`)
                : null;
              const isPastGame = e.game_date ? e.game_date < today : false;

              return (
                <div key={e.id} className={`grid grid-cols-[40px_52px_1fr_76px_60px_52px_56px_72px] gap-2 items-center px-4 py-2.5 border-b border-[#0d0f0d] last:border-0 hover:bg-[#111412] transition-colors ${modelRejected ? "opacity-50" : ""}`}>
                  <span className="text-[9px] text-[#2e3328] font-mono">#{e.signal_id}</span>
                  <span className="text-[9px] text-[#4a524a]">{e.game_date ? fmtDate(e.game_date) : "—"}</span>
                  <span className="text-[10px] text-[#9ca39a] truncate">
                    {e.away_team && e.home_team ? `${abbrevTeam(e.away_team)} @ ${abbrevTeam(e.home_team)}` : "—"}
                  </span>
                  <span className="text-[10px] font-bold font-mono" style={{ color: modelRejected ? "#6b7068" : "white" }}>
                    {displaySide === "home" ? abbrevTeam(e.home_team ?? "") : abbrevTeam(e.away_team ?? "")} {dLine > 0 ? "+" : ""}{dLine}
                    {modelRejected && <span className="ml-1 text-[8px] text-[#ef4444] font-bold">✗ rejected</span>}
                  </span>
                  <span className="text-[9px] text-[#4a524a] truncate">{e.book || "—"}</span>
                  <span className="text-[9px] font-mono text-[#6b7068]">{dLine > 0 ? "+" : ""}{dLine}</span>
                  <span className="text-[9px] font-mono text-[#6b7068]">${stakeDollars.toLocaleString()}</span>
                  <span className="text-[10px] font-bold font-mono text-right" style={{ color: hasLive ? liveColor : oColor }}>
                    {e.graded_at !== null
                      ? (isPush ? <span>push</span>
                          : pnlDollars !== null
                            ? `${pnlDollars >= 0 ? "+" : ""}$${Math.abs(pnlDollars).toFixed(0)}`
                            : e.outcome === 1 ? "WIN" : "LOSS")
                      : hasLive
                        ? <span className="flex flex-col items-end gap-0.5">
                            <span className="text-[8px] opacity-60">{liveLabel} {liveCover === true ? "✓" : liveCover === false ? "✗" : "·"}</span>
                            <span>{liveScore}</span>
                          </span>
                        : isPastGame
                          ? <span className="text-[#4a524a]">grading…</span>
                          : <span className="text-[#3a4033]">open</span>}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* ══ TODAY — Live Watch ════════════════════════════════════════════════ */}
        {liveWatch.length > 0 && (
          <div className="ace-panel p-5">
            <SectionHead
              title="Live Watch"
              icon={Radio}
              right={
                <button onClick={loadLiveWatch} className="text-[9px] text-[#3a4033] hover:text-[#6b7068] flex items-center gap-1.5 transition-colors">
                  <RefreshCw className="h-3 w-3" /> refresh
                </button>
              }
            />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {liveWatch.map((g) => {
                const isLive = g.has_scores && !g.live_completed;
                const isFinal = g.has_scores && g.live_completed;
                const hasBet = g.bet_side !== null;
                const betTeam = hasBet ? (g.bet_side === "home" ? g.home_team : g.away_team) : null;
                const oppTeam = hasBet ? (g.bet_side === "home" ? g.away_team : g.home_team) : null;
                const betScore = hasBet ? (g.bet_side === "home" ? g.live_home_score : g.live_away_score) : null;
                const oppScore = hasBet ? (g.bet_side === "home" ? g.live_away_score : g.live_home_score) : null;
                const coverColor = g.live_covering === true ? "#3ee68a" : g.live_covering === false ? "#ef4444" : "#6b7068";
                const coverText  = g.live_covering === true ? "COVERING ✓" : g.live_covering === false ? "NOT COVERING ✗" : "PUSH ~";
                const borderColor = g.live_covering === true ? "border-[#3ee68a]/25" : g.live_covering === false ? "border-[#ef4444]/20" : "border-[#1e2220]";
                return (
                  <div key={g.game_id} className={`rounded-xl border bg-[#0d0f0d] p-4 ${borderColor}`}>
                    {/* Header: status badge + matchup */}
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-[10px] font-medium text-[#9ca39a]">
                        {g.away_team ? `${abbrevTeam(g.away_team)} @ ${abbrevTeam(g.home_team ?? "")}` : g.game_id.slice(0, 8)}
                      </span>
                      <span className={`text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md ${
                        isLive  ? "text-[#3ee68a] bg-[#3ee68a]/10 animate-pulse" :
                        isFinal ? "text-[#6b7068] bg-[#1a1e1a]" :
                                  "text-[#f5c062] bg-[#f5c062]/10"
                      }`}>
                        {isLive ? "● LIVE" : isFinal ? "FINAL" : "upcoming"}
                      </span>
                    </div>

                    {/* Score — bet side first */}
                    {g.has_scores && hasBet ? (
                      <div className="flex items-baseline gap-3 mb-3">
                        <div className="flex flex-col items-center">
                          <span className="text-[8px] text-[#4a524a] uppercase tracking-wider mb-0.5">YOUR SIDE</span>
                          <span className="text-[32px] font-black font-mono leading-none text-white">{betScore ?? "—"}</span>
                          <span className="text-[9px] text-[#6b7068] mt-0.5">{betTeam ? abbrevTeam(betTeam) : "—"}</span>
                        </div>
                        <span className="text-[20px] font-black text-[#2e3328] self-center">–</span>
                        <div className="flex flex-col items-center">
                          <span className="text-[8px] text-[#4a524a] uppercase tracking-wider mb-0.5">OPP</span>
                          <span className="text-[32px] font-black font-mono leading-none text-[#6b7068]">{oppScore ?? "—"}</span>
                          <span className="text-[9px] text-[#4a524a] mt-0.5">{oppTeam ? abbrevTeam(oppTeam) : "—"}</span>
                        </div>
                        <div className="flex-1 flex flex-col items-end justify-center gap-1">
                          {g.line !== null && (
                            <span className="text-[10px] font-bold font-mono text-white">
                              {betTeam ? abbrevTeam(betTeam) : ""} {(() => { const dl = g.bet_side === "home" ? g.line : -g.line; return `${dl > 0 ? "+" : ""}${dl}`; })()}
                            </span>
                          )}
                          <span className="text-[10px] font-bold" style={{ color: coverColor }}>{coverText}</span>
                          {g.line !== null && betScore !== null && oppScore !== null && (
                            <span className="text-[9px] text-[#4a524a] font-mono">
                              margin {g.bet_side === "home"
                                ? ((betScore - oppScore) + g.line > 0 ? "+" : "") + ((betScore - oppScore) + g.line).toFixed(1)
                                : ((betScore - oppScore) - g.line > 0 ? "+" : "") + ((betScore - oppScore) - g.line).toFixed(1)} vs spread
                            </span>
                          )}
                        </div>
                      </div>
                    ) : g.has_scores ? (
                      /* watchlist-only game — no bet, just score */
                      <div className="flex items-baseline gap-2 mb-3">
                        <span className="text-[28px] font-black font-mono text-white">{g.live_away_score}</span>
                        <span className="text-[16px] font-black text-[#2e3328]">–</span>
                        <span className="text-[28px] font-black font-mono text-[#6b7068]">{g.live_home_score}</span>
                        <span className="text-[9px] text-[#4a524a] ml-1">{g.away_team ? abbrevTeam(g.away_team) : ""} / {g.home_team ? abbrevTeam(g.home_team) : ""}</span>
                      </div>
                    ) : (
                      <div className="py-2 mb-3">
                        <p className="text-[10px] text-[#3a4033]">Score not yet available</p>
                      </div>
                    )}

                    {/* Model intel row */}
                    {(g.prob_for_side !== null || g.edge_vs_pinnacle !== null) && (
                      <div className="flex items-center gap-4 pt-2.5 border-t border-[#141714]">
                        <span className="text-[8px] text-[#2e3328] uppercase tracking-wider">ACE Intel</span>
                        {g.prob_for_side !== null && (
                          <div className="flex items-center gap-1">
                            <span className="text-[8px] text-[#3a4033]">prob</span>
                            <span className="text-[10px] font-bold font-mono text-white">{(g.prob_for_side * 100).toFixed(1)}%</span>
                          </div>
                        )}
                        {g.edge_vs_pinnacle !== null && (
                          <div className="flex items-center gap-1">
                            <span className="text-[8px] text-[#3a4033]">edge</span>
                            <span className="text-[10px] font-bold font-mono"
                              style={{ color: g.edge_vs_pinnacle > 0 ? "#3ee68a" : "#ef4444" }}>
                              {g.edge_vs_pinnacle >= 0 ? "+" : ""}{(g.edge_vs_pinnacle * 100).toFixed(1)}pp
                            </span>
                          </div>
                        )}
                        {g.source === "real_bet" || g.source === "bet+watch" ? (
                          <span className="ml-auto text-[8px] font-bold text-[#3a4033] uppercase tracking-wider">real $</span>
                        ) : (
                          <span className="ml-auto text-[8px] text-[#2e3328] uppercase tracking-wider flex items-center gap-1">
                            <Eye className="h-2.5 w-2.5" /> watching
                          </span>
                        )}
                      </div>
                    )}
                    {g.prob_for_side === null && g.edge_vs_pinnacle === null && (
                      <div className="pt-2.5 border-t border-[#141714] flex items-center justify-between">
                        <span className="text-[8px] text-[#2e3328]">No model data</span>
                        {(g.source === "real_bet" || g.source === "bet+watch") && (
                          <span className="text-[8px] font-bold text-[#3a4033] uppercase tracking-wider">real $</span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="text-[8px] text-[#2e3328] mt-3">
              Auto-refreshes every 30s · Star games on the board or log a bet to track here
            </p>
          </div>
        )}

        {/* ══ TODAY — Signals + Slate ══════════════════════════════════════════ */}
        <div className="ace-panel p-5">
          <SectionHead
            title={`Today · ${today}`}
            icon={Zap}
            right={
              <div className="flex items-center gap-3">
                {sig?.today?.signals ? <Tag label={`${sig.today.signals} signal${sig.today.signals !== 1 ? "s" : ""}`} color="#3ee68a" /> : null}
                {sig?.today?.games?.length ? <span className="text-[10px] text-[#4a524a]">{sig.today.games.length} games</span> : null}
              </div>
            }
          />

          {/* Slate chips */}
          {sig?.today?.games && sig.today.games.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-5">
              {sig.today.games.map((g, i) => (
                <div key={i} className="flex items-center gap-1.5 rounded-lg border border-[#1e2220] bg-[#0d0f0d] px-3 py-1.5">
                  <span className="text-[10px] text-[#6b7068]">{abbrevTeam(g.away)}</span>
                  <span className="text-[9px] text-[#2e3328]">@</span>
                  <span className="text-[10px] font-bold text-white">{abbrevTeam(g.home)}</span>
                </div>
              ))}
            </div>
          )}

          {/* Open signals — the action items */}
          {actionableSignals.length > 0 ? (
            <div>
              <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-[#3a4033] mb-3">
                Open signals — review and log if betting
              </p>
              <div className="space-y-2">
                {actionableSignals.map((s) => {
                  const logged = realBets.some(e => e.signal_id === s.id);
                  const probForSide = s.home_cover_prob !== null
                    ? (s.bet_side === "home" ? s.home_cover_prob : 1 - s.home_cover_prob)
                    : null;
                  const halfKelly = s.kelly_fraction !== null ? s.kelly_fraction / 2 : null;
                  return (
                    <div key={s.id} className="rounded-xl border border-[#1e2220] bg-[#0d0f0d] px-4 py-3">
                      <div className="flex items-center gap-3">
                        <span className="text-[9px] text-[#2e3328] font-mono w-8 shrink-0">#{s.id}</span>
                        <span className="text-[9px] text-[#4a524a] shrink-0 w-16">{s.game_date}</span>
                        <span className="text-[11px] font-medium text-white flex-1 min-w-0 truncate">
                          {abbrevTeam(s.away_team)} @ {abbrevTeam(s.home_team)}
                        </span>
                        <span className="text-[11px] font-bold font-mono shrink-0" style={{ color: sigColor(s.signal_type) }}>
                          {s.bet_side === "home" ? abbrevTeam(s.home_team) : abbrevTeam(s.away_team)} {(() => { const dl = s.bet_side === "home" ? s.line_at_signal : -s.line_at_signal; return `${dl > 0 ? "+" : ""}${dl}`; })()}
                        </span>
                        <Tag label={sigLabel(s.signal_type)} color={sigColor(s.signal_type)} />
                        {s.status === "proxy_captured" && <Tag label="proxy ✓" color="#f5c062" />}
                        {logged ? (
                          <span className="text-[9px] font-bold text-[#3ee68a] w-16 text-right shrink-0">BET LOGGED ✓</span>
                        ) : (
                          <button
                            onClick={() => logRealBet(s.id)}
                            disabled={loggingBet === s.id}
                            className="flex items-center gap-1.5 text-[9px] font-bold text-[#f5c062] border border-[#f5c062]/25 rounded-lg px-2.5 py-1.5 hover:bg-[#f5c062]/8 active:bg-[#f5c062]/15 transition-colors disabled:opacity-40 shrink-0"
                          >
                            <PlusCircle className="h-3 w-3" />
                            {loggingBet === s.id ? "Logging…" : "Log Bet"}
                          </button>
                        )}
                      </div>
                      {/* Kelly sizing row */}
                      {(probForSide !== null || s.edge_vs_pinnacle !== null) && (
                        <div className="flex items-center gap-5 mt-2 pt-2 border-t border-[#141714]">
                          {probForSide !== null && (
                            <div className="flex items-center gap-1.5">
                              <span className="text-[8px] text-[#2e3328] uppercase tracking-wider">Model prob</span>
                              <span className="text-[10px] font-bold font-mono text-white">{(probForSide * 100).toFixed(1)}%</span>
                            </div>
                          )}
                          {s.edge_vs_pinnacle !== null && (
                            <div className="flex items-center gap-1.5">
                              <span className="text-[8px] text-[#2e3328] uppercase tracking-wider">Edge vs Pin</span>
                              <span className="text-[10px] font-bold font-mono" style={{ color: green(s.edge_vs_pinnacle) }}>
                                {s.edge_vs_pinnacle >= 0 ? "+" : ""}{(s.edge_vs_pinnacle * 100).toFixed(1)}pp
                              </span>
                            </div>
                          )}
                          {halfKelly !== null && halfKelly > 0 && (
                            <div className="flex items-center gap-1.5">
                              <span className="text-[8px] text-[#2e3328] uppercase tracking-wider">½ Kelly</span>
                              <span className="text-[10px] font-bold font-mono" style={{ color: kellyColor(halfKelly) }}>
                                {(halfKelly * 100).toFixed(1)}%
                              </span>
                              <span className="text-[9px] text-[#3a4033]">of bankroll</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center rounded-xl border border-dashed border-[#1e2220] py-8">
              <p className="text-[11px] text-[#3a4033]">
                {sig?.error ? "Signal data unavailable" : "No open signals right now"}
              </p>
            </div>
          )}

          {/* Awaiting results — signals from past games not yet graded */}
          {awaitingSignals.length > 0 && (
            <div className="mt-4">
              <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-[#3a4033] mb-3">
                Awaiting grade — games played, results pending
              </p>
              <div className="space-y-1.5">
                {awaitingSignals.map((s) => (
                  <div key={s.id} className="rounded-xl border border-[#1a1d1a] bg-[#0d0f0d] px-4 py-2.5 flex items-center gap-3 opacity-60">
                    <span className="text-[9px] text-[#2e3328] font-mono w-8 shrink-0">#{s.id}</span>
                    <span className="text-[9px] text-[#4a524a] shrink-0 w-16">{s.game_date}</span>
                    <span className="text-[10px] text-[#6b7068] flex-1 min-w-0 truncate">
                      {abbrevTeam(s.away_team)} @ {abbrevTeam(s.home_team)}
                    </span>
                    <span className="text-[10px] font-bold font-mono" style={{ color: sigColor(s.signal_type) }}>
                      {s.bet_side === "home" ? abbrevTeam(s.home_team) : abbrevTeam(s.away_team)} {(() => { const dl = s.bet_side === "home" ? s.line_at_signal : -s.line_at_signal; return `${dl > 0 ? "+" : ""}${dl}`; })()}
                    </span>
                    <span className="flex items-center gap-1 text-[8px] font-bold text-[#4a524a] uppercase tracking-wider shrink-0">
                      <Clock className="h-2.5 w-2.5" /> grading pending
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Signal funnel summary */}
          {sig && !sig.error && (
            <div className="flex items-center gap-6 mt-5 pt-4 border-t border-[#181c18]">
              <span className="text-[9px] text-[#2e3328] uppercase tracking-widest shrink-0">All-time pipeline</span>
              {[
                { label: "Open",    val: sig.by_status["open"] ?? 0,           color: "#f5c062" },
                { label: "Proxy",   val: sig.by_status["proxy_captured"] ?? 0, color: "#9ca39a" },
                { label: "Graded",  val: sig.by_status["graded"] ?? 0,         color: "#3ee68a" },
                { label: "Voided",  val: sig.by_status["no_action"] ?? 0,      color: "#3a4033" },
              ].map(({ label, val, color }) => (
                <div key={label} className="flex items-center gap-1.5">
                  <span className="text-[14px] font-black font-mono leading-none" style={{ color }}>{val}</span>
                  <span className="text-[9px] text-[#3a4033]">{label}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ══ MY BETS ══════════════════════════════════════════════════════════ */}
        <div className="ace-panel p-5">
          <SectionHead title="My Bets" icon={Target} />

          {realSummary && realSummary.total > 0 ? (
            <div>
              {/* Summary row */}
              <div className="flex gap-4 items-end mb-6">
                <div>
                  <p className="text-[9px] text-[#3a4033] uppercase tracking-wider mb-1.5">Total logged</p>
                  <Num value={String(realSummary.total)} size={40} />
                </div>
                {realSummary.graded > 0 && (
                  <>
                    <div>
                      <p className="text-[9px] text-[#3a4033] uppercase tracking-wider mb-1.5">Record</p>
                      <Num value={`${realSummary.wins}–${realSummary.losses}`} size={40} color={winColor(realSummary.wins / realSummary.graded)} />
                    </div>
                    <div>
                      <p className="text-[9px] text-[#3a4033] uppercase tracking-wider mb-1.5">Win rate</p>
                      <Num value={fmtPct(realSummary.wins / realSummary.graded)} size={40} color={winColor(realSummary.wins / realSummary.graded)} />
                    </div>
                    <div>
                      <p className="text-[9px] text-[#3a4033] uppercase tracking-wider mb-1.5">P&amp;L</p>
                      <Num
                        value={fmtDollars(realSummary.pnl_units, realSummary.unit_value)}
                        size={40}
                        color={green(realSummary.pnl_units)}
                        sub={`${fmtPnl(realSummary.pnl_units)} · ${realSummary.roi_pct !== null ? `${realSummary.roi_pct >= 0 ? "+" : ""}${realSummary.roi_pct.toFixed(1)}% ROI` : "—"}`}
                      />
                    </div>
                  </>
                )}
                {realSummary.graded < realSummary.total && (
                  <div className="pb-1">
                    <span className="text-[10px] text-[#4a524a]">{realSummary.total - realSummary.graded} pending</span>
                  </div>
                )}
              </div>

              {/* Bet log */}
              <div className="rounded-xl border border-[#181c18] bg-[#0d0f0d] overflow-hidden">
                <div className="grid grid-cols-[36px_52px_1fr_72px_56px_44px_52px_56px] gap-2 px-4 py-2.5 border-b border-[#181c18]">
                  {["#", "Date", "Game", "Side", "Book", "Line", "Stake", "P&L"].map(h => (
                    <span key={h} className="text-[8px] font-bold uppercase tracking-[0.14em] text-[#2e3328]">{h}</span>
                  ))}
                </div>
                {realBets.slice(0, 30).map((e) => {
                  const isPush = e.graded_at !== null && e.outcome === null;
                  const oColor = e.outcome === 1 ? "#3ee68a" : e.outcome === 0 ? "#ef4444" : isPush ? "#6b7068" : "#3a4033";
                  const line = e.fill_line ?? e.signal_line;
                  const displaySide = e.pick_side ?? e.bet_side;
                  const dLine = displaySide === "home" ? line : -line;
                  const unitVal = realSummary?.unit_value ?? 100;
                  const stakeDollars = e.stake * unitVal;
                  const pnlDollars = e.pnl_units !== null ? e.pnl_units * unitVal : null;
                  return (
                    <div key={e.id} className="grid grid-cols-[36px_52px_1fr_72px_56px_44px_52px_56px] gap-2 items-center px-4 py-2.5 border-b border-[#0d0f0d] last:border-0 hover:bg-[#111412] transition-colors">
                      <span className="text-[9px] text-[#2e3328] font-mono">#{e.signal_id}</span>
                      <span className="text-[9px] text-[#4a524a]">{e.game_date ? fmtDate(e.game_date) : "—"}</span>
                      <span className="text-[10px] text-[#9ca39a] truncate">
                        {e.away_team && e.home_team ? `${abbrevTeam(e.away_team)} @ ${abbrevTeam(e.home_team)}` : "—"}
                      </span>
                      <span className="text-[10px] font-bold font-mono text-white">
                        {displaySide === "home" ? abbrevTeam(e.home_team ?? "") : abbrevTeam(e.away_team ?? "")} {dLine > 0 ? "+" : ""}{dLine}
                      </span>
                      <span className="text-[9px] text-[#4a524a] truncate">{e.book || "—"}</span>
                      <span className="text-[9px] font-mono text-[#6b7068]">{dLine > 0 ? "+" : ""}{dLine}</span>
                      <span className="text-[9px] font-mono text-[#6b7068]">${stakeDollars.toLocaleString()}</span>
                      <span className="text-[10px] font-bold font-mono text-right" style={{ color: oColor }}>
                        {e.graded_at === null
                          ? <span className="text-[#3a4033]">open</span>
                          : isPush ? <span>push</span>
                          : pnlDollars !== null
                            ? `${pnlDollars >= 0 ? "+" : ""}$${Math.abs(pnlDollars).toFixed(0)}`
                            : e.outcome === 1 ? "WIN" : "LOSS"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-10 gap-2">
              <p className="text-[13px] text-[#3a4033]">No bets logged yet</p>
              <p className="text-[10px] text-[#2e3328] text-center max-w-xs">
                When a signal fires and you place the bet, hit "Log Bet" on the signal above. Your P&amp;L tracks here.
              </p>
            </div>
          )}
        </div>

        {/* ══ ENGINE INTERNALS — collapsed by default ═════════════════════════
            Everything below this is engine-room data: edge validation, model
            calibration tables, raw picks log, archetype browser, pipeline
            health. Useful when debugging the model — noisy when you just
            want to see what to bet. One click reveals it. */}
        <EngineInternals subtitle="edge validation, model intelligence, picks log, pipeline health">

          {/* Manual job triggers — worker runs these on schedule */}
          <div className="flex flex-wrap gap-2">
            <ActionButton
              icon={Zap}
              label={running === "fetch" ? "Running…" : "Run picks now"}
              variant="primary"
              busy={running === "fetch"}
              disabled={running !== null}
              onClick={() => runPipeline("fetch")}
            />
            <ActionButton
              icon={CheckCircle2}
              label={running === "grade" ? "Grading…" : "Grade now"}
              busy={running === "grade"}
              disabled={running !== null}
              onClick={() => runPipeline("grade")}
            />
          </div>

        {/* ══ EDGE VALIDATION ══════════════════════════════════════════════════ */}
        <div className="ace-panel p-5">
          <SectionHead title="Edge Validation" icon={BarChart2} />

          {sig?.error ? (
            <p className="text-[11px] text-[#ef4444]">Signal DB unavailable: {sig.error}</p>
          ) : sig ? (
            <div>
              {/* Hero: Edge status + CLV */}
              <div className="grid grid-cols-3 gap-4 mb-5">
                <div className="col-span-1 rounded-xl border border-[#1e2220] bg-[#0d0f0d] p-5">
                  <p className="text-[9px] text-[#3a4033] uppercase tracking-wider mb-3">Edge status</p>
                  <p className="text-[36px] font-black font-mono leading-none mb-2" style={{ color: edgeColor(sig.edgeStatus) }}>
                    {sig.edgeStatus.toUpperCase()}
                  </p>
                  <div className="h-1.5 rounded-full bg-[#181c18] mb-2">
                    <div className="h-full rounded-full" style={{ width: `${Math.min(100, (sig.clv.n / 30) * 100)}%`, background: edgeColor(sig.edgeStatus) }} />
                  </div>
                  <p className="text-[9px] text-[#3a4033]">{sig.clv.n} / 30 graded signals</p>
                </div>

                <div className="col-span-2 grid grid-cols-2 gap-3">
                  <div className="rounded-xl border border-[#1e2220] bg-[#0d0f0d] p-4">
                    <p className="text-[9px] text-[#3a4033] uppercase tracking-wider mb-3">Avg CLV <span className="normal-case text-[#2e3328]">(all signals)</span></p>
                    <Num value={fmtClv(sig.clv.avg)} size={32} color={sig.clv.avg !== null ? green(sig.clv.avg) : "#6b7068"}
                         sub={`${sig.clv.n} graded · ${fmtPct(sig.clv.pct_positive !== null ? sig.clv.pct_positive / 100 : null)} positive`} />
                  </div>
                  <div className="rounded-xl border border-[#1e2220] bg-[#0d0f0d] p-4">
                    <p className="text-[9px] text-[#3a4033] uppercase tracking-wider mb-3">Signal P&amp;L <span className="normal-case text-[#2e3328]">(if you bet every signal flat)</span></p>
                    {signalTrack && signalTrack.graded > 0 ? (
                      <>
                        <Num value={fmtPnl(signalTrack.pnl_units)} size={32} color={green(signalTrack.pnl_units)}
                             sub={`${signalTrack.wins}W ${signalTrack.losses}L${signalTrack.pushes > 0 ? ` ${signalTrack.pushes}P` : ""} of ${signalTrack.graded} graded`} />
                        <div className="flex items-center gap-4 mt-3 pt-2.5 border-t border-[#141714]">
                          <div>
                            <p className="text-[8px] text-[#2e3328] mb-0.5">Starting</p>
                            <p className="text-[11px] font-bold font-mono text-[#6b7068]">${(signalTrack.start_units! * signalTrack.unit_value).toLocaleString()}</p>
                          </div>
                          <div>
                            <p className="text-[8px] text-[#2e3328] mb-0.5">Staked</p>
                            <p className="text-[11px] font-bold font-mono text-[#6b7068]">${(signalTrack.total_staked_units * signalTrack.unit_value).toLocaleString()}</p>
                          </div>
                          <div>
                            <p className="text-[8px] text-[#2e3328] mb-0.5">Balance</p>
                            <p className="text-[11px] font-bold font-mono" style={{ color: green(signalTrack.pnl_units) }}>
                              ${(signalTrack.current_units! * signalTrack.unit_value).toLocaleString()}
                            </p>
                          </div>
                          {signalTrack.roi_pct !== null && (
                            <div>
                              <p className="text-[8px] text-[#2e3328] mb-0.5">ROI</p>
                              <p className="text-[11px] font-bold font-mono" style={{ color: green(signalTrack.roi_pct) }}>
                                {signalTrack.roi_pct >= 0 ? "+" : ""}{signalTrack.roi_pct.toFixed(1)}%
                              </p>
                            </div>
                          )}
                        </div>
                      </>
                    ) : (
                      <>
                        <Num value="—" size={32} sub="accumulates as signals grade" />
                        {signalTrack && (
                          <p className="text-[9px] text-[#2e3328] mt-2">
                            Starting bankroll ${(signalTrack.start_units! * signalTrack.unit_value).toLocaleString()} · ${signalTrack.unit_value}/unit
                          </p>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* CLV by source */}
              <div className="grid grid-cols-2 gap-3 mb-5">
                <div className="rounded-xl border border-[#1e2220] bg-[#0d0f0d] p-4">
                  <p className="text-[9px] text-[#3a4033] uppercase tracking-wider mb-1">Same-book CLV</p>
                  <p className="text-[10px] text-[#2e3328] mb-3">Pinnacle close (canonical benchmark)</p>
                  <Num value={fmtClv(sig.pinnacle_close.clv)} size={26} color={sig.pinnacle_close.clv !== null ? green(sig.pinnacle_close.clv) : "#6b7068"}
                       sub={`n=${sig.pinnacle_close.n}`} />
                </div>
                <div className="rounded-xl border border-[#1e2220] bg-[#0d0f0d] p-4">
                  <p className="text-[9px] text-[#3a4033] uppercase tracking-wider mb-1">Fallback CLV</p>
                  <p className="text-[10px] text-[#2e3328] mb-3">No Pinnacle close available</p>
                  <Num value={fmtClv(sig.non_pinnacle_close.clv)} size={26} color={sig.non_pinnacle_close.clv !== null ? green(sig.non_pinnacle_close.clv) : "#6b7068"}
                       sub={`n=${sig.non_pinnacle_close.n}`} />
                </div>
              </div>

              {/* CLV by signal type */}
              {Object.keys(sig.by_type).length > 0 && (
                <div className="grid grid-cols-2 gap-3 mb-5">
                  {(["soft_book_divergence", "line_movement"] as const).map(type => {
                    const st = sig.by_type[type];
                    const es = st ? computeEdge(st.graded, st.avg_clv, st.pct_pos) : "accumulating";
                    return (
                      <div key={type} className="rounded-xl border border-[#1e2220] bg-[#0d0f0d] p-4">
                        <div className="flex items-center justify-between mb-3">
                          <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: sigColor(type) }}>{sigLabel(type)}</p>
                          <p className="text-[9px] font-bold" style={{ color: edgeColor(es) }}>{es}</p>
                        </div>
                        {st ? (
                          <div className="flex gap-5">
                            <Num value={fmtClv(st.avg_clv)} size={22} color={green(st.avg_clv)} sub="avg CLV" />
                            <Num value={String(st.graded)} size={22} color="#6b7068" sub="graded" />
                            <Num value={st.pct_pos !== null ? `${st.pct_pos}%` : "—"} size={22}
                                 color={st.pct_pos !== null ? winColor(st.pct_pos / 100) : "#6b7068"} sub="% pos" />
                          </div>
                        ) : <p className="text-[10px] text-[#3a4033]">no data yet</p>}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Recent graded signals */}
              {sig.recent_graded.length > 0 && (
                <div>
                  <p className="text-[9px] text-[#3a4033] uppercase tracking-widest mb-3">Recent graded signals</p>
                  <div className="rounded-xl border border-[#181c18] bg-[#0d0f0d] overflow-hidden">
                    <div className="grid grid-cols-[36px_56px_1fr_68px_52px_60px_44px] gap-3 px-4 py-2.5 border-b border-[#181c18]">
                      {["#","Date","Game","Side","CLV","Source","Result"].map(h => (
                        <span key={h} className="text-[8px] font-bold uppercase tracking-[0.14em] text-[#2e3328]">{h}</span>
                      ))}
                    </div>
                    {sig.recent_graded.map(s => (
                      <div key={s.id} className="grid grid-cols-[36px_56px_1fr_68px_52px_60px_44px] gap-3 items-center px-4 py-2.5 border-b border-[#0d0f0d] last:border-0 hover:bg-[#111412] transition-colors">
                        <span className="text-[9px] text-[#2e3328] font-mono">#{s.id}</span>
                        <span className="text-[9px] text-[#4a524a]">{fmtDate(s.game_date)}</span>
                        <span className="text-[10px] text-[#9ca39a] truncate">{abbrevTeam(s.away)} @ {abbrevTeam(s.home)}</span>
                        <span className="text-[10px] font-bold font-mono text-white">{s.side === "home" ? abbrevTeam(s.home) : abbrevTeam(s.away)} {(() => { const dl = s.side === "home" ? s.line : -s.line; return `${dl > 0 ? "+" : ""}${dl}`; })()}</span>
                        <span className="text-[10px] font-bold font-mono" style={{ color: green(s.clv) }}>{fmtClv(s.clv)}</span>
                        <span className="text-[9px] text-[#4a524a]">{s.src && s.src !== "pinnacle" ? "fallback" : "same-bk"}</span>
                        <span className={cn("text-[9px] font-bold text-right", s.win === 1 ? "text-[#3ee68a]" : "text-[#ef4444]")}>
                          {s.win === 1 ? "WIN" : "LOSS"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <p className="text-[9px] text-[#2e3328] mt-3">CLV = direction × (entry line − closing line). Positive = you got a better number than close.</p>
            </div>
          ) : (
            <p className="text-[11px] text-[#4a524a]">Signal data unavailable.</p>
          )}
        </div>

        {/* ══ MODEL PERFORMANCE ════════════════════════════════════════════════ */}
        <div className="ace-panel p-5">
          <SectionHead title="Model Performance" icon={TrendingUp} />

          <div className="flex gap-0.5 mb-5 border-b border-[#181c18]">
            {(["all","bets","conf","source"] as const).map(t => (
              <button key={t} onClick={() => setPerfTab(t)}
                className={cn("px-3.5 py-2 text-[11px] font-semibold border-b-2 -mb-px transition-colors",
                  perfTab === t ? "text-white border-[#3ee68a]" : "text-[#4a524a] border-transparent hover:text-[#9ca39a]")}>
                {t === "all" ? "All picks" : t === "bets" ? "Bets only" : t === "conf" ? "By signal" : "Pinnacle vs fallback"}
              </button>
            ))}
          </div>

          {perfTab === "all" && m && (
            <div className="flex gap-3">
              <KpiCard label="Total picks"  value={String(m.total)} sub={`${m.pending} pending · ${m.pushed} push`} />
              <KpiCard label="Graded"       value={String(m.graded)} />
              <KpiCard label="Record"       value={`${m.wins}–${m.losses}`}    color={winColor(m.winRate)} />
              <KpiCard label="Win rate"     value={fmtPct(m.winRate)}           color={winColor(m.winRate)} sub="break-even 52.4%" />
              <KpiCard label="ROI (flat)"   value={fmtRoi(m.roi)}               color={green(m.roi)} sub="at −110 vig" />
            </div>
          )}

          {perfTab === "bets" && m && (
            <div>
              <div className="flex gap-3 mb-3">
                <KpiCard label="Bets flagged"  value={String(m.betsTotal)} sub="is_bet=1" />
                <KpiCard label="Graded"        value={String(m.betsGraded)} />
                <KpiCard label="Record"        value={`${m.betsWins}–${m.betsLosses}`} color={winColor(m.betsWinRate)} />
                <KpiCard label="Win rate"      value={fmtPct(m.betsWinRate)} color={winColor(m.betsWinRate)} />
                <KpiCard label="ROI"           value={fmtRoi(m.betsRoi)} color={green(m.betsRoi)} />
              </div>
              <p className="text-[9px] text-[#2e3328]">Pinnacle-edge bets only — model disagrees with Pinnacle ≥4pp in the pick direction.</p>
            </div>
          )}

          {perfTab === "conf" && m && (
            <div>
              <p className="text-[10px] text-[#4a524a] mb-5">Win rate by signal-strength bucket — graded picks only</p>
              {m.buckets.map(b => (
                <div key={b.label} className="mb-4">
                  <div className="flex justify-between mb-1.5">
                    <span className="text-[10px] text-[#9ca39a] font-mono">{b.label}</span>
                    <span className="text-[10px] font-bold font-mono" style={{ color: winColor(b.winRate) }}>
                      {b.graded > 0 ? `${b.wins}W / ${b.graded - b.wins}L · ${fmtPct(b.winRate, 0)}` : "no data"}
                    </span>
                  </div>
                  <Bar wins={b.wins} total={b.graded} color={winColor(b.winRate)} />
                </div>
              ))}
            </div>
          )}

          {perfTab === "source" && m && (
            <div className="grid grid-cols-2 gap-4">
              {[
                { label: "Pinnacle-backed", sub: "edge_vs_pinnacle present", wins: m.pinnacleWins, graded: m.pinnacleGraded, wr: m.pinnacleWinRate },
                { label: "Fallback",        sub: "signal threshold only", wins: m.fallbackWins, graded: m.fallbackGraded, wr: m.fallbackWinRate },
              ].map(({ label, sub, wins, graded, wr }) => (
                <div key={label} className="rounded-xl border border-[#1e2220] bg-[#0d0f0d] p-5">
                  <p className="text-[9px] text-[#3a4033] uppercase tracking-wider mb-0.5">{label}</p>
                  <p className="text-[10px] text-[#2e3328] mb-4">{sub}</p>
                  <div className="flex items-end gap-4 mb-3">
                    <Num value={fmtPct(wr)} size={28} color={winColor(wr)} />
                    <span className="text-[10px] text-[#4a524a] pb-0.5">{wins}W / {graded - wins}L · n={graded}</span>
                  </div>
                  <Bar wins={wins} total={graded} color={winColor(wr)} />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ══ LIVE DIVERGENCES ═════════════════════════════════════════════════ */}
        {sig && !sig.error && (
          <div className="ace-panel p-5">
            <SectionHead
              title="Live Divergences"
              icon={Database}
              right={<span className="text-[10px] text-[#4a524a]">{sig.book_lines?.total ?? 0} lines collected</span>}
            />

            {(sig.book_lines?.divergences?.length ?? 0) > 0 ? (
              <div className="rounded-xl border border-[#181c18] bg-[#0d0f0d] overflow-hidden">
                <div className="grid grid-cols-[64px_1fr_96px_80px_80px_56px_64px] gap-3 px-4 py-2.5 border-b border-[#181c18]">
                  {["Date","Game","Pinnacle","Book","Line","Diff","Edge"].map(h => (
                    <span key={h} className="text-[8px] font-bold uppercase tracking-[0.14em] text-[#2e3328]">{h}</span>
                  ))}
                </div>
                {sig.book_lines.divergences.map((d, i) => {
                  const c = Math.abs(d.divergence) >= 1.0 ? "#f5c062" : "#9ca39a";
                  return (
                    <div key={i} className="grid grid-cols-[64px_1fr_96px_80px_80px_56px_64px] gap-3 items-center px-4 py-2.5 border-b border-[#0d0f0d] last:border-0 hover:bg-[#111412] transition-colors">
                      <span className="text-[9px] text-[#4a524a]">{fmtDate(d.game_date)}</span>
                      <span className="text-[10px] text-[#9ca39a] truncate">{abbrevTeam(d.away)} @ {abbrevTeam(d.home)}</span>
                      <span className="text-[10px] font-mono text-[#6b7068]">{d.pinnacle_line > 0 ? "+" : ""}{d.pinnacle_line}</span>
                      <span className="text-[9px] text-[#4a524a] truncate">{d.book}</span>
                      <span className="text-[10px] font-mono text-[#9ca39a]">{d.book_line > 0 ? "+" : ""}{d.book_line}</span>
                      <span className="text-[10px] font-bold font-mono" style={{ color: c }}>{d.divergence > 0 ? "+" : ""}{d.divergence}</span>
                      <span className="text-[9px] font-bold" style={{ color: c }}>{d.divergence > 0 ? "HOME" : "AWAY"}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex items-center justify-center rounded-xl border border-dashed border-[#181c18] py-8">
                <p className="text-[11px] text-[#2e3328]">
                  {(sig.book_lines?.total ?? 0) === 0 ? "No book lines yet — worker populates on next snapshot poll." : "No divergences ≥0.5 pts right now."}
                </p>
              </div>
            )}
          </div>
        )}

        {/* ══ PICKS LOG ════════════════════════════════════════════════════════ */}
        {pipeline?.picks && pipeline.picks.length > 0 && (
          <div className="ace-panel p-5">
            <SectionHead title="Picks Log" icon={BookMarked}
              right={<span className="text-[10px] text-[#4a524a]">{pipeline.picks.length} total</span>} />

            <div className="rounded-xl border border-[#181c18] bg-[#0d0f0d] overflow-hidden">
              <div className="grid grid-cols-[64px_1fr_88px_48px_56px_36px_56px_48px] gap-3 px-4 py-2.5 border-b border-[#181c18]">
                {["Date","Game","Pick","Conf","Edge","Bet","Status","Result"].map(h => (
                  <span key={h} className="text-[8px] font-bold uppercase tracking-[0.14em] text-[#2e3328]">{h}</span>
                ))}
              </div>
              {pipeline.picks.map((p, i) => {
                const pickLine  = p.line !== null ? (p.side === "home" ? p.line : -p.line) : null;
                const pickTeam  = p.side === "home" ? abbrevTeam(p.home) : abbrevTeam(p.away);
                const lineStr   = pickLine !== null ? ` ${pickLine > 0 ? "+" : ""}${pickLine}` : "";
                const rColor    = p.correct === 1 ? "#3ee68a" : p.correct === 0 ? "#ef4444" : "#6b7068";
                const rLabel    = p.correct === 1 ? "WIN" : p.correct === 0 ? "LOSS" : p.status === "pending" ? "—" : "PUSH";
                const eColor    = p.edge !== null ? (p.edge >= 0.04 ? "#3ee68a" : p.edge <= -0.04 ? "#ef4444" : "#9ca39a") : "#2e3328";
                return (
                  <div key={i} className={cn(
                    "grid grid-cols-[64px_1fr_88px_48px_56px_36px_56px_48px] gap-3 items-center px-4 py-2 border-b border-[#0d0f0d] last:border-0 hover:bg-[#111412] transition-colors",
                    p.status === "pending" && "opacity-50"
                  )}>
                    <span className="text-[9px] text-[#4a524a]">{fmtDate(p.date)}</span>
                    <span className="text-[10px] text-[#9ca39a] truncate">{abbrevTeam(p.away)} @ {abbrevTeam(p.home)}</span>
                    <span className="text-[10px] font-bold font-mono text-white truncate">{pickTeam}{lineStr}</span>
                    <span className="text-[9px] font-mono text-[#6b7068]">{p.conf !== null ? `${(p.conf * 100).toFixed(0)}%` : "—"}</span>
                    <span className="text-[9px] font-mono" style={{ color: eColor }}>
                      {p.edge !== null ? `${p.edge >= 0 ? "+" : ""}${(p.edge * 100).toFixed(1)}pp` : "—"}
                    </span>
                    <span className={cn("text-[9px] font-bold text-center", p.isBet ? "text-[#3ee68a]" : "text-[#2e3328]")}>
                      {p.isBet ? "✓" : "—"}
                    </span>
                    <span className={cn("text-[8px] uppercase tracking-wide font-semibold", p.status === "pending" ? "text-[#f5c062]" : "text-[#3a4033]")}>
                      {p.status}
                    </span>
                    <span className="text-[9px] font-bold text-right" style={{ color: rColor }}>{rLabel}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ══ MODEL INTELLIGENCE ═══════════════════════════════════════════════ */}
        {(pipeline?.segments || pipeline?.archetypes) && (
          <div className="ace-panel p-5">
            <SectionHead title="Model Intelligence" icon={Brain} />

            {pipeline.segments && (() => {
              const seg = pipeline.segments;
              const tierC = (t: string) =>
                ["elite","fast","high","high_assist","three_heavy","strong","road_capable"].includes(t) ? "#3ee68a" :
                ["good","medium","balanced"].includes(t) ? "#9ca39a" : "#ef4444";

              return (
                <div>
                  <p className="text-[9px] text-[#2e3328] mb-4">{seg.sample_note}</p>
                  <div className="grid grid-cols-4 gap-3 mb-4">
                    {[
                      { label: "Regular season", s: seg.by_regime?.["regular_season"] },
                      { label: "Playoffs",        s: seg.by_regime?.["playoffs"] },
                      { label: "Home bets",       s: seg.by_direction?.["home"] },
                      { label: "Away bets",       s: seg.by_direction?.["away"] },
                    ].map(({ label, s }) => (
                      <div key={label} className="rounded-xl border border-[#1e2220] bg-[#0d0f0d] p-4">
                        <p className="text-[9px] text-[#3a4033] uppercase tracking-wider mb-2">{label}</p>
                        {s && s.n > 0 ? (
                          <>
                            <Num value={fmtPct(s.win_rate, 0)} size={24} color={winColor(s.win_rate)} />
                            <p className="text-[9px] text-[#3a4033] mt-1">n={s.n}</p>
                          </>
                        ) : <p className="text-[10px] text-[#2e3328]">no data</p>}
                      </div>
                    ))}
                  </div>

                  {seg.calibration && seg.calibration.length > 0 && (
                    <div>
                      <p className="text-[9px] text-[#3a4033] uppercase tracking-widest mb-3">Calibration</p>
                      <div className="rounded-xl border border-[#181c18] bg-[#0d0f0d] overflow-hidden">
                        <div className="grid grid-cols-[88px_48px_72px_80px_72px] gap-3 px-4 py-2.5 border-b border-[#181c18]">
                          {["Bucket","n","Predicted","Actual","Delta"].map(h => (
                            <span key={h} className="text-[8px] font-bold uppercase tracking-[0.14em] text-[#2e3328]">{h}</span>
                          ))}
                        </div>
                        {seg.calibration.map(r => (
                          <div key={r.conf_bucket} className="grid grid-cols-[88px_48px_72px_80px_72px] gap-3 items-center px-4 py-2 border-b border-[#0d0f0d] last:border-0 hover:bg-[#111412] transition-colors">
                            <span className="text-[10px] font-mono text-[#9ca39a]">{r.conf_bucket}%</span>
                            <span className="text-[10px] text-[#4a524a]">{r.n}</span>
                            <span className="text-[10px] font-mono text-[#4a524a]">{(r.predicted_avg*100).toFixed(1)}%</span>
                            <span className="text-[10px] font-mono font-bold" style={{ color: winColor(r.actual_win_rate) }}>
                              {(r.actual_win_rate*100).toFixed(1)}%
                            </span>
                            <span className="text-[10px] font-mono font-bold"
                                  style={{ color: r.delta < -0.05 ? "#ef4444" : r.delta > 0.05 ? "#f5c062" : "#3a4033" }}>
                              {r.delta > 0 ? "+" : ""}{(r.delta*100).toFixed(1)}%
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Team archetypes */}
                  {pipeline.archetypes && (() => {
                    const teams = Object.entries(pipeline.archetypes).sort(([a],[b]) => a.localeCompare(b));
                    return (
                      <div className="mt-5">
                        <p className="text-[9px] text-[#3a4033] uppercase tracking-widest mb-3">Team archetypes</p>
                        <div className="rounded-xl border border-[#181c18] bg-[#0d0f0d] overflow-hidden">
                          <div className="grid grid-cols-[132px_76px_96px_68px_88px_60px_56px_56px] gap-2 px-4 py-2.5 border-b border-[#181c18]">
                            {["Team","Pace","Offense","Defense","Movement","Clutch","oRtg","dRtg"].map(h => (
                              <span key={h} className="text-[8px] font-bold uppercase tracking-[0.14em] text-[#2e3328]">{h}</span>
                            ))}
                          </div>
                          <div className="max-h-72 overflow-y-auto">
                            {teams.map(([code, a]) => (
                              <div key={code} className="grid grid-cols-[132px_76px_96px_68px_88px_60px_56px_56px] gap-2 items-center px-4 py-2 border-b border-[#0d0f0d] last:border-0 hover:bg-[#111412] transition-colors">
                                <div className="min-w-0">
                                  <span className="text-[10px] font-bold text-white uppercase">{code}</span>
                                  <span className="text-[9px] text-[#6b7068] ml-2 truncate">{teamLabelFromCode(code)}</span>
                                </div>
                                <span className="text-[9px] font-mono" style={{ color: tierC(a.pace_tier) }}>{a.pace_tier}</span>
                                <span className="text-[9px] font-mono" style={{ color: tierC(a.offense_style) }}>{a.offense_style.replace("_"," ")}</span>
                                <span className="text-[9px] font-mono" style={{ color: tierC(a.defense_tier) }}>{a.defense_tier}</span>
                                <span className="text-[9px] font-mono" style={{ color: tierC(a.ball_movement) }}>{a.ball_movement.replace("_"," ")}</span>
                                <span className="text-[9px] font-mono" style={{ color: tierC(a.clutch) }}>{a.clutch}</span>
                                <span className="text-[9px] font-mono text-[#6b7068]">{a.raw.ortg ?? "—"}</span>
                                <span className="text-[9px] font-mono text-[#6b7068]">{a.raw.drtg ?? "—"}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              );
            })()}
          </div>
        )}

        {/* ══ PIPELINE HEALTH ══════════════════════════════════════════════════ */}
        <div className="ace-panel p-5">
          <SectionHead title="Pipeline Health" icon={Activity} />

          {/* Worker */}
          <div className={cn("rounded-xl border bg-[#0d0f0d] p-4 mb-4",
            worker?.lastPollOk === false ? "border-[#ef4444]/25" : "border-[#3ee68a]/12")}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Dot color={wColor} pulse={wLive} />
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-[11px] font-bold text-white">Worker Daemon</p>
                    <Tag label="Railway" color="#9ca39a" />
                  </div>
                  <p className="text-[9px] text-[#3a4033] mt-0.5">60s near tip · 10min otherwise · daily tasks on schedule</p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-[10px] font-mono" style={{ color: wColor }}>
                  {worker?.lastPollAt ? timeAgo(worker.lastPollAt) : "never polled"}
                </p>
                {worker?.lastPollAt && <p className="text-[9px] text-[#3a4033]">{worker.lastPollAt.slice(0,16)}</p>}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3 mb-4">
            {[
              { name: "update_team_state", time: "8:00am ET",  utc: 13 },
              { name: "grade_results",     time: "9:00am ET",  utc: 14 },
              { name: "fetch_and_predict", time: "12:00pm ET", utc: 17 },
            ].map(({ name, time, utc }) => {
              const job = name === "update_team_state" ? (jobs?.state ?? emptyJob)
                        : name === "grade_results"     ? (jobs?.grade ?? emptyJob)
                        : (jobs?.fetch ?? emptyJob);
              const c = jobColor(job);
              return (
                <div key={name} className="rounded-xl border border-[#1e2220] bg-[#0d0f0d] p-4 overflow-hidden"
                     style={{ borderLeftColor: c, borderLeftWidth: 3 }}>
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <p className="text-[10px] font-bold text-[#c4c7c0]">{name}</p>
                      <p className="text-[9px] text-[#3a4033] mt-0.5">{time} daily</p>
                    </div>
                    {job.hasError ? <XCircle className="h-3.5 w-3.5 text-[#ef4444]" />
                      : job.truncated ? <AlertTriangle className="h-3.5 w-3.5 text-[#f5c062]" />
                      : staleness(job.lastRunAt) === "unknown" ? <Clock className="h-3.5 w-3.5 text-[#3a4033]" />
                      : <CheckCircle2 className="h-3.5 w-3.5" style={{ color: c }} />}
                  </div>
                  <p className="text-[10px] font-mono" style={{ color: c }}>
                    {job.lastRunAt ? `${job.lastRunAt.slice(0,10)} · ${timeAgo(job.lastRunAt)}` : "no run recorded"}
                  </p>
                  <p className="text-[9px] text-[#2e3328] mt-1">next: {nextRun(utc)}</p>
                  {job.hasError && job.errorSnippet && (
                    <p className="text-[9px] text-[#ef4444] mt-2 truncate">{job.errorSnippet}</p>
                  )}
                </div>
              );
            })}
          </div>

          {pipeline?.latestQuota != null && (
            <div className="flex items-center gap-3">
              <div className="flex-1 h-1.5 rounded-full bg-[#181c18]">
                <div className="h-full rounded-full" style={{ width: `${(pipeline.latestQuota / 500) * 100}%`, background: quotaColor }} />
              </div>
              <p className="text-[10px] font-mono shrink-0" style={{ color: quotaColor }}>{pipeline.latestQuota} / 500</p>
            </div>
          )}
        </div>

        </EngineInternals>

        <p className="text-[8px] text-[#1a1e1a] text-center pb-4">ACE · auto-refreshes every 60s</p>
      </div>
    </div>
  );
}
