"use client";

/**
 * BankrollCurve — cumulative P&L over the last N graded picks.
 *
 * Premium dark line chart, raw SVG (no chart lib). Sits between
 * FeaturedPickCard and RecentPicksStrip on the soccer tab.
 *
 * Hierarchy:
 *   1. Tiny eyebrow + headline number (latest cumulative P&L)
 *   2. The curve — full-width SVG with a soft gradient fill underneath
 *      and a single 1.5px stroke. Zero-line drawn dashed.
 *   3. Footnote with sample size.
 *
 * Restraint:
 *   - One accent color only (emerald on positive, red on negative).
 *   - No glow, no neon. Subtle radial-style gradient fill under the curve.
 *   - Monospace for the headline P&L number; sans-serif for prose.
 *   - Auto-hides when sample is < 3 (not enough signal to chart).
 *
 * Data: pulls /api/picks/history?limit=30, walks graded rows in
 * approval-order, accumulates pnl_units → builds the points.
 */
import { useEffect, useMemo, useState } from "react";
import { TrendingUp, TrendingDown } from "lucide-react";

interface HistoryPick {
  id: number;
  graded_status: string;
  pnl_units: number | null;
  approved_at: string;
  graded_at: string | null;
}

interface HistoryResponse {
  picks: HistoryPick[];
}

function fmtUnits(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}u`;
}

export default function BankrollCurve() {
  const [picks, setPicks] = useState<HistoryPick[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/picks/history?limit=50", { cache: "no-store" })
      .then((r) => r.json())
      .then((json: HistoryResponse) => {
        if (!cancelled) setPicks(json.picks ?? []);
      })
      .catch(() => { /* silent */ })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  // Build the curve points: oldest → newest, cumulative pnl per graded pick.
  const series = useMemo(() => {
    const graded = picks
      .filter((p) => p.graded_status === "won" || p.graded_status === "lost" || p.graded_status === "push")
      .filter((p) => p.pnl_units !== null)
      .sort((a, b) => {
        const ta = new Date(a.graded_at ?? a.approved_at).getTime();
        const tb = new Date(b.graded_at ?? b.approved_at).getTime();
        return ta - tb;
      });
    let cum = 0;
    const pts: Array<{ n: number; cum: number }> = [{ n: 0, cum: 0 }];
    graded.forEach((p, idx) => {
      cum += p.pnl_units ?? 0;
      pts.push({ n: idx + 1, cum });
    });
    return pts;
  }, [picks]);

  // Need a meaningful sample to chart
  if (loading) return <Skeleton />;
  if (series.length < 4) return null;

  const finalCum = series[series.length - 1].cum;
  const positive = finalCum >= 0;
  const accentColor = positive ? "#3ee68a" : "#ef4444";
  const accentSoft  = positive ? "rgba(62, 230, 138, 0.12)" : "rgba(239, 68, 68, 0.12)";

  // Chart geometry — fixed viewBox, responsive width via CSS.
  const W = 800;
  const H = 160;
  const padL = 16, padR = 16, padT = 18, padB = 14;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const xs = series.map((p) => p.n);
  const ys = series.map((p) => p.cum);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(0, ...ys);
  const yMax = Math.max(0, ...ys);
  const yRange = yMax - yMin || 1;

  const project = (n: number, cum: number) => {
    const x = padL + ((n - xMin) / (xMax - xMin || 1)) * innerW;
    const y = padT + innerH - ((cum - yMin) / yRange) * innerH;
    return { x, y };
  };

  const pathD = series
    .map(({ n, cum }, i) => {
      const { x, y } = project(n, cum);
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  // Area-fill path: line down to bottom of viewBox, then close
  const lastPt = project(series[series.length - 1].n, series[series.length - 1].cum);
  const firstPt = project(series[0].n, series[0].cum);
  const areaD = `${pathD} L${lastPt.x.toFixed(2)},${(padT + innerH).toFixed(2)} L${firstPt.x.toFixed(2)},${(padT + innerH).toFixed(2)} Z`;

  // Zero line (only if zero is inside the y-range)
  const zeroIn = yMin < 0 && yMax > 0;
  const zeroY = padT + innerH - ((0 - yMin) / yRange) * innerH;

  return (
    <section className="
      mx-4 md:mx-6 mt-3 md:mt-4 rounded-2xl
      bg-[#0d0f0d] border border-[#181c18]
      shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]
      overflow-hidden
    ">
      {/* Header — eyebrow + headline P&L */}
      <header className="px-5 md:px-7 pt-5 md:pt-6 pb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {positive
            ? <TrendingUp className="h-3.5 w-3.5 text-[#3ee68a]" strokeWidth={1.5} />
            : <TrendingDown className="h-3.5 w-3.5 text-[#ef4444]" strokeWidth={1.5} />}
          <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#9ca39a]">
            Bankroll curve · last {series.length - 1} graded
          </span>
        </div>
        <p
          className="text-[20px] md:text-[22px] font-mono font-black tracking-tight leading-none"
          style={{ color: accentColor }}
        >
          {fmtUnits(finalCum)}
        </p>
      </header>

      {/* Chart */}
      <div className="px-2 md:px-3 pb-3 pt-1">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="w-full h-[110px] md:h-[140px]"
        >
          <defs>
            <linearGradient id="curveFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor={accentColor} stopOpacity="0.20" />
              <stop offset="100%" stopColor={accentColor} stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Zero baseline */}
          {zeroIn && (
            <line
              x1={padL} x2={W - padR}
              y1={zeroY} y2={zeroY}
              stroke="#1a1e1a" strokeWidth={1} strokeDasharray="3 4"
            />
          )}

          {/* Area fill */}
          <path d={areaD} fill="url(#curveFill)" />

          {/* The line */}
          <path
            d={pathD}
            fill="none"
            stroke={accentColor}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* End-point dot */}
          <circle
            cx={lastPt.x}
            cy={lastPt.y}
            r={3.2}
            fill={accentColor}
          />
          <circle
            cx={lastPt.x}
            cy={lastPt.y}
            r={5.4}
            fill={accentSoft}
          />
        </svg>
      </div>

      {/* Footer */}
      <div className="px-5 md:px-7 pb-4 flex items-center justify-between gap-3">
        <p className="text-[10px] text-[#6b7068]">
          Cumulative P&L in units. Each step is one graded pick.
        </p>
        <p className="text-[10px] text-[#4a524a] font-mono">
          1u = 1% of bankroll
        </p>
      </div>
    </section>
  );
}

function Skeleton() {
  return (
    <section className="
      mx-4 md:mx-6 mt-3 md:mt-4 rounded-2xl
      bg-[#0d0f0d] border border-[#181c18]
      shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]
    ">
      <div className="px-5 md:px-7 pt-5 pb-2 flex items-center justify-between">
        <div className="h-2.5 w-32 rounded bg-[#1a1e1a] animate-pulse" />
        <div className="h-5 w-16 rounded bg-[#1a1e1a] animate-pulse" />
      </div>
      <div className="px-2 md:px-3 py-3">
        <div className="h-[110px] md:h-[140px] rounded bg-[#1a1e1a] animate-pulse" />
      </div>
    </section>
  );
}
