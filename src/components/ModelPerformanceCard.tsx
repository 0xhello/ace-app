"use client";

import { useEffect, useState } from "react";
import { TrendingUp, TrendingDown, Clock, ChevronDown, ChevronUp, Activity } from "lucide-react";
import { cn } from "@/lib/utils";

interface PickRow {
  game_id: string;
  commence_time: string;
  matchup: string;
  home_line: number;
  pick_side: string;
  pick_confidence: number;
  is_bet: boolean;
  result_status: string;
  correct: boolean | null;
  home_injury_impact: number;
  away_injury_impact: number;
  pinnacle_prob: number | null;
  edge_vs_pinnacle: number | null;
}

interface Stats {
  total: number;
  graded: number;
  pending: number;
  pushed: number;
  wins: number;
  losses: number;
  win_rate: number | null;
  roi: number | null;
  bets_total: number;
  bets_graded: number;
  bets_wins: number;
  bets_losses: number;
  bets_win_rate: number | null;
  bets_roi: number | null;
}

interface ApiResponse {
  stats: Stats | null;
  picks: PickRow[];
  refreshed_at: string;
}

function pct(n: number | null) {
  if (n === null) return "--";
  return `${(n * 100).toFixed(1)}%`;
}

function roi(n: number | null) {
  if (n === null) return "--";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${(n * 100).toFixed(1)}%`;
}

function ResultBadge({ status, correct }: { status: string; correct: boolean | null }) {
  if (status === "graded" && correct === true)
    return <span className="text-[8px] font-bold uppercase tracking-wider px-1.5 py-[2px] rounded bg-[#3ee68a]/10 text-[#3ee68a] border border-[#3ee68a]/20">WIN</span>;
  if (status === "graded" && correct === false)
    return <span className="text-[8px] font-bold uppercase tracking-wider px-1.5 py-[2px] rounded bg-[#ef4444]/10 text-[#ef4444] border border-[#ef4444]/20">LOSS</span>;
  if (status === "push")
    return <span className="text-[8px] font-bold uppercase tracking-wider px-1.5 py-[2px] rounded bg-[#f5c062]/10 text-[#f5c062] border border-[#f5c062]/20">PUSH</span>;
  return <span className="text-[8px] font-bold uppercase tracking-wider px-1.5 py-[2px] rounded bg-white/[0.04] text-[#6b7068] border border-[#22251f]">PEND</span>;
}

function StatCell({ label, value, highlight }: { label: string; value: string; highlight?: "green" | "red" | "neutral" }) {
  const color = highlight === "green" ? "text-[#3ee68a]" : highlight === "red" ? "text-[#ef6666]" : "text-white";
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className={cn("text-[14px] font-bold font-mono tabular-nums", color)}>{value}</span>
      <span className="text-[8px] uppercase tracking-[0.18em] text-[#5f665d]">{label}</span>
    </div>
  );
}

export default function ModelPerformanceCard() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [expanded, setExpanded] = useState(true);

  async function load() {
    try {
      const res = await fetch("/api/model-performance");
      if (res.ok) setData(await res.json());
    } catch { /* silent */ }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  if (!data || (!data.stats && data.picks.length === 0)) return null;

  const s = data.stats;
  const picks = data.picks;

  const roiValue = s?.bets_graded ? s.bets_roi : s?.roi ?? null;
  const roiHighlight: "green" | "red" | "neutral" =
    roiValue === null ? "neutral" : roiValue >= 0 ? "green" : "red";

  return (
    <div className="border-b border-[#1b201a] bg-[linear-gradient(180deg,rgba(11,13,11,0.96),rgba(9,10,9,0.98))]">
      <div className="px-5 pt-3 pb-3">
        <div className="ace-panel px-4 py-3.5">

          {/* Header */}
          <button
            onClick={() => setExpanded((v) => !v)}
            className="flex items-start justify-between gap-3 w-full pb-3 border-b border-[#1e231d]"
          >
            <div className="flex items-center gap-2">
              <div className="flex items-center justify-center h-6 w-6 rounded-lg bg-[#3ee68a]/10 border border-[#3ee68a]/15">
                <Activity className="h-3 w-3 text-[#3ee68a]" />
              </div>
              <span className="text-[11px] font-bold text-white uppercase tracking-[0.22em]">NBA Model</span>
              {s && s.pending > 0 && (
                <span className="flex items-center gap-1 text-[8px] font-mono text-[#f5c062] bg-[#f5c062]/8 border border-[#f5c062]/20 px-1.5 py-[2px] rounded">
                  <Clock className="h-2 w-2" />{s.pending} pending
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 text-[#5f665d]">
              <span className="text-[9px] text-[#5f665d]">
                {data.refreshed_at ? new Date(data.refreshed_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""}
              </span>
              {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </div>
          </button>

          {expanded && (
            <>
              {/* Stats row */}
              {s && (
                <div className="py-3 border-b border-[#1e231d]">
                  {s.bets_graded > 0 ? (
                    <>
                      <p className="text-[8px] uppercase tracking-[0.18em] text-[#5f665d] mb-2">Strong-signal bets ({s.bets_graded} graded)</p>
                      <div className="flex justify-around">
                        <StatCell label="Record" value={`${s.bets_wins}–${s.bets_losses}`} />
                        <StatCell label="Win %" value={pct(s.bets_win_rate)} highlight={s.bets_win_rate !== null ? (s.bets_win_rate >= 0.524 ? "green" : "red") : "neutral"} />
                        <StatCell label="ROI" value={roi(s.bets_roi)} highlight={roiHighlight} />
                        <StatCell label="Total bets" value={String(s.bets_total)} highlight="neutral" />
                      </div>
                    </>
                  ) : s.graded > 0 ? (
                    <>
                      <p className="text-[8px] uppercase tracking-[0.18em] text-[#5f665d] mb-2">All predictions ({s.graded} graded)</p>
                      <div className="flex justify-around">
                        <StatCell label="Record" value={`${s.wins}–${s.losses}`} />
                        <StatCell label="Win %" value={pct(s.win_rate)} highlight={s.win_rate !== null ? (s.win_rate >= 0.524 ? "green" : "red") : "neutral"} />
                        <StatCell label="ROI" value={roi(s.roi)} highlight={roiHighlight} />
                        <StatCell label="Logged" value={String(s.total)} highlight="neutral" />
                      </div>
                    </>
                  ) : (
                    <div className="flex items-center justify-center gap-3 py-2">
                      <p className="text-[10px] text-[#5f665d]">
                        {s.pending > 0
                          ? `${s.pending} prediction${s.pending === 1 ? "" : "s"} pending — check back after today's games`
                          : "No predictions logged yet"}
                      </p>
                    </div>
                  )}

                  {/* Breakeven note */}
                  {(s.bets_graded > 0 || s.graded > 0) && (
                    <p className="text-[8px] text-[#3a4033] text-center mt-2 font-mono">
                      break-even at -110 = 52.4%
                    </p>
                  )}
                </div>
              )}

              {/* Recent picks */}
              {picks.length > 0 && (
                <div className="pt-2.5 flex flex-col gap-1.5">
                  <p className="text-[8px] uppercase tracking-[0.18em] text-[#5f665d] mb-1">Recent picks</p>
                  {picks.map((p) => {
                    const hasInj = p.home_injury_impact > 0 || p.away_injury_impact > 0;
                    const injSide = p.home_injury_impact > p.away_injury_impact ? "home" : "away";
                    const pickTeam = p.pick_side === "home"
                      ? p.matchup.split(" @ ")[1] ?? "HOME"
                      : p.matchup.split(" @ ")[0] ?? "AWAY";
                    const pickLineValue = p.pick_side === "home" ? p.home_line : -p.home_line;
                    const pickLine = pickLineValue > 0 ? `+${pickLineValue}` : String(pickLineValue);
                    const confPct = Math.round(p.pick_confidence * 100);
                    const confColor = confPct >= 62 ? "#3ee68a" : confPct >= 58 ? "#87d7aa" : "#a3aca0";
                    const edge = p.edge_vs_pinnacle;
                    const edgeAbs = edge !== null ? Math.abs(edge) : null;
                    const edgePct = edge !== null
                      ? `${edge >= 0 ? "+" : ""}${(edge * 100).toFixed(1)}%`
                      : null;
                    const edgeColor = edgeAbs !== null
                      ? edgeAbs >= 0.06 ? "#3ee68a" : edgeAbs >= 0.04 ? "#87d7aa" : "#6b7068"
                      : "#3a4033";

                    return (
                      <div
                        key={p.game_id}
                        className="flex items-center gap-2 px-2.5 py-2 rounded-lg border border-[#1e231d] bg-[#0d0f0c]/60 hover:border-[#252b22] transition-colors"
                      >
                        {/* Matchup + pick */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-[10px] font-semibold text-white truncate">{p.matchup}</span>
                            {p.is_bet && (
                              <span className="text-[7px] font-bold uppercase tracking-wider px-1 py-[1px] rounded bg-[#3ee68a]/10 text-[#3ee68a] border border-[#3ee68a]/20 shrink-0">BET</span>
                            )}
                            {hasInj && (
                              <span className="text-[7px] font-bold uppercase tracking-wider px-1 py-[1px] rounded bg-[#f5c062]/8 text-[#f5c062] border border-[#f5c062]/20 shrink-0" title={`Injury: ${injSide} team`}>
                                INJ
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <span className="text-[9px] text-[#6b7068]">
                              {pickTeam} {p.home_line !== 0 ? pickLine : "PK"}
                            </span>
                            {edgePct && (
                              <span className="text-[8px] font-mono font-semibold" style={{ color: edgeColor }}>
                                vs PIN {edgePct}
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Confidence */}
                        <div className="flex flex-col items-center shrink-0">
                          <span className="text-[11px] font-bold font-mono" style={{ color: confColor }}>{confPct}</span>
                          <span className="text-[7px] uppercase tracking-[0.1em] text-[#3a4033]">signal</span>
                        </div>

                        {/* Result badge */}
                        <div className="shrink-0">
                          <ResultBadge status={p.result_status} correct={p.correct} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
