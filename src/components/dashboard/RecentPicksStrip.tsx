"use client";

/**
 * RecentPicksStrip — public-facing track record of recent ACE picks.
 *
 * Sits under FeaturedPickCard. Builds trust by showing the receipts:
 * what picks we made, when they settled, and how they did.
 *
 * Hierarchy (top → bottom):
 *   1. Summary KPI strip: Record · ROI · CLV. Three numbers, mono,
 *      no card boxes — divide-x rule between them.
 *   2. Recent picks list (last 10): one row per pick. Fixture +
 *      bet on the left, status + P&L on the right.
 *   3. Tiny footer: "data refreshed Xm ago · 30-day rolling window"
 *
 * Restraint notes:
 *   - No emojis. Lucide icons w/ strokeWidth 1.5.
 *   - No badge spam — status colored via text + small dot only.
 *   - Mono font for numbers; sans-serif for prose.
 *   - Loading skeleton, empty, error states all covered.
 *   - Rows use divide-y, not nested cards.
 */
import { useEffect, useState } from "react";
import { TrendingUp, TrendingDown, MinusSquare, Clock } from "lucide-react";

interface HistoryPick {
  id: number;
  fixture_label: string;
  tournament: string;
  commence_time: string | null;
  market: string;
  side: string;
  bet_label: string;
  stake_units: number;
  opening_price: number;
  opening_book: string;
  closing_price: number | null;
  closing_book: string | null;
  clv_pp: number | null;
  graded_status: string;
  pnl_units: number | null;
  approved_at: string;
  graded_at: string | null;
}

interface HistorySummary {
  total: number;
  open: number;
  graded: number;
  wins: number;
  losses: number;
  pushes: number;
  win_rate: number | null;
  pnl_units: number;
  staked_units: number;
  roi: number | null;
  avg_clv_pp: number | null;
  clv_sample: number;
}

interface HistoryResponse {
  picks: HistoryPick[];
  summary: HistorySummary;
  refreshed_at: string;
}

function fmtAmerican(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}
function fmtPct(p: number | null, digits = 1): string {
  if (p === null) return "—";
  return `${(p * 100).toFixed(digits)}%`;
}
function fmtPp(p: number | null): string {
  if (p === null) return "—";
  return `${p >= 0 ? "+" : ""}${(p * 100).toFixed(1)}pp`;
}
function fmtUnits(n: number | null, withSign = true): string {
  if (n === null) return "—";
  const sign = withSign && n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}u`;
}
function fmtDateShort(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
    }).format(d);
  } catch {
    return "—";
  }
}

export default function RecentPicksStrip() {
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch("/api/picks/history?limit=10", { cache: "no-store" });
        const json = (await r.json()) as HistoryResponse;
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "load failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, []);

  if (loading) return <Skeleton />;
  if (error)   return null;        // graceful: just hide if API blew up
  if (!data)   return null;
  // No picks ever recorded → hide rather than show an awkward empty record
  if (data.summary.total === 0) return null;

  const { picks, summary } = data;

  return (
    <section className="
      mx-4 md:mx-6 mt-3 md:mt-4 rounded-2xl
      bg-[#0d0f0d] border border-[#181c18]
      shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]
      overflow-hidden
    ">
      {/* Header — eyebrow + small refresh stamp */}
      <header className="
        flex items-center justify-between gap-3
        px-5 md:px-7 pt-5 pb-3 border-b border-[#181c18]/50
      ">
        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#9ca39a]">
          Track record · last 10
        </p>
        <span className="text-[10px] font-mono text-[#4a524a]">
          {summary.graded} graded · {summary.open} open
        </span>
      </header>

      {/* Summary strip — three numbers, divided by 1px rules */}
      <div className="grid grid-cols-3 divide-x divide-[#181c18] border-b border-[#181c18]">
        <SummaryStat
          label="Record"
          value={
            summary.graded > 0
              ? `${summary.wins}–${summary.losses}${summary.pushes > 0 ? `–${summary.pushes}P` : ""}`
              : "—"
          }
          sub={summary.graded > 0 ? `${fmtPct(summary.win_rate, 0)} win rate` : "—"}
          tone="neutral"
        />
        <SummaryStat
          label="P&L"
          value={summary.graded > 0 ? fmtUnits(summary.pnl_units) : "—"}
          sub={summary.graded > 0 ? `on ${summary.staked_units.toFixed(1)}u staked` : "—"}
          tone={summary.pnl_units > 0 ? "positive" : summary.pnl_units < 0 ? "negative" : "neutral"}
        />
        <SummaryStat
          label="Avg CLV"
          value={fmtPp(summary.avg_clv_pp)}
          sub={summary.avg_clv_pp !== null ? `on ${summary.clv_sample} closed` : "—"}
          tone={
            summary.avg_clv_pp !== null
              ? summary.avg_clv_pp >= 0 ? "positive" : "negative"
              : "neutral"
          }
        />
      </div>

      {/* Pick rows */}
      <ul className="divide-y divide-[#181c18]">
        {picks.slice(0, 10).map((p) => (
          <PickRow key={p.id} pick={p} />
        ))}
      </ul>

      {/* Footer */}
      <div className="px-5 md:px-7 py-3 text-[9px] font-mono uppercase tracking-wider text-[#3a4033] text-right">
        CLV = market move toward our side after we picked. positive = we beat the close.
      </div>
    </section>
  );
}

// ─── Summary stat — same pattern as FeaturedPickCard ────────────────────────

function SummaryStat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone: "positive" | "negative" | "neutral";
}) {
  const valueColor =
    tone === "positive" ? "text-[#3ee68a]" :
    tone === "negative" ? "text-[#ef4444]" :
    "text-white";
  return (
    <div className="px-5 md:px-7 py-4">
      <p className="text-[9px] uppercase tracking-[0.22em] text-[#6b7068] font-semibold mb-1.5">
        {label}
      </p>
      <p className={`font-mono font-black text-[20px] md:text-[22px] tracking-tight leading-none ${valueColor}`}>
        {value}
      </p>
      <p className="text-[10px] text-[#6b7068] mt-1.5 leading-tight">{sub}</p>
    </div>
  );
}

// ─── Pick row ───────────────────────────────────────────────────────────────

function PickRow({ pick }: { pick: HistoryPick }) {
  const isOpen = pick.graded_status === "open";
  const won = pick.graded_status === "won";
  const lost = pick.graded_status === "lost";
  const push = pick.graded_status === "push";

  const StatusIcon = won
    ? TrendingUp
    : lost ? TrendingDown
    : push ? MinusSquare
    : Clock;

  const statusColor = won ? "#3ee68a" : lost ? "#ef4444" : push ? "#9ca39a" : "#f5c062";
  const statusText  = won ? "Won" : lost ? "Lost" : push ? "Push" : "Open";

  return (
    <li className="
      grid grid-cols-[1.2fr_1fr_88px_84px] gap-3
      items-center px-5 md:px-7 py-3
      hover:bg-[#0f1310] transition-colors
    ">
      {/* Fixture + tournament */}
      <div className="min-w-0">
        <p className="text-[12px] text-white font-semibold truncate">
          {pick.fixture_label}
        </p>
        <p className="text-[10px] text-[#6b7068] font-mono">
          {pick.tournament} · {fmtDateShort(pick.commence_time)}
        </p>
      </div>
      {/* Bet */}
      <div className="min-w-0">
        <p className="text-[12px] text-[#c4c7c0] truncate">{pick.bet_label}</p>
        <p className="text-[10px] text-[#6b7068] font-mono">
          {pick.opening_book} {fmtAmerican(pick.opening_price)} · {pick.stake_units.toFixed(2)}u
        </p>
      </div>
      {/* CLV */}
      <div className="text-right">
        <p className="text-[9px] uppercase tracking-wider text-[#4a524a]">CLV</p>
        <p
          className="text-[11px] font-mono font-bold"
          style={{
            color: pick.clv_pp !== null
              ? pick.clv_pp >= 0 ? "#3ee68a" : "#ef4444"
              : "#3a4033",
          }}
        >
          {fmtPp(pick.clv_pp)}
        </p>
      </div>
      {/* Status / P&L */}
      <div className="text-right flex items-center justify-end gap-1.5">
        <StatusIcon className="h-3.5 w-3.5 shrink-0" style={{ color: statusColor }} strokeWidth={1.5} />
        <div>
          <p
            className="text-[11px] font-bold font-mono leading-none"
            style={{ color: statusColor }}
          >
            {isOpen ? statusText : (pick.pnl_units !== null ? fmtUnits(pick.pnl_units) : statusText)}
          </p>
          {!isOpen && pick.pnl_units !== null && (
            <p className="text-[9px] text-[#6b7068] font-mono mt-0.5">{statusText}</p>
          )}
        </div>
      </div>
    </li>
  );
}

// ─── Loading skeleton ───────────────────────────────────────────────────────

function Skeleton() {
  return (
    <section className="
      mx-4 md:mx-6 mt-3 md:mt-4 rounded-2xl
      bg-[#0d0f0d] border border-[#181c18]
      shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]
    ">
      <div className="px-5 md:px-7 pt-5 pb-3 border-b border-[#181c18]/50 flex items-center justify-between">
        <div className="h-2.5 w-32 rounded bg-[#1a1e1a] animate-pulse" />
        <div className="h-2 w-16 rounded bg-[#1a1e1a] animate-pulse" />
      </div>
      <div className="grid grid-cols-3 divide-x divide-[#181c18] border-b border-[#181c18]">
        {[0,1,2].map((i) => (
          <div key={i} className="px-5 md:px-7 py-4 space-y-2">
            <div className="h-2 w-16 rounded bg-[#1a1e1a] animate-pulse" />
            <div className="h-5 w-20 rounded bg-[#1a1e1a] animate-pulse" />
            <div className="h-2 w-24 rounded bg-[#1a1e1a] animate-pulse" />
          </div>
        ))}
      </div>
      <ul className="divide-y divide-[#181c18]">
        {[0,1,2,3].map((i) => (
          <li key={i} className="px-5 md:px-7 py-4 grid grid-cols-[1.2fr_1fr_88px_84px] gap-3">
            <div className="space-y-1.5">
              <div className="h-3 w-3/4 rounded bg-[#1a1e1a] animate-pulse" />
              <div className="h-2 w-1/2 rounded bg-[#1a1e1a] animate-pulse" />
            </div>
            <div className="space-y-1.5">
              <div className="h-3 w-2/3 rounded bg-[#1a1e1a] animate-pulse" />
              <div className="h-2 w-1/2 rounded bg-[#1a1e1a] animate-pulse" />
            </div>
            <div className="h-2.5 rounded bg-[#1a1e1a] animate-pulse" />
            <div className="h-2.5 rounded bg-[#1a1e1a] animate-pulse" />
          </li>
        ))}
      </ul>
    </section>
  );
}
