"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Activity, AlertTriangle, CheckCircle2, Clock, RefreshCw,
  Target, TrendingUp, Zap, Trophy,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SoccerSignal {
  id: number;
  game_date: string;
  home_team: string;
  away_team: string;
  commence_time: string | null;
  market: string;
  bet_side: string;
  total_line: number | null;
  pinnacle_prob: number | null;
  book: string;
  book_prob: number | null;
  book_odds: number | null;
  edge_pp: number | null;
  home_score: number | null;
  away_score: number | null;
  result: string | null;
  correct: number | null;
  status: string;
  notes: string | null;
}

interface Stats {
  total: number; open: number; graded: number;
  wins: number; losses: number;
  winRate: number | null; roi: number | null;
  h2h:    { graded: number; wins: number };
  totals: { graded: number; wins: number };
}

interface JobMeta { lastRunAt: string | null; lastError: string | null }
interface WCPayload {
  worker: { lastPollAt: string | null; lastPollOk: boolean | null };
  jobs:   { fetch: JobMeta; grade: JobMeta };
  signals: SoccerSignal[];
  stats:   Stats;
  refreshedAt: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(ts: string | null): string {
  if (!ts) return "never";
  const d = new Date(ts.replace(" ", "T"));
  const diff = Date.now() - d.getTime();
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h > 48) return `${Math.floor(h / 24)}d ago`;
  if (h > 0)  return `${h}h ${m}m ago`;
  if (m > 0)  return `${m}m ago`;
  return "just now";
}

function fmtPct(v: number | null) {
  return v !== null ? `${(v * 100).toFixed(1)}%` : "—";
}
function fmtRoi(v: number | null) {
  if (v === null) return "—";
  const s = (v * 100).toFixed(1);
  return v >= 0 ? `+${s}%` : `${s}%`;
}
function fmtEdge(v: number | null) {
  if (v === null) return "—";
  return `+${(v * 100).toFixed(1)}pp`;
}
function fmtOdds(v: number | null) {
  if (v === null) return "—";
  return v >= 0 ? `+${v}` : `${v}`;
}

function betLabel(market: string, side: string, line: number | null) {
  if (market === "totals") return `${side.toUpperCase()} ${line ?? ""}`;
  return side.charAt(0).toUpperCase() + side.slice(1);
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function JobChip({ label, meta }: { label: string; meta: JobMeta }) {
  const isErr = !!meta.lastError;
  return (
    <div className="flex items-center gap-1.5 text-xs">
      {isErr
        ? <AlertTriangle size={12} className="text-red-400" />
        : <CheckCircle2 size={12} className="text-emerald-400" />}
      <span className="text-zinc-400">{label}</span>
      <span className={isErr ? "text-red-300" : "text-zinc-300"}>
        {meta.lastRunAt ? timeAgo(meta.lastRunAt) : "never"}
      </span>
      {isErr && (
        <span className="text-red-400 truncate max-w-[160px]" title={meta.lastError ?? ""}>
          · {meta.lastError?.slice(0, 60)}
        </span>
      )}
    </div>
  );
}

function StatCard({
  label, value, sub, accent,
}: {
  label: string; value: string | number; sub?: string; accent?: string;
}) {
  return (
    <div className="bg-zinc-800/60 rounded-lg p-3 flex flex-col gap-0.5 min-w-[90px]">
      <span className="text-[10px] text-zinc-500 uppercase tracking-wide">{label}</span>
      <span className={`text-xl font-semibold ${accent ?? "text-white"}`}>{value}</span>
      {sub && <span className="text-[11px] text-zinc-500">{sub}</span>}
    </div>
  );
}

function SignalRow({ sig }: { sig: SoccerSignal }) {
  const isOpen   = sig.status === "open";
  const isGraded = sig.status === "graded";
  const won      = sig.correct === 1;
  const lost     = sig.correct === 0;

  const flags = sig.notes
    ? sig.notes.split(";").map((n: string) => n.trim()).filter(Boolean)
    : [];
  const isDeadRubber = flags.some((f: string) => f.startsWith("DEAD RUBBER"));
  const hasCardRisk  = flags.some((f: string) => f.startsWith("CARD RISK"));

  let statusBadge = null;
  if (isGraded && won)       statusBadge = <span className="text-emerald-400 font-semibold text-xs">WIN</span>;
  if (isGraded && lost)      statusBadge = <span className="text-red-400 font-semibold text-xs">LOSS</span>;
  if (isOpen)                statusBadge = <span className="text-amber-400 font-semibold text-xs">OPEN</span>;
  if (sig.status === "void") statusBadge = <span className="text-zinc-500 text-xs">VOID</span>;

  return (
    <tr className={`border-t border-zinc-800 hover:bg-zinc-800/30 transition-colors ${isDeadRubber ? "opacity-60" : ""}`}>
      <td className="px-3 py-2 text-xs text-zinc-500 whitespace-nowrap">{sig.game_date}</td>
      <td className="px-3 py-2 text-sm text-zinc-200 whitespace-nowrap">
        {sig.away_team} <span className="text-zinc-500">@</span> {sig.home_team}
      </td>
      <td className="px-3 py-2">
        <span className="text-xs bg-zinc-700 rounded px-1.5 py-0.5 text-zinc-300">
          {sig.market === "asian_handicap" ? "AH" : sig.market.toUpperCase()}
        </span>
      </td>
      <td className="px-3 py-2 text-sm font-medium text-white">
        {betLabel(sig.market, sig.bet_side, sig.total_line)}
      </td>
      <td className="px-3 py-2 text-xs text-zinc-400">{sig.book}</td>
      <td className="px-3 py-2 text-xs text-zinc-300">{fmtOdds(sig.book_odds)}</td>
      <td className="px-3 py-2 text-xs text-emerald-400 font-medium">{fmtEdge(sig.edge_pp)}</td>
      <td className="px-3 py-2 text-xs">
        {isGraded && sig.home_score !== null
          ? <span className="text-zinc-400">{sig.home_score}–{sig.away_score}</span>
          : <span className="text-zinc-600">—</span>}
      </td>
      <td className="px-3 py-2 text-xs">
        <div className="flex items-center gap-1 flex-wrap">
          {statusBadge}
          {isDeadRubber && (
            <span title="Dead rubber — team may rest starters"
              className="text-zinc-500 cursor-help">⚠ DR</span>
          )}
          {hasCardRisk && (
            <span title={flags.find((f) => f.startsWith("CARD RISK")) ?? "Card risk"}
              className="text-amber-500 cursor-help">🟨</span>
          )}
        </div>
      </td>
    </tr>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function SoccerOpsTab() {
  const [data,    setData]    = useState<WCPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<null | "fetch" | "grade" | "both">(null);
  const [tab,     setTab]     = useState<"open" | "graded">("open");

  const loadAll = useCallback(async () => {
    try {
      const res  = await fetch("/api/ops/soccer");
      const json = await res.json() as WCPayload;
      setData(json);
    } catch { /* silently ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void loadAll(); }, [loadAll]);

  async function runJob(job: "fetch" | "grade" | "both") {
    setRunning(job);
    try {
      await fetch("/api/ops/soccer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job }),
      });
    } catch { /* ignore */ }
    finally {
      await loadAll();
      setRunning(null);
    }
  }

  // Pre-tournament holding state
  const WC_START = new Date("2026-06-11");
  const today    = new Date();
  const daysOut  = Math.ceil((WC_START.getTime() - today.getTime()) / 86_400_000);
  const preEvent = daysOut > 0;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48 text-zinc-500">
        <RefreshCw size={18} className="animate-spin mr-2" /> Loading…
      </div>
    );
  }

  const stats   = data?.stats;
  const signals = data?.signals ?? [];
  const open    = signals.filter((s) => s.status === "open");
  const graded  = signals.filter((s) => s.status === "graded");

  return (
    <div className="space-y-6">

      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Trophy size={18} className="text-amber-400" />
            <h2 className="text-lg font-semibold text-white">FIFA World Cup 2026</h2>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
              preEvent
                ? "bg-zinc-700 text-zinc-400"
                : "bg-emerald-500/20 text-emerald-400"
            }`}>
              {preEvent ? `Starts in ${daysOut}d` : "LIVE"}
            </span>
          </div>
          <p className="text-sm text-zinc-500">
            Pinnacle divergence signals · h2h + totals · Jun 11 – Jul 19
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => runJob("grade")}
            disabled={!!running}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 transition-colors text-zinc-200"
          >
            {running === "grade"
              ? <><RefreshCw size={11} className="animate-spin" /> Grading…</>
              : <><CheckCircle2 size={11} /> Grade</>}
          </button>
          <button
            onClick={() => runJob("fetch")}
            disabled={!!running}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-emerald-600/80 hover:bg-emerald-600 disabled:opacity-50 transition-colors text-white"
          >
            {running === "fetch"
              ? <><RefreshCw size={11} className="animate-spin" /> Scanning…</>
              : <><Zap size={11} /> Scan</>}
          </button>
          <button
            onClick={loadAll}
            className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700 transition-colors"
          >
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      {/* ── Job status strip ── */}
      <div className="flex items-center gap-4 px-4 py-2.5 bg-zinc-800/40 rounded-lg border border-zinc-700/50">
        <div className="flex items-center gap-1.5 text-xs text-zinc-500">
          <Activity size={11} />
          <span>Worker</span>
          <span className={data?.worker.lastPollOk === false ? "text-red-400" : "text-zinc-300"}>
            {timeAgo(data?.worker.lastPollAt ?? null)}
          </span>
        </div>
        <div className="w-px h-3 bg-zinc-700" />
        {data?.jobs.fetch && <JobChip label="Scan" meta={data.jobs.fetch} />}
        <div className="w-px h-3 bg-zinc-700" />
        {data?.jobs.grade && <JobChip label="Grade" meta={data.jobs.grade} />}
      </div>

      {/* ── Stats ── */}
      {stats && (
        <div className="flex flex-wrap gap-3">
          <StatCard label="Signals" value={stats.total} />
          <StatCard label="Open"    value={stats.open}  accent="text-amber-400" />
          <StatCard label="Graded"  value={stats.graded} />
          <StatCard
            label="Record"
            value={stats.graded > 0 ? `${stats.wins}W / ${stats.losses}L` : "—"}
            accent={stats.winRate !== null && stats.winRate >= 0.524 ? "text-emerald-400" : "text-zinc-300"}
          />
          <StatCard
            label="Win Rate"
            value={fmtPct(stats.winRate)}
            sub="break-even 52.4%"
            accent={stats.winRate !== null && stats.winRate >= 0.524 ? "text-emerald-400" : "text-red-400"}
          />
          <StatCard
            label="ROI"
            value={fmtRoi(stats.roi)}
            accent={stats.roi !== null && stats.roi >= 0 ? "text-emerald-400" : "text-red-400"}
          />
          {stats.h2h.graded > 0 && (
            <StatCard
              label="1X2"
              value={`${stats.h2h.wins}/${stats.h2h.graded}`}
              sub={fmtPct(stats.h2h.wins / stats.h2h.graded)}
            />
          )}
          {stats.totals.graded > 0 && (
            <StatCard
              label="Totals"
              value={`${stats.totals.wins}/${stats.totals.graded}`}
              sub={fmtPct(stats.totals.wins / stats.totals.graded)}
            />
          )}
        </div>
      )}

      {/* ── Pre-event notice ── */}
      {preEvent && signals.length === 0 && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-5 text-center space-y-2">
          <Clock size={24} className="text-amber-400 mx-auto" />
          <p className="text-amber-300 font-medium">Tournament starts in {daysOut} days</p>
          <p className="text-sm text-zinc-500 max-w-md mx-auto">
            The Odds API will publish World Cup odds as the tournament approaches.
            Signals will start appearing once Pinnacle posts lines — typically 1–2 weeks before kickoff.
          </p>
          <div className="flex items-center justify-center gap-6 pt-2 text-xs text-zinc-600">
            <span className="flex items-center gap-1"><Target size={11} /> 3pp edge threshold</span>
            <span className="flex items-center gap-1"><TrendingUp size={11} /> Pinnacle de-vig reference</span>
            <span className="flex items-center gap-1"><Activity size={11} /> h2h + totals markets</span>
          </div>
        </div>
      )}

      {/* ── Signals table ── */}
      {signals.length > 0 && (
        <div className="rounded-xl border border-zinc-700/60 overflow-hidden">
          {/* Tab bar */}
          <div className="flex border-b border-zinc-700/60 bg-zinc-800/30">
            {(["open", "graded"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-4 py-2 text-xs font-medium transition-colors ${
                  tab === t
                    ? "text-white border-b-2 border-emerald-500 bg-zinc-800/60"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {t.charAt(0).toUpperCase() + t.slice(1)}
                <span className="ml-1.5 text-zinc-600">
                  {t === "open" ? open.length : graded.length}
                </span>
              </button>
            ))}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] text-zinc-500 uppercase tracking-wide bg-zinc-800/40">
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">Matchup</th>
                  <th className="px-3 py-2 text-left">Market</th>
                  <th className="px-3 py-2 text-left">Side</th>
                  <th className="px-3 py-2 text-left">Book</th>
                  <th className="px-3 py-2 text-left">Odds</th>
                  <th className="px-3 py-2 text-left">Edge</th>
                  <th className="px-3 py-2 text-left">Score</th>
                  <th className="px-3 py-2 text-left">Result</th>
                </tr>
              </thead>
              <tbody>
                {(tab === "open" ? open : graded).map((sig) => (
                  <SignalRow key={sig.id} sig={sig} />
                ))}
                {(tab === "open" ? open : graded).length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-3 py-6 text-center text-zinc-600 text-sm">
                      {tab === "open" ? "No open signals." : "No graded signals yet."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

    </div>
  );
}
