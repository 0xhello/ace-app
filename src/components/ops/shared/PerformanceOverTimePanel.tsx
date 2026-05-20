"use client";

/**
 * PerformanceOverTimePanel — the headline "are we getting better?" panel.
 *
 * Fetches /api/ops/performance-timeseries and renders a daily line chart
 * of one of three metrics (Win Rate / ROI / CLV) for one of four scopes
 * (All sports / NBA / MLB / Soccer). The current period summary plus a
 * delta-vs-prior-period chip lets you see at a glance whether the edge
 * is holding, drifting, or breaking.
 *
 * Hand-rolled SVG instead of a chart library — adds zero deps, gives full
 * control over the look so it sits inside the existing visual vocabulary.
 */
import { useEffect, useMemo, useState } from "react";
import { LineChart, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { Panel, SectionHead, Tag } from "@/components/ops/shared/primitives";

type Metric = "win_rate" | "roi" | "avg_clv";
type Sport  = "all" | "nba" | "mlb" | "soccer";

interface DayPoint {
  date: string;
  signals: number;
  graded: number;
  wins: number;
  losses: number;
  win_rate: number | null;
  roi: number | null;
  avg_clv: number | null;
  positive_clv_pct: number | null;
}

interface SportSeries {
  sport: "nba" | "mlb" | "soccer";
  points: DayPoint[];
  total_signals: number;
  total_graded: number;
  total_wins: number;
  total_losses: number;
  total_win_rate: number | null;
  total_roi: number | null;
  total_avg_clv: number | null;
}

interface Response {
  series: SportSeries[];
  meta: {
    days: number;
    sport_filter: string;
    today: string;
    refreshed_at: string;
  };
  error?: string;
}

const METRICS: {
  key: Metric;
  label: string;
  format: (n: number) => string;
  breakEven?: number;
  yMin?: number;   // hard clamp on Y axis (e.g. win_rate ∈ [0,1])
  yMax?: number;
}[] = [
  { key: "win_rate", label: "Win Rate", format: (n) => `${(n * 100).toFixed(1)}%`,            breakEven: 0.524, yMin: 0, yMax: 1 },
  { key: "roi",      label: "ROI",      format: (n) => `${n > 0 ? "+" : ""}${(n * 100).toFixed(1)}%`,  breakEven: 0 },
  { key: "avg_clv",  label: "CLV",      format: (n) => `${n > 0 ? "+" : ""}${(n * 100).toFixed(1)}pp`, breakEven: 0 },
];

const SPORTS: { key: Sport; label: string }[] = [
  { key: "all",    label: "All" },
  { key: "nba",    label: "NBA" },
  { key: "mlb",    label: "MLB" },
  { key: "soccer", label: "Soccer" },
];

const RANGES: { days: number; label: string }[] = [
  { days: 7,  label: "7d"  },
  { days: 30, label: "30d" },
  { days: 60, label: "60d" },
];

export default function PerformanceOverTimePanel() {
  const [days, setDays] = useState<number>(60);
  const [sport, setSport] = useState<Sport>("all");
  const [metric, setMetric] = useState<Metric>("win_rate");
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/ops/performance-timeseries?days=${days}&sport=${sport}`,
          { cache: "no-store" },
        );
        const json = await res.json();
        if (alive) setData(json as Response);
      } catch {
        // silent — empty state below
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [days, sport]);

  // Compose the chart's data: when sport=all and metric is win_rate/roi,
  // re-aggregate across sports each day so the line is the combined
  // performance. For per-sport view, single series is used directly.
  const composed = useMemo(() => {
    if (!data || data.series.length === 0) return null;
    if (sport !== "all") {
      const s = data.series[0];
      return {
        points: s.points.map((p) => ({ date: p.date, value: p[metric] })),
        total: pickTotal(s, metric),
        graded: s.total_graded,
        sportLabel: s.sport.toUpperCase(),
      };
    }
    // Combine all sports day-by-day. Average is weighted by graded count.
    const dayMap = new Map<string, { num: number; den: number }>();
    for (const s of data.series) {
      for (const p of s.points) {
        const v = p[metric];
        if (v === null) continue;
        const w = p.graded > 0 ? p.graded : 0;
        if (w === 0) continue;
        const existing = dayMap.get(p.date) ?? { num: 0, den: 0 };
        existing.num += v * w;
        existing.den += w;
        dayMap.set(p.date, existing);
      }
    }
    // Day list driven by the first series (they all share the same axis)
    const dates = data.series[0]?.points.map((p) => p.date) ?? [];
    const points = dates.map((d) => {
      const x = dayMap.get(d);
      return { date: d, value: x && x.den > 0 ? x.num / x.den : null };
    });
    let totNum = 0, totDen = 0;
    for (const s of data.series) {
      const t = pickTotal(s, metric);
      const w = s.total_graded;
      if (t !== null && w > 0) {
        totNum += t * w;
        totDen += w;
      }
    }
    const total = totDen > 0 ? totNum / totDen : null;
    return {
      points,
      total,
      graded: data.series.reduce((a, s) => a + s.total_graded, 0),
      sportLabel: "ALL SPORTS",
    };
  }, [data, sport, metric]);

  // Compare to prior period of the same length so the chip "+1.4pp vs prior"
  // is meaningful — caveats: needs enough graded picks in both periods.
  const delta = useMemo(() => {
    if (!composed) return null;
    const half = Math.floor(composed.points.length / 2);
    if (half < 2) return null;
    const earlier = avgValue(composed.points.slice(0, half));
    const later   = avgValue(composed.points.slice(half));
    if (earlier === null || later === null) return null;
    return later - earlier;
  }, [composed]);

  const metricCfg = METRICS.find((m) => m.key === metric)!;

  return (
    <Panel>
      <SectionHead
        icon={LineChart}
        title="Performance over time"
        right={
          <span className="text-[10px] text-[#6b7068] uppercase tracking-[0.12em]">
            the &quot;are we getting better?&quot; microscope
          </span>
        }
      />

      {/* Toggle bars: sport × metric × range */}
      <div className="flex items-center gap-3 mb-4 flex-wrap text-[10px]">
        <TogglePill label="Sport"  value={sport}  options={SPORTS} onChange={setSport} />
        <TogglePill label="Metric" value={metric} options={METRICS.map((m) => ({ key: m.key, label: m.label }))} onChange={setMetric} />
        <TogglePill label="Range"  value={days}   options={RANGES.map((r) => ({ key: r.days, label: r.label }))} onChange={setDays} />
      </div>

      {/* Summary KPIs above the chart */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <SummaryCard
          label={`${metricCfg.label} (last ${days}d)`}
          value={composed?.total !== null && composed?.total !== undefined ? metricCfg.format(composed.total) : "—"}
          tone={tone(composed?.total ?? null, metricCfg.breakEven)}
        />
        <SummaryCard
          label="vs prior period"
          value={delta !== null
            ? `${delta > 0 ? "+" : ""}${(delta * 100).toFixed(1)}${metric === "avg_clv" ? "pp" : "%"}`
            : "—"}
          tone={delta === null ? "neutral" : delta > 0.005 ? "good" : delta < -0.005 ? "bad" : "neutral"}
          icon={delta === null ? Minus : delta > 0 ? TrendingUp : delta < 0 ? TrendingDown : Minus}
        />
        <SummaryCard
          label="Graded sample"
          value={String(composed?.graded ?? 0)}
          sub={composed && composed.graded < 30 ? "needs ≥30 for confidence" : ""}
          tone={composed && composed.graded < 30 ? "weak" : "neutral"}
        />
      </div>

      {/* The actual chart */}
      {loading && (
        <div className="h-[180px] flex items-center justify-center text-[11px] text-[#6b7068]">
          Loading…
        </div>
      )}
      {!loading && (!composed || composed.points.every((p) => p.value === null)) && (
        <div className="h-[180px] flex items-center justify-center text-[11px] text-[#6b7068] text-center px-6">
          No graded data in this window. Once games settle and grades land, daily {metricCfg.label.toLowerCase()} will appear here.
        </div>
      )}
      {!loading && composed && composed.points.some((p) => p.value !== null) && (
        <LineChartSVG
          points={composed.points}
          breakEven={metricCfg.breakEven ?? null}
          formatValue={(v) => metricCfg.format(v)}
          accent="#3ee68a"
          yClampMin={metricCfg.yMin}
          yClampMax={metricCfg.yMax}
        />
      )}

      {/* Per-sport stripe shown when viewing 'All' — at-a-glance per-sport tally */}
      {sport === "all" && data && data.series.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2 text-[10px]">
          {data.series.map((s) => {
            const v = pickTotal(s, metric);
            const formatted = v !== null ? metricCfg.format(v) : "—";
            return (
              <div key={s.sport}
                   className="rounded border border-[#1a1e1a] bg-[#0a0b0a] px-2.5 py-1.5 flex items-center gap-2">
                <Tag label={s.sport.toUpperCase()} color={SPORT_COLORS[s.sport]} />
                <span className="font-mono font-bold" style={{ color: tone(v, metricCfg.breakEven) === "good" ? "#3ee68a" : tone(v, metricCfg.breakEven) === "bad" ? "#ef4444" : "#c4c7c0" }}>
                  {formatted}
                </span>
                <span className="text-[#4a524a]">· {s.total_graded} graded</span>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SPORT_COLORS: Record<string, string> = {
  nba:    "#f5c062",
  mlb:    "#7ab8ff",
  soccer: "#3ee68a",
};

function pickTotal(s: SportSeries, m: Metric): number | null {
  if (m === "win_rate") return s.total_win_rate;
  if (m === "roi")      return s.total_roi;
  return s.total_avg_clv;
}

function avgValue(points: { value: number | null }[]): number | null {
  const xs = points.map((p) => p.value).filter((v): v is number => v !== null);
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function tone(v: number | null | undefined, breakEven?: number): "good" | "bad" | "neutral" | "weak" {
  if (v === null || v === undefined) return "neutral";
  if (breakEven === undefined) return "neutral";
  if (v > breakEven + 0.005) return "good";
  if (v < breakEven - 0.005) return "bad";
  return "neutral";
}

// ─── TogglePill ──────────────────────────────────────────────────────────────

function TogglePill<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { key: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[#6b7068] uppercase tracking-[0.12em]">{label}</span>
      <div className="flex border border-[#1e2220] rounded-lg overflow-hidden">
        {options.map((o) => (
          <button
            key={String(o.key)}
            onClick={() => onChange(o.key)}
            className={`px-2.5 py-1 uppercase tracking-[0.12em] transition-colors ${
              value === o.key
                ? "bg-[#3ee68a]/15 text-[#3ee68a]"
                : "text-[#6b7068] hover:text-white"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── SummaryCard ──────────────────────────────────────────────────────────────

function SummaryCard({
  label,
  value,
  sub,
  tone,
  icon: Icon,
}: {
  label: string;
  value: string;
  sub?: string;
  tone: "good" | "bad" | "neutral" | "weak";
  icon?: typeof TrendingUp;
}) {
  const color = tone === "good" ? "#3ee68a"
    : tone === "bad" ? "#ef4444"
    : tone === "weak" ? "#f5c062"
    : "#c4c7c0";
  return (
    <div className="rounded-lg border border-[#1a1e1a] bg-[#0a0b0a] px-3 py-2.5">
      <p className="text-[9px] text-[#6b7068] uppercase tracking-[0.15em] mb-1.5">{label}</p>
      <p className="text-[20px] font-bold font-mono tabular-nums flex items-center gap-1.5" style={{ color }}>
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {value}
      </p>
      {sub && <p className="text-[9px] text-[#6b7068] mt-0.5">{sub}</p>}
    </div>
  );
}

// ─── LineChartSVG — hand-rolled, dependency-free ─────────────────────────────

function LineChartSVG({
  points,
  breakEven,
  formatValue,
  accent = "#3ee68a",
  yClampMin,
  yClampMax,
}: {
  points: { date: string; value: number | null }[];
  breakEven: number | null;
  formatValue: (v: number) => string;
  accent?: string;
  yClampMin?: number;   // e.g. 0 for win_rate so we never draw negative %
  yClampMax?: number;   // e.g. 1 for win_rate so the axis caps at 100%
}) {
  const w = 760;
  const h = 180;
  const pad = { top: 14, right: 20, bottom: 24, left: 36 };
  const innerW = w - pad.left - pad.right;
  const innerH = h - pad.top - pad.bottom;

  const values = points.map((p) => p.value).filter((v): v is number => v !== null);
  if (values.length === 0) return null;

  // Y range: tight around data but include break-even if relevant
  let yMin = Math.min(...values);
  let yMax = Math.max(...values);
  if (breakEven !== null) {
    yMin = Math.min(yMin, breakEven);
    yMax = Math.max(yMax, breakEven);
  }
  // Add small padding so points don't touch the edges, then clamp to the
  // logical bounds (e.g. win_rate ∈ [0, 1]) so we never label "108%".
  const range = yMax - yMin;
  const slack = range === 0 ? Math.abs(yMax) * 0.2 + 0.01 : range * 0.15;
  yMin -= slack;
  yMax += slack;
  if (yClampMin !== undefined) yMin = Math.max(yMin, yClampMin);
  if (yClampMax !== undefined) yMax = Math.min(yMax, yClampMax);
  // After clamping, if data exceeds the clamp range the axis collapses.
  // Guarantee minimum visible range so the line never sits on a single
  // pixel row.
  if (yMax - yMin < 0.01) {
    const center = (yMin + yMax) / 2;
    yMin = center - 0.05;
    yMax = center + 0.05;
    if (yClampMin !== undefined) yMin = Math.max(yMin, yClampMin);
    if (yClampMax !== undefined) yMax = Math.min(yMax, yClampMax);
  }

  const xFor = (i: number) =>
    pad.left + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const yFor = (v: number) =>
    pad.top + innerH - ((v - yMin) / (yMax - yMin)) * innerH;

  // Build the path — break the line on null values so gaps show.
  const pathD: string[] = [];
  let pen = false;
  points.forEach((p, i) => {
    if (p.value === null) { pen = false; return; }
    pathD.push(`${pen ? "L" : "M"} ${xFor(i).toFixed(1)} ${yFor(p.value).toFixed(1)}`);
    pen = true;
  });

  // Y-axis ticks — 3 of them keeps it uncluttered
  const yTicks = [yMin, (yMin + yMax) / 2, yMax];
  // X-axis ticks — show 5 day labels, evenly spread
  const xTicks: { i: number; label: string }[] = [];
  const nLabels = Math.min(5, points.length);
  for (let k = 0; k < nLabels; k++) {
    const i = Math.round((k / (nLabels - 1)) * (points.length - 1));
    const d = points[i].date;
    xTicks.push({ i, label: d.slice(5) });
  }

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-[180px]" preserveAspectRatio="none">
      {/* Background grid */}
      {yTicks.map((tv, idx) => (
        <line
          key={idx}
          x1={pad.left} x2={w - pad.right}
          y1={yFor(tv)} y2={yFor(tv)}
          stroke="#1a1e1a" strokeWidth="1" strokeDasharray="2 3"
        />
      ))}

      {/* Break-even line (e.g. 52.4% for win_rate, 0 for ROI/CLV) */}
      {breakEven !== null && breakEven > yMin && breakEven < yMax && (
        <>
          <line
            x1={pad.left} x2={w - pad.right}
            y1={yFor(breakEven)} y2={yFor(breakEven)}
            stroke="#f5c062" strokeWidth="1" strokeDasharray="4 3" opacity="0.45"
          />
          <text
            x={w - pad.right} y={yFor(breakEven) - 3}
            fill="#f5c062" fontSize="9" fontFamily="monospace" textAnchor="end"
            opacity="0.7"
          >
            break-even {formatValue(breakEven)}
          </text>
        </>
      )}

      {/* Y-axis labels */}
      {yTicks.map((tv, idx) => (
        <text
          key={idx}
          x={pad.left - 6} y={yFor(tv) + 3}
          fill="#4a524a" fontSize="9" fontFamily="monospace" textAnchor="end"
        >
          {formatValue(tv)}
        </text>
      ))}

      {/* Line */}
      <path d={pathD.join(" ")} fill="none" stroke={accent} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />

      {/* Points (small dots on every data point) */}
      {points.map((p, i) =>
        p.value === null ? null : (
          <circle key={i} cx={xFor(i)} cy={yFor(p.value)} r="1.8" fill={accent} />
        ),
      )}

      {/* X-axis labels */}
      {xTicks.map((t, idx) => (
        <text
          key={idx}
          x={xFor(t.i)} y={h - 6}
          fill="#4a524a" fontSize="9" fontFamily="monospace" textAnchor="middle"
        >
          {t.label}
        </text>
      ))}
    </svg>
  );
}
