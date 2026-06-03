/**
 * /performance — the public credibility surface.
 *
 * No auth required. The page subscribers visit when they're deciding
 * whether to trust the system. Shows graded picks with W/L/CLV + per-sport
 * breakdown + a live ledger of recent picks. No marketing copy — the data
 * IS the marketing.
 *
 * Design philosophy:
 *   - Honest: graded picks shown verbatim, including losses
 *   - Stratified: per-sport breakdown reveals where edge is strongest
 *   - CLV-forward: the metric that proves the edge is real, prominent
 *   - Mobile-friendly: half the traffic will land here from phones
 *
 * Pending picks are shown WITHOUT actionable edge data (already gated
 * server-side) so non-subscribers can see the system is live without
 * getting tonight's bets for free.
 */
"use client";

import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/Skeleton";

interface Explanation {
  headline: string;
  why: string;
  caveat: string;
}

interface Pick {
  sport: "nba" | "mlb" | "soccer";
  tournament: string | null;
  game_date: string;
  detected_at: string | null;
  matchup: string;
  market: string;
  bet_side: string;
  line: number | null;
  book: string | null;
  book_odds: number | null;
  status: string;
  correct: number | null;
  edge_pp: number | null;
  pinnacle_prob: number | null;
  prior_prob: number | null;
  clv_pp: number | null;
  confidence_tier: "A" | "B" | "C" | null;
  // AI Pick Explainer — only populated for soccer right now. Uses our
  // StatsBomb historical g/90, club form, and intl uplift to generate
  // a 3-part rationale per signal. This is the differentiator.
  explanation?: Explanation | null;
}

interface SportStat {
  sport: string;
  label: string;
  graded: number;
  wins: number;
  losses: number;
  win_rate: number | null;
  roi: number | null;
  avg_clv: number | null;
  positive_clv_pct: number | null;
}

interface PerformanceResponse {
  total: {
    graded: number;
    wins: number;
    losses: number;
    win_rate: number | null;
    roi: number | null;
    avg_clv: number | null;
  };
  by_sport: SportStat[];
  recent: Pick[];
  pending_count: number;
  refreshed_at: string;
}

const SPORT_EMOJI: Record<string, string> = { nba: "🏀", mlb: "⚾", soccer: "⚽" };
const SPORT_ACCENT: Record<string, string> = {
  nba: "#f5c062", mlb: "#7ab8ff", soccer: "#3ee68a",
};

function fmtPct(v: number | null): string {
  return v !== null && !Number.isNaN(v) ? `${(v * 100).toFixed(1)}%` : "—";
}
function fmtSignedPct(v: number | null): string {
  if (v === null || Number.isNaN(v)) return "—";
  const s = (v * 100).toFixed(1);
  return v > 0 ? `+${s}%` : `${s}%`;
}
function fmtPp(v: number | null): string {
  if (v === null || Number.isNaN(v)) return "—";
  const s = (v * 100).toFixed(1);
  return v > 0 ? `+${s}pp` : `${s}pp`;
}
function fmtOdds(v: number | null): string {
  if (v === null) return "—";
  return v >= 0 ? `+${v}` : `${v}`;
}
function marketLabel(m: string): string {
  if (m === "h2h") return "ML";
  if (m === "spreads" || m === "asian_handicap") return "AH";
  if (m === "run_line") return "RL";
  if (m === "totals") return "TOT";
  if (m === "player_goal_scorer_anytime") return "Scorer";
  return m;
}

export default function PerformancePage() {
  const [data, setData] = useState<PerformanceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [sportFilter, setSportFilter] = useState<"all" | "nba" | "mlb" | "soccer">("all");

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/performance/public?limit=50", { cache: "no-store" });
        setData((await res.json()) as PerformanceResponse);
      } catch { /* silent */ }
      finally { setLoading(false); }
    })();
  }, []);

  if (loading) {
    // Mirror the real layout so the load reads as intentional, not blank.
    return (
      <div className="min-h-screen bg-[#0a0b0a] text-white">
        <div className="border-b border-[#1e2220]">
          <div className="max-w-[1100px] mx-auto px-6 py-8 space-y-3">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-9 w-[min(100%,520px)]" />
            <Skeleton className="h-4 w-[min(100%,640px)]" />
          </div>
        </div>
        <div className="max-w-[1100px] mx-auto px-6 py-8 space-y-8">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="ace-kpi space-y-2.5">
                <Skeleton className="h-2.5 w-20" />
                <Skeleton className="h-7 w-24" />
                <Skeleton className="h-2.5 w-16" />
              </div>
            ))}
          </div>
          <div className="ace-panel-muted overflow-hidden">
            <div className="px-3 py-3 border-b border-[#1e2220]">
              <Skeleton className="h-3 w-32" />
            </div>
            <div className="divide-y divide-[#141714]">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-3 py-3">
                  <Skeleton className="h-3 flex-1" />
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-3 w-12" />
                  <Skeleton className="h-3 w-10" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0a0b0a] text-[#ef4444]">
        <p>Couldn&apos;t load performance data.</p>
      </div>
    );
  }

  const filtered = sportFilter === "all"
    ? data.recent
    : data.recent.filter((p) => p.sport === sportFilter);

  return (
    <div className="min-h-screen bg-[#0a0b0a] text-white">
      {/* Header */}
      <div className="border-b border-[#1e2220]">
        <div className="max-w-[1100px] mx-auto px-6 py-8">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div>
              <p className="text-[10px] font-bold text-[#3ee68a] uppercase tracking-[0.22em] mb-2">
                ACE · live track record
              </p>
              <h1 className="text-[28px] md:text-[36px] font-bold leading-tight">
                Every graded pick. Every result. No edits.
              </h1>
              <p className="text-[13px] text-[#9ca39a] mt-3 max-w-2xl leading-relaxed">
                We don&apos;t cherry-pick — every signal we&apos;ve fired across NBA, MLB, and soccer is below.
                Wins, losses, the closing-line value we beat or missed.
                Updated continuously as games grade.
              </p>
            </div>
            <a
              href="/"
              className="text-[10px] uppercase tracking-[0.15em] text-[#6b7068] hover:text-white border border-[#1e2220] hover:border-[#2e332a] rounded-lg px-4 py-2 transition-colors"
            >
              ← Back to ACE
            </a>
          </div>
        </div>
      </div>

      <div className="max-w-[1100px] mx-auto px-6 py-8 space-y-8">

        {/* Headline KPIs — the four numbers that matter most */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <BigStat label="Graded picks"
            value={data.total.graded.toLocaleString()}
            sub={`${data.total.wins}W / ${data.total.losses}L`} />
          <BigStat label="Win rate"
            value={fmtPct(data.total.win_rate)}
            sub="break-even: 52.4%"
            color={tone(data.total.win_rate, 0.524)} />
          <BigStat label="ROI"
            value={fmtSignedPct(data.total.roi)}
            sub="flat units at -110"
            color={tone(data.total.roi, 0)} />
          <BigStat label="Avg CLV"
            value={fmtPp(data.total.avg_clv)}
            sub="how often we beat the close"
            color={tone(data.total.avg_clv, 0)} />
        </div>

        {/* What CLV is — explains the most important / least understood metric */}
        <div className="rounded-xl border border-[#3ee68a]/15 bg-[#3ee68a]/[0.03] px-5 py-4 text-[12px] leading-relaxed text-[#9ca39a]">
          <p className="font-bold text-[#3ee68a] mb-1.5 uppercase tracking-[0.15em] text-[10px]">
            What CLV means
          </p>
          Closing line value — the difference between the price we&apos;d bet at and the line at kickoff.
          Beating the close consistently is the strongest forward-looking signal a betting model is real.
          A handful of lucky wins won&apos;t move CLV. Sustained positive CLV is the metric sharps and
          public bettors agree predicts long-term ROI.
        </div>

        {/* Per-sport breakdown */}
        <div>
          <h2 className="text-[10px] font-bold text-[#3ee68a] uppercase tracking-[0.22em] mb-3">
            By sport
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {data.by_sport.map((s) => (
              <SportCard key={s.sport} stat={s} />
            ))}
          </div>
        </div>

        {/* Recent picks ledger */}
        <div>
          <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
            <h2 className="text-[10px] font-bold text-[#3ee68a] uppercase tracking-[0.22em]">
              Recent picks · last {data.recent.length}
            </h2>
            <div className="flex border border-[#1e2220] rounded-lg overflow-hidden text-[10px]">
              {(["all", "nba", "mlb", "soccer"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setSportFilter(s)}
                  className={`px-3 py-1.5 uppercase tracking-[0.15em] transition-colors ${
                    sportFilter === s
                      ? "bg-[#3ee68a]/15 text-[#3ee68a]"
                      : "text-[#6b7068] hover:text-white"
                  }`}
                >
                  {s === "all" ? "All" : s.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-[#181c18] bg-[#0d0f0d] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[11px] font-mono">
                <thead className="text-[#6b7068] uppercase tracking-[0.12em] border-b border-[#1e2220] bg-[#0a0b0a]">
                  <tr>
                    <th className="py-2.5 px-3 font-semibold">Date</th>
                    <th className="py-2.5 px-3 font-semibold">Sport</th>
                    <th className="py-2.5 px-3 font-semibold">Matchup</th>
                    <th className="py-2.5 px-3 font-semibold">Pick</th>
                    <th className="py-2.5 px-3 font-semibold">Book</th>
                    <th className="py-2.5 px-3 font-semibold text-right">CLV</th>
                    <th className="py-2.5 px-3 font-semibold text-center">Result</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#141714]">
                  {filtered.slice(0, 30).map((p, idx) => (
                    <PickRow key={`${p.matchup}-${p.market}-${p.bet_side}-${idx}`} pick={p} />
                  ))}
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={7} className="py-8 px-3 text-center text-[11px] text-[#6b7068]">
                        No graded picks yet in this sport. The track record will populate as games settle.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="px-3 py-2 border-t border-[#1e2220] text-[10px] text-[#4a524a] uppercase tracking-[0.12em] text-center">
              {data.pending_count > 0
                ? `${data.pending_count} picks pending — subscribers see them tonight`
                : "live · refreshed " + new Date(data.refreshed_at).toLocaleString()}
            </div>
          </div>
        </div>

        {/* Tail message — clear next step */}
        <div className="rounded-xl border border-[#181c18] bg-[#0d0f0d] px-6 py-8 text-center">
          <p className="text-[14px] text-[#c4c7c0] mb-3 font-semibold">
            Every pick above was logged before the game finished.
          </p>
          <p className="text-[12px] text-[#6b7068] max-w-xl mx-auto leading-relaxed">
            ACE detects when soft books diverge from sharp pricing and surfaces those gaps in real time.
            We don&apos;t edit history. We don&apos;t hide losses. The track record is the product.
          </p>
          <a
            href="/"
            className="inline-block mt-5 text-[11px] uppercase tracking-[0.18em] font-bold text-[#0a0b0a] bg-[#3ee68a] hover:bg-[#5ef0a0] rounded-lg px-6 py-2.5 transition-colors"
          >
            See live picks →
          </a>
        </div>

      </div>
    </div>
  );
}

// ─── Subcomponents ───────────────────────────────────────────────────────────

function tone(v: number | null, breakEven: number): "good" | "bad" | "neutral" {
  if (v === null) return "neutral";
  if (v > breakEven + 0.005) return "good";
  if (v < breakEven - 0.005) return "bad";
  return "neutral";
}

function BigStat({
  label, value, sub, color = "neutral",
}: { label: string; value: string; sub?: string; color?: "good" | "bad" | "neutral" }) {
  const c = color === "good" ? "#3ee68a" : color === "bad" ? "#ef4444" : "#ffffff";
  return (
    <div className="rounded-xl border border-[#181c18] bg-[#0d0f0d] px-4 py-4">
      <p className="text-[10px] text-[#6b7068] uppercase tracking-[0.15em] mb-2">{label}</p>
      <p className="text-[24px] md:text-[28px] font-black font-mono tabular-nums leading-none" style={{ color: c }}>
        {value}
      </p>
      {sub && <p className="text-[10px] text-[#4a524a] mt-2">{sub}</p>}
    </div>
  );
}

function SportCard({ stat }: { stat: SportStat }) {
  const accent = SPORT_ACCENT[stat.sport] || "#9ca39a";
  return (
    <div className="rounded-xl border border-[#181c18] bg-[#0d0f0d] p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[14px] font-bold flex items-center gap-2">
          <span style={{ color: accent }}>{SPORT_EMOJI[stat.sport] || "—"}</span>
          {stat.label}
        </p>
        <span className="text-[10px] text-[#6b7068]">{stat.graded} graded</span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <MiniStat label="Win %" value={fmtPct(stat.win_rate)}
          color={tone(stat.win_rate, 0.524)} />
        <MiniStat label="ROI" value={fmtSignedPct(stat.roi)}
          color={tone(stat.roi, 0)} />
        <MiniStat label="CLV" value={fmtPp(stat.avg_clv)}
          color={tone(stat.avg_clv, 0)} />
      </div>
    </div>
  );
}

function MiniStat({
  label, value, color = "neutral",
}: { label: string; value: string; color: "good" | "bad" | "neutral" }) {
  const c = color === "good" ? "#3ee68a" : color === "bad" ? "#ef4444" : "#c4c7c0";
  return (
    <div className="rounded border border-[#1a1e1a] bg-[#0a0b0a] px-2 py-1.5">
      <p className="text-[8px] text-[#6b7068] uppercase tracking-[0.15em]">{label}</p>
      <p className="text-[14px] font-bold font-mono mt-0.5" style={{ color: c }}>{value}</p>
    </div>
  );
}

function PickRow({ pick }: { pick: Pick }) {
  const [open, setOpen] = useState(false);
  const isGraded = pick.status === "graded" || pick.status === "proxy_captured";
  const won = pick.correct === 1;
  const lost = pick.correct === 0;
  const accent = SPORT_ACCENT[pick.sport] || "#9ca39a";
  const hasExplanation = !!pick.explanation?.headline;

  return (
    <>
    <tr
      className={`text-[#c4c7c0] ${hasExplanation ? "cursor-pointer hover:bg-[#0f120f]" : ""} transition-colors`}
      onClick={hasExplanation ? () => setOpen(!open) : undefined}
    >
      <td className="py-2 px-3 text-[#9ca39a] whitespace-nowrap">
        {hasExplanation && (
          <span className="inline-block w-3 text-[#4a524a] text-[10px] mr-1">
            {open ? "▾" : "▸"}
          </span>
        )}
        {pick.game_date}
      </td>
      <td className="py-2 px-3 whitespace-nowrap">
        <span style={{ color: accent }}>{SPORT_EMOJI[pick.sport]}</span>{" "}
        <span className="text-[10px] text-[#6b7068] uppercase tracking-[0.1em]">
          {pick.tournament ?? pick.sport.toUpperCase()}
        </span>
      </td>
      <td className="py-2 px-3 truncate max-w-[200px]">{pick.matchup}</td>
      <td className="py-2 px-3 text-white">
        <span className="text-[#6b7068]">{marketLabel(pick.market)} </span>
        {pick.bet_side.toUpperCase()}
        {pick.line != null && (
          <span className="text-[#9ca39a]"> {pick.line > 0 ? `+${pick.line}` : pick.line}</span>
        )}
      </td>
      <td className="py-2 px-3">
        {pick.book ? (
          <>
            <span className="text-[#9ca39a]">{pick.book}</span>{" "}
            <span className="text-white">{fmtOdds(pick.book_odds)}</span>
          </>
        ) : <span className="text-[#3a4033]">—</span>}
      </td>
      <td className="py-2 px-3 text-right" style={{
        color: pick.clv_pp == null ? "#3a4033"
          : pick.clv_pp > 0 ? "#3ee68a" : "#ef4444",
      }}>
        {pick.clv_pp != null ? fmtPp(pick.clv_pp) : "—"}
      </td>
      <td className="py-2 px-3 text-center">
        {isGraded && won && (
          <span className="inline-block px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-[0.1em] bg-[#3ee68a]/20 text-[#3ee68a]">
            WIN
          </span>
        )}
        {isGraded && lost && (
          <span className="inline-block px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-[0.1em] bg-[#ef4444]/20 text-[#ef4444]">
            LOSS
          </span>
        )}
        {pick.status === "open" && (
          <span className="inline-block px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-[0.1em] bg-[#6b7068]/15 text-[#9ca39a]">
            PENDING
          </span>
        )}
        {pick.status === "void" && (
          <span className="inline-block px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-[0.1em] bg-[#6b7068]/15 text-[#6b7068]">
            VOID
          </span>
        )}
      </td>
    </tr>
    {/* Expanded "why this pick" — the differentiator. Uses StatsBomb
        historical g/90, club form, intl uplift, and the divergence math
        to give every pick a 3-part rationale. */}
    {open && hasExplanation && pick.explanation && (
      <tr className="bg-[#0a0b0a]">
        <td colSpan={7} className="px-6 py-4 border-y border-[#3ee68a]/15">
          <div className="space-y-3 max-w-3xl">
            <p className="text-[12px] font-semibold text-[#3ee68a]">
              {pick.explanation.headline}
            </p>
            <p className="text-[11px] leading-relaxed text-[#c4c7c0]">
              <span className="text-[10px] font-bold text-[#6b7068] uppercase tracking-[0.15em] mr-2">Why</span>
              {pick.explanation.why}
            </p>
            <p className="text-[11px] leading-relaxed text-[#9ca39a]">
              <span className="text-[10px] font-bold text-[#f5c062] uppercase tracking-[0.15em] mr-2">Caveat</span>
              {pick.explanation.caveat}
            </p>
          </div>
        </td>
      </tr>
    )}
    </>
  );
}
