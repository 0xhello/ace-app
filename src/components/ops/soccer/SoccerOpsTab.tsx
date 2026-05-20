"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Activity, AlertTriangle, CheckCircle2, Clock,
  RefreshCw, Target, TrendingUp, Zap, Trophy, UserX,
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
} from "@/components/ops/shared/primitives";

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
interface WCInjury {
  team_name: string;
  player_name: string;
  status: "out" | "suspended" | "questionable";
  reason: string | null;
  updated_at: string;
}
interface WCPayload {
  worker: { lastPollAt: string | null; lastPollOk: boolean | null };
  jobs:   { fetch: JobMeta; grade: JobMeta };
  signals: SoccerSignal[];
  stats:   Stats;
  injuries: WCInjury[];
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

// ─── Local components ─────────────────────────────────────────────────────────
// Dot / Tag / KpiCard / SectionHead now come from shared/primitives so every
// tab uses the same visual vocabulary. SignalRow is soccer-specific and stays.

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
          {isGraded && won  && <StatusPill label="WIN"  tone="win"  />}
          {isGraded && lost && <StatusPill label="LOSS" tone="loss" />}
          {isOpen           && <StatusPill label="OPEN" tone="open" />}
          {sig.status === "void" && <StatusPill label="VOID" tone="void" />}
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
      // API expects "fetch_signals" / "grade_results" — translate from
      // the short UI label so older button code keeps working.
      const apiJob = job === "fetch" ? "fetch_signals" : "grade_results";
      await fetch("/api/ops/soccer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job: apiJob }),
      });
    } catch { /* ignore */ }
    finally { await loadAll(); setRunning(null); }
  }

  const WC_START = new Date("2026-06-11");
  const daysOut  = Math.ceil((WC_START.getTime() - Date.now()) / 86_400_000);
  const preEvent = daysOut > 0;

  if (loading) return <LoadingState />;

  const stats   = data?.stats;
  const signals = data?.signals ?? [];
  const open    = signals.filter((s) => s.status === "open");
  const graded  = signals.filter((s) => s.status === "graded");

  const fetchMeta = data?.jobs.fetch;
  const gradeMeta = data?.jobs.grade;

  const errorMessages: string[] = [];
  if (fetchMeta?.lastError) errorMessages.push(`Scan error: ${fetchMeta.lastError.slice(0, 80)}`);
  if (gradeMeta?.lastError) errorMessages.push(`Grade error: ${gradeMeta.lastError.slice(0, 80)}`);

  return (
    <div className="flex-1 overflow-y-auto bg-[#0a0b0a]">
      <div className="max-w-[1200px] mx-auto px-6 py-7 space-y-5">

        {/* Header — shared shape with NBA / MLB / Overview */}
        <OpsPageHeader
          icon={Trophy}
          title="FIFA World Cup 2026"
          tag={preEvent ? `in ${daysOut}d` : "live"}
          tagColor={preEvent ? "#6b7068" : "#3ee68a"}
          actions={
            <>
              <ActionButton
                icon={CheckCircle2}
                label={running === "grade" ? "Grading…" : "Grade"}
                busy={running === "grade"}
                disabled={running !== null}
                onClick={() => runJob("grade")}
              />
              <ActionButton
                icon={Zap}
                label={running === "fetch" ? "Scanning…" : "Scan"}
                variant="primary"
                busy={running === "fetch"}
                disabled={running !== null}
                onClick={() => runJob("fetch")}
              />
              <ActionButton
                icon={RefreshCw}
                variant="subtle"
                onClick={loadAll}
              />
            </>
          }
        />

        {/* Worker / scan / grade status strip — shared shape across tabs */}
        <WorkerStatusStrip
          worker={data?.worker}
          fetch={fetchMeta}
          grade={gradeMeta}
        />

        {/* Errors */}
        <ErrorBanner messages={errorMessages} />

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

        {/* ══ PLAYER AVAILABILITY ═════════════════════════════════════════════ */}
        {data?.injuries && data.injuries.length > 0 && (
          <div className="rounded-xl border border-[#181c18] bg-[#0d0f0d] p-5">
            <SectionHead
              title="Player availability"
              icon={UserX}
              right={
                <div className="flex items-center gap-3 text-[10px]">
                  <span className="text-[#ef4444]">
                    {data.injuries.filter(i => i.status === "out").length} out
                  </span>
                  <span className="text-[#f5c062]">
                    {data.injuries.filter(i => i.status === "suspended").length} suspended
                  </span>
                  <span className="text-[#9ca39a]">
                    {data.injuries.filter(i => i.status === "questionable").length} doubtful
                  </span>
                </div>
              }
            />
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {data.injuries.slice(0, 18).map((inj, i) => {
                const tone = inj.status === "out" ? {
                  bg: "bg-[#ef4444]/[0.06]",
                  border: "border-[#ef4444]/15",
                  text: "text-[#ef8b8b]",
                  label: "OUT",
                } : inj.status === "suspended" ? {
                  bg: "bg-[#f5c062]/[0.06]",
                  border: "border-[#f5c062]/15",
                  text: "text-[#f5c062]",
                  label: "SUSP",
                } : {
                  bg: "bg-[#6b7068]/[0.06]",
                  border: "border-[#6b7068]/15",
                  text: "text-[#9ca39a]",
                  label: "QUES",
                };
                return (
                  <div
                    key={`${inj.team_name}-${inj.player_name}-${i}`}
                    className={`flex items-center gap-2 rounded-lg border ${tone.border} ${tone.bg} px-2.5 py-2 min-w-0`}
                  >
                    <span className={`text-[8px] font-bold tracking-widest ${tone.text} shrink-0`}>
                      {tone.label}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-semibold text-white truncate">{inj.player_name}</p>
                      <p className="text-[9px] text-[#6b7068] truncate">
                        {inj.team_name}{inj.reason ? ` · ${inj.reason}` : ""}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
            {data.injuries.length > 18 && (
              <p className="text-[10px] text-[#4a524a] mt-3 text-center">
                Showing 18 of {data.injuries.length} unavailable players
              </p>
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
