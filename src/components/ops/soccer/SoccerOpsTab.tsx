"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Activity, AlertTriangle, CheckCircle2, Clock,
  RefreshCw, Target, TrendingUp, Zap, Trophy,
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
  if (market === "asian_handicap") return `AH ${side === "home" ? "Home" : "Away"} ${line != null ? (line >= 0 ? `+${line}` : line) : ""}`;
  return side.charAt(0).toUpperCase() + side.slice(1);
}

function winRateColor(v: number | null): string {
  if (v === null) return "#6b7068";
  if (v >= 0.524) return "#3ee68a";
  if (v >= 0.48)  return "#f5c062";
  return "#ef4444";
}

// ─── Primitive components ─────────────────────────────────────────────────────

function Dot({ color, pulse = false }: { color: string; pulse?: boolean }) {
  return (
    <span className="relative flex h-2.5 w-2.5 shrink-0">
      {pulse && <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-40" style={{ background: color }} />}
      <span className="relative inline-flex rounded-full h-2.5 w-2.5" style={{ background: color }} />
    </span>
  );
}

function Tag({ label, color = "#6b7068" }: { label: string; color?: string }) {
  return (
    <span className="text-[8px] font-bold uppercase tracking-widest border rounded px-1.5 py-0.5"
          style={{ color, borderColor: `${color}35` }}>
      {label}
    </span>
  );
}

function KpiCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="flex-1 min-w-0 rounded-xl border border-[#1e2220] bg-[#0f110f] px-4 py-4">
      <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-[#3a4033] mb-2.5">{label}</p>
      <p className="text-[26px] font-black font-mono leading-none" style={{ color: color ?? "#d4d7d0" }}>{value}</p>
      {sub && <p className="text-[10px] text-[#4a524a] mt-1.5 leading-tight">{sub}</p>}
    </div>
  );
}

function SectionHead({ title, icon: Icon, right }: { title: string; icon: React.ElementType; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-4">
      <div className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 text-[#3ee68a]" />
        <p className="text-[11px] font-bold text-[#3ee68a] uppercase tracking-[0.2em]">{title}</p>
      </div>
      {right}
    </div>
  );
}

function SignalRow({ sig }: { sig: SoccerSignal }) {
  const isOpen    = sig.status === "open";
  const isGraded  = sig.status === "graded";
  const won       = sig.correct === 1;
  const lost      = sig.correct === 0;

  const flags       = sig.notes ? sig.notes.split(";").map((n: string) => n.trim()).filter(Boolean) : [];
  const isDeadRubber = flags.some((f: string) => f.startsWith("DEAD RUBBER"));
  const hasCardRisk  = flags.some((f: string) => f.startsWith("CARD RISK"));

  const marketLabel = sig.market === "asian_handicap" ? "AH"
    : sig.market === "totals" ? "TOT"
    : "1X2";

  return (
    <tr className={`border-t border-[#181c18] hover:bg-[#0d0f0d] transition-colors ${isDeadRubber ? "opacity-50" : ""}`}>
      <td className="px-3 py-2.5 text-[11px] text-[#4a524a] font-mono whitespace-nowrap">{sig.game_date}</td>
      <td className="px-3 py-2.5 text-[12px] text-[#c4c7c0] whitespace-nowrap">
        {sig.away_team} <span className="text-[#3a4033]">@</span> {sig.home_team}
      </td>
      <td className="px-3 py-2.5">
        <span className="text-[8px] font-bold uppercase tracking-[0.15em] border rounded px-1.5 py-0.5"
              style={{ color: "#9ca39a", borderColor: "#1e2220" }}>
          {marketLabel}
        </span>
      </td>
      <td className="px-3 py-2.5 text-[12px] font-semibold text-[#d4d7d0]">
        {betLabel(sig.market, sig.bet_side, sig.total_line)}
      </td>
      <td className="px-3 py-2.5 text-[11px] text-[#6b7068]">{sig.book}</td>
      <td className="px-3 py-2.5 text-[11px] font-mono text-[#9ca39a]">{fmtOdds(sig.book_odds)}</td>
      <td className="px-3 py-2.5 text-[11px] font-mono font-bold" style={{ color: "#3ee68a" }}>{fmtEdge(sig.edge_pp)}</td>
      <td className="px-3 py-2.5 text-[11px] font-mono text-[#6b7068]">
        {isGraded && sig.home_score !== null ? `${sig.home_score}–${sig.away_score}` : "—"}
      </td>
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          {isGraded && won  && <span className="text-[9px] font-bold text-[#3ee68a]">WIN</span>}
          {isGraded && lost && <span className="text-[9px] font-bold text-[#ef4444]">LOSS</span>}
          {isOpen           && <span className="text-[9px] font-bold text-[#f5c062]">OPEN</span>}
          {sig.status === "void" && <span className="text-[9px] text-[#4a524a]">VOID</span>}
          {isDeadRubber && (
            <span title="Dead rubber — team may rest starters" className="text-[9px] text-[#4a524a] cursor-help">DR</span>
          )}
          {hasCardRisk && (
            <span title={flags.find((f) => f.startsWith("CARD RISK")) ?? "Card risk"}
                  className="text-[9px] cursor-help" style={{ color: "#f5c062" }}>YC</span>
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
  const [running, setRunning] = useState<null | "fetch" | "grade">(null);
  const [tab,     setTab]     = useState<"open" | "graded">("open");

  const loadAll = useCallback(async () => {
    try {
      const res  = await fetch("/api/ops/soccer");
      const json = await res.json() as WCPayload;
      setData(json);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void loadAll(); }, [loadAll]);

  async function runJob(job: "fetch" | "grade") {
    setRunning(job);
    try {
      await fetch("/api/ops/soccer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job }),
      });
    } catch { /* ignore */ }
    finally { await loadAll(); setRunning(null); }
  }

  const WC_START = new Date("2026-06-11");
  const daysOut  = Math.ceil((WC_START.getTime() - Date.now()) / 86_400_000);
  const preEvent = daysOut > 0;

  const workerColor = data?.worker.lastPollOk === false ? "#ef4444"
    : data?.worker.lastPollAt ? "#3ee68a"
    : "#3a4033";

  const jobColor = (meta: JobMeta | undefined): string => {
    if (!meta) return "#3a4033";
    if (meta.lastError) return "#ef4444";
    if (!meta.lastRunAt) return "#3a4033";
    return "#3ee68a";
  };

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

  const stats   = data?.stats;
  const signals = data?.signals ?? [];
  const open    = signals.filter((s) => s.status === "open");
  const graded  = signals.filter((s) => s.status === "graded");

  const fetchMeta = data?.jobs.fetch;
  const gradeMeta = data?.jobs.grade;

  const errors: Array<{ msg: string }> = [];
  if (fetchMeta?.lastError) errors.push({ msg: `Scan error: ${fetchMeta.lastError.slice(0, 80)}` });
  if (gradeMeta?.lastError) errors.push({ msg: `Grade error: ${gradeMeta.lastError.slice(0, 80)}` });

  return (
    <div className="flex-1 overflow-y-auto bg-[#0a0b0a]">
      <div className="max-w-[1200px] mx-auto px-6 py-7 space-y-5">

        {/* ══ HEADER ══════════════════════════════════════════════════════════ */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Trophy className="h-4 w-4 text-[#3ee68a]" />
            <h1 className="text-[18px] font-bold text-white tracking-tight">FIFA World Cup 2026</h1>
            <Tag label={preEvent ? `in ${daysOut}d` : "live"} color={preEvent ? "#6b7068" : "#3ee68a"} />
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => runJob("grade")}
              disabled={running !== null}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[#1e2220] text-[10px] font-semibold text-[#6b7068] hover:text-[#9ca39a] hover:border-[#2e332a] transition-colors disabled:opacity-40"
            >
              {running === "grade" ? <RefreshCw className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
              {running === "grade" ? "Grading…" : "Grade"}
            </button>
            <button
              onClick={() => runJob("fetch")}
              disabled={running !== null}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[#3ee68a]/20 bg-[#3ee68a]/5 text-[10px] font-bold text-[#3ee68a] hover:bg-[#3ee68a]/10 transition-colors disabled:opacity-40"
            >
              {running === "fetch" ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
              {running === "fetch" ? "Scanning…" : "Scan"}
            </button>
            <button onClick={loadAll} className="flex items-center gap-1.5 text-[10px] text-[#4a524a] hover:text-[#9ca39a] transition-colors">
              <RefreshCw className="h-3 w-3" />
            </button>
          </div>
        </div>

        {/* ══ STATUS STRIP ════════════════════════════════════════════════════ */}
        <div className="flex items-center gap-4 rounded-xl border border-[#181c18] bg-[#0d0f0d] px-4 py-3 flex-wrap gap-y-2">
          <div className="flex items-center gap-1.5">
            <Dot color={workerColor} pulse={workerColor === "#3ee68a"} />
            <span className="text-[10px] text-[#6b7068]">Worker</span>
            <span className="text-[10px] font-mono text-[#4a524a]">{timeAgo(data?.worker.lastPollAt ?? null)}</span>
          </div>
          <div className="h-3 w-px bg-[#1e2220]" />
          <div className="flex items-center gap-1.5">
            <Dot color={jobColor(fetchMeta)} />
            <span className="text-[10px] text-[#6b7068]">Scan</span>
            <span className="text-[10px] font-mono text-[#4a524a]">{timeAgo(fetchMeta?.lastRunAt ?? null)}</span>
          </div>
          <div className="h-3 w-px bg-[#1e2220]" />
          <div className="flex items-center gap-1.5">
            <Dot color={jobColor(gradeMeta)} />
            <span className="text-[10px] text-[#6b7068]">Grade</span>
            <span className="text-[10px] font-mono text-[#4a524a]">{timeAgo(gradeMeta?.lastRunAt ?? null)}</span>
          </div>
          {errors.length > 0 && (
            <>
              <div className="h-3 w-px bg-[#1e2220]" />
              <div className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-[#ef4444] animate-pulse" />
                <span className="text-[9px] font-bold text-[#ef4444]">{errors.length} error{errors.length !== 1 ? "s" : ""}</span>
              </div>
            </>
          )}
        </div>

        {/* ══ ERRORS ══════════════════════════════════════════════════════════ */}
        {errors.length > 0 && (
          <div className="rounded-xl border border-[#ef4444]/20 bg-[#ef4444]/[0.03] px-4 py-3.5 space-y-2">
            {errors.map((e, i) => (
              <div key={i} className="flex items-start gap-2.5">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-[#ef4444]" />
                <p className="text-[11px] text-[#c4c7c0]">{e.msg}</p>
              </div>
            ))}
          </div>
        )}

        {/* ══ STATS ═══════════════════════════════════════════════════════════ */}
        {stats && (
          <div className="flex gap-3 flex-wrap">
            <KpiCard label="Signals"  value={String(stats.total)} />
            <KpiCard label="Open"     value={String(stats.open)}  color="#f5c062" />
            <KpiCard label="Graded"   value={String(stats.graded)} />
            <KpiCard
              label="Record"
              value={stats.graded > 0 ? `${stats.wins}–${stats.losses}` : "—"}
              color={stats.winRate !== null && stats.winRate >= 0.524 ? "#3ee68a" : "#d4d7d0"}
            />
            <KpiCard
              label="Win Rate"
              value={fmtPct(stats.winRate)}
              sub="52.4% break-even"
              color={winRateColor(stats.winRate)}
            />
            <KpiCard
              label="ROI"
              value={fmtRoi(stats.roi)}
              color={stats.roi !== null ? (stats.roi >= 0 ? "#3ee68a" : "#ef4444") : "#6b7068"}
            />
            {stats.h2h.graded > 0 && (
              <KpiCard
                label="1X2"
                value={`${stats.h2h.wins}/${stats.h2h.graded}`}
                sub={fmtPct(stats.h2h.wins / stats.h2h.graded)}
              />
            )}
            {stats.totals.graded > 0 && (
              <KpiCard
                label="Totals"
                value={`${stats.totals.wins}/${stats.totals.graded}`}
                sub={fmtPct(stats.totals.wins / stats.totals.graded)}
              />
            )}
          </div>
        )}

        {/* ══ PRE-EVENT NOTICE ════════════════════════════════════════════════ */}
        {preEvent && signals.length === 0 && (
          <div className="rounded-xl border border-[#f5c062]/15 bg-[#f5c062]/[0.03] px-5 py-6 text-center space-y-3">
            <Clock className="h-6 w-6 mx-auto" style={{ color: "#f5c062" }} />
            <p className="text-[14px] font-bold text-[#d4d7d0]">Tournament starts in {daysOut} days</p>
            <p className="text-[12px] text-[#4a524a] max-w-md mx-auto leading-relaxed">
              Pinnacle will post World Cup odds 1–2 weeks before kickoff.
              Hit <span className="text-[#3ee68a] font-semibold">Scan</span> once odds appear to start logging divergences.
            </p>
            <div className="flex items-center justify-center gap-6 pt-1 text-[10px] text-[#3a4033]">
              <span className="flex items-center gap-1.5"><Target className="h-3 w-3" /> 3pp edge threshold</span>
              <span className="flex items-center gap-1.5"><TrendingUp className="h-3 w-3" /> Pinnacle de-vig reference</span>
              <span className="flex items-center gap-1.5"><Activity className="h-3 w-3" /> h2h · totals · asian handicap</span>
            </div>
          </div>
        )}

        {/* ══ SIGNALS ═════════════════════════════════════════════════════════ */}
        {signals.length > 0 && (
          <div className="rounded-xl border border-[#181c18] bg-[#0d0f0d] overflow-hidden">
            <SectionHead
              title="Signals"
              icon={Activity}
              right={
                <div className="flex border border-[#1e2220] rounded-lg overflow-hidden">
                  {(["open", "graded"] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setTab(t)}
                      className="px-3 py-1 text-[10px] font-bold uppercase tracking-[0.12em] transition-colors"
                      style={{
                        background: tab === t ? "#3ee68a15" : "transparent",
                        color: tab === t ? "#3ee68a" : "#4a524a",
                      }}
                    >
                      {t} <span style={{ color: "#3a4033" }}>
                        {t === "open" ? open.length : graded.length}
                      </span>
                    </button>
                  ))}
                </div>
              }
            />
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-t border-[#181c18]">
                    {["Date","Matchup","Mkt","Side","Book","Odds","Edge","Score","Result"].map((h) => (
                      <th key={h} className="px-3 py-2 text-left text-[9px] font-bold uppercase tracking-[0.15em] text-[#3a4033]">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(tab === "open" ? open : graded).map((sig) => (
                    <SignalRow key={sig.id} sig={sig} />
                  ))}
                  {(tab === "open" ? open : graded).length === 0 && (
                    <tr>
                      <td colSpan={9} className="px-3 py-8 text-center text-[11px] text-[#3a4033]">
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
    </div>
  );
}
