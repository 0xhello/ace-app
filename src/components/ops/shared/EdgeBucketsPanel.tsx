"use client";

/**
 * EdgeBucketsPanel — does edge magnitude actually predict win rate?
 *
 * Splits graded signals into edge-pp buckets (3-4pp / 4-5pp / 5-7pp / 7pp+)
 * and renders win rate + ROI + sample size per bucket, with Wilson 95% CI
 * bars so a small-sample bucket can't masquerade as a hot streak.
 *
 * Reads /api/ops/edge-buckets. Sport filter + lookback range toggles.
 *
 * The panel's tell: if you see win rate climbing from left to right
 * (low edge → high edge), your tiering is doing real work. If win rate
 * is flat or non-monotone, edge magnitude isn't carrying the signal it
 * was supposed to — time to investigate what is.
 */
import { useEffect, useMemo, useState } from "react";
import { BarChart3 } from "lucide-react";
import { Panel, SectionHead, Tag, EmptyState } from "@/components/ops/shared/primitives";

interface EdgeBucket {
  label: string;
  min_pp: number;
  max_pp: number | null;
  signals: number;
  graded: number;
  wins: number;
  losses: number;
  win_rate: number | null;
  roi: number | null;
  avg_clv: number | null;
  ci_low: number | null;
  ci_high: number | null;
}

interface BucketReport {
  sport: string;
  total_graded: number;
  buckets: EdgeBucket[];
}

interface Response {
  reports: BucketReport[];
  combined: BucketReport;
  meta: {
    bucket_bounds: number[];
    sport_filter: string;
    days: number;
    today: string;
    refreshed_at: string;
  };
  error?: string;
}

type Sport = "all" | "nba" | "mlb" | "soccer";

const SPORTS: { key: Sport; label: string }[] = [
  { key: "all", label: "All" },
  { key: "nba", label: "NBA" },
  { key: "mlb", label: "MLB" },
  { key: "soccer", label: "Soccer" },
];

const RANGES: { days: number; label: string }[] = [
  { days: 30,  label: "30d"  },
  { days: 90,  label: "90d"  },
  { days: 180, label: "180d" },
];

export default function EdgeBucketsPanel() {
  const [sport, setSport] = useState<Sport>("all");
  const [days, setDays]   = useState<number>(180);
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/ops/edge-buckets?sport=${sport}&days=${days}`, { cache: "no-store" });
        const json = await res.json();
        if (alive) setData(json as Response);
      } catch { /* silent */ }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [sport, days]);

  // The view always renders the COMBINED bucket report when sport=all,
  // and the matching per-sport report otherwise — keeps the panel honest
  // about which sample size it's looking at.
  const report: BucketReport | null = useMemo(() => {
    if (!data) return null;
    if (sport === "all") return data.combined;
    return data.reports.find((r) => r.sport === sport) ?? null;
  }, [data, sport]);

  const verdict = useMemo(() => {
    if (!report) return null;
    const buckets = report.buckets.filter((b) => b.win_rate !== null);
    if (buckets.length < 2) return null;
    // Compare first vs last bucket. Use Wilson CIs to require non-overlap
    // before we declare "edge is predictive" — anything else is "needs more data."
    const first = buckets[0];
    const last  = buckets[buckets.length - 1];
    if (last.win_rate === null || first.win_rate === null) return null;
    const delta = last.win_rate - first.win_rate;
    const ciSeparated =
      first.ci_high !== null && last.ci_low !== null && last.ci_low > first.ci_high;
    if (delta > 0.02 && ciSeparated) {
      return { tone: "good" as const,
               text: `Edge magnitude is predictive — high-edge bucket beats low-edge by ${(delta * 100).toFixed(1)}pp with non-overlapping 95% CIs.` };
    }
    if (delta > 0.02) {
      return { tone: "neutral" as const,
               text: `High-edge bucket leads low-edge by ${(delta * 100).toFixed(1)}pp but CIs overlap. Needs more sample.` };
    }
    if (delta < -0.02) {
      return { tone: "bad" as const,
               text: `Low-edge bucket is BEATING high-edge by ${(-delta * 100).toFixed(1)}pp. Tiering is inverted — investigate.` };
    }
    return { tone: "neutral" as const,
             text: "Buckets winning at similar rates — edge magnitude isn't carrying meaningful signal yet." };
  }, [report]);

  return (
    <Panel>
      <SectionHead
        icon={BarChart3}
        title="Edge buckets — is edge magnitude predictive?"
        right={
          <span className="text-[10px] text-[#6b7068] uppercase tracking-[0.12em]">
            tiering validator
          </span>
        }
      />

      {/* Toggles */}
      <div className="flex items-center gap-3 mb-4 flex-wrap text-[10px]">
        <TogglePill label="Sport" value={sport} options={SPORTS} onChange={setSport} />
        <TogglePill label="Range" value={days}  options={RANGES.map((r) => ({ key: r.days, label: r.label }))} onChange={setDays} />
        {data && (
          <span className="text-[#4a524a] uppercase tracking-[0.12em] ml-auto">
            {report?.total_graded ?? 0} graded total
          </span>
        )}
      </div>

      {loading && (
        <div className="h-[200px] flex items-center justify-center text-[11px] text-[#6b7068]">Loading…</div>
      )}

      {!loading && (!report || report.buckets.every((b) => b.graded === 0)) && (
        <EmptyState>
          Not enough graded picks in this window to bucket. Once games settle, buckets fill in below.
        </EmptyState>
      )}

      {!loading && report && report.buckets.some((b) => b.graded > 0) && (
        <>
          <BarChart buckets={report.buckets} />
          <BucketTable buckets={report.buckets} />
          {verdict && (
            <div
              className="mt-3 rounded-lg border px-3 py-2 text-[11px]"
              style={{
                borderColor: verdict.tone === "good" ? "#3ee68a35"
                  : verdict.tone === "bad" ? "#ef444435" : "#1e2220",
                background:  verdict.tone === "good" ? "#3ee68a08"
                  : verdict.tone === "bad" ? "#ef444408" : "transparent",
                color: verdict.tone === "good" ? "#3ee68a"
                  : verdict.tone === "bad" ? "#ef4444" : "#9ca39a",
              }}
            >
              <span className="font-bold uppercase tracking-[0.12em] mr-2">
                {verdict.tone === "good" ? "Predictive" : verdict.tone === "bad" ? "Inverted" : "Inconclusive"}
              </span>
              {verdict.text}
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

// ─── Visual: bar chart with CI whiskers ──────────────────────────────────────

function BarChart({ buckets }: { buckets: EdgeBucket[] }) {
  // Width includes label + bar + win-rate text; height scales by bucket
  // count so we can compare ~4 buckets side-by-side.
  const yMax = Math.min(1, Math.max(
    0.7,
    ...buckets.map((b) => b.ci_high ?? b.win_rate ?? 0),
  ));
  const yMin = 0;

  return (
    <div className="space-y-2">
      {buckets.map((b) => {
        const wr = b.win_rate;
        const widthPct = wr !== null ? (wr - yMin) / (yMax - yMin) * 100 : 0;
        const ciLowPct  = b.ci_low  !== null ? (b.ci_low  - yMin) / (yMax - yMin) * 100 : null;
        const ciHighPct = b.ci_high !== null ? (b.ci_high - yMin) / (yMax - yMin) * 100 : null;
        // Break-even reference line at 52.4%
        const breakEvenPct = (0.524 - yMin) / (yMax - yMin) * 100;
        const color = wr === null ? "#3a4033"
          : wr >= 0.55 ? "#3ee68a"
          : wr >= 0.524 ? "#a8e0a8"
          : wr >= 0.48 ? "#f5c062"
          : "#ef4444";
        const smallSample = b.graded < 30;
        return (
          <div key={b.label} className="flex items-center gap-3">
            <div className="w-16 text-[10px] font-mono text-[#9ca39a] text-right">
              {b.label}
            </div>
            <div className="flex-1 relative h-7 rounded bg-[#0a0b0a] border border-[#1a1e1a] overflow-hidden">
              {/* Break-even reference */}
              <div
                className="absolute top-0 bottom-0 w-px"
                style={{ left: `${breakEvenPct}%`, background: "#f5c06250" }}
                title="52.4% break-even"
              />
              {/* CI band (light shade) */}
              {ciLowPct !== null && ciHighPct !== null && (
                <div
                  className="absolute top-2 bottom-2 rounded-sm"
                  style={{
                    left:  `${Math.max(0, ciLowPct)}%`,
                    width: `${Math.max(0, ciHighPct - Math.max(0, ciLowPct))}%`,
                    background: `${color}25`,
                  }}
                />
              )}
              {/* Bar — the win rate itself */}
              <div
                className="absolute top-1 bottom-1 rounded-sm flex items-center justify-end pr-2"
                style={{
                  left: 0,
                  width: `${widthPct}%`,
                  background: smallSample ? `${color}80` : color,
                  opacity: smallSample ? 0.7 : 1,
                  backgroundImage: smallSample
                    ? "repeating-linear-gradient(45deg, transparent 0 4px, rgba(0,0,0,0.15) 4px 8px)"
                    : undefined,
                }}
              >
                {wr !== null && (
                  <span className="text-[10px] font-mono font-bold text-[#0a0b0a]">
                    {(wr * 100).toFixed(1)}%
                  </span>
                )}
              </div>
            </div>
            <div className="w-24 text-[10px] font-mono text-[#6b7068] text-right">
              {b.wins}W / {b.losses}L
              {smallSample && b.graded > 0 && (
                <span title="Sample <30: striped bar indicates low confidence">
                  {" "}<span className="text-[#f5c062]">⚠</span>
                </span>
              )}
            </div>
          </div>
        );
      })}
      <div className="flex items-center justify-between text-[9px] text-[#4a524a] uppercase tracking-[0.12em] pl-[76px] mt-1">
        <span>Win rate · light band = 95% CI · ⚠ = n&lt;30</span>
        <span>break-even 52.4% (amber line)</span>
      </div>
    </div>
  );
}

// ─── Detail table — full per-bucket numbers ──────────────────────────────────

function BucketTable({ buckets }: { buckets: EdgeBucket[] }) {
  return (
    <div className="overflow-x-auto mt-4 rounded border border-[#1a1e1a]">
      <table className="w-full text-left text-[10px] font-mono">
        <thead className="text-[#6b7068] uppercase tracking-[0.12em] border-b border-[#1e2220] bg-[#0a0b0a]">
          <tr>
            <th className="py-2 px-2 font-semibold">Bucket</th>
            <th className="py-2 px-2 font-semibold text-right">Signals</th>
            <th className="py-2 px-2 font-semibold text-right">Graded</th>
            <th className="py-2 px-2 font-semibold text-right">Record</th>
            <th className="py-2 px-2 font-semibold text-right">Win %</th>
            <th className="py-2 px-2 font-semibold text-right">95% CI</th>
            <th className="py-2 px-2 font-semibold text-right">ROI</th>
            <th className="py-2 px-2 font-semibold text-right">Avg CLV</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#141714]">
          {buckets.map((b) => (
            <tr key={b.label} className="text-[#c4c7c0]">
              <td className="py-1.5 px-2 text-white">{b.label}</td>
              <td className="py-1.5 px-2 text-right text-[#9ca39a]">{b.signals}</td>
              <td className="py-1.5 px-2 text-right text-[#9ca39a]">{b.graded}</td>
              <td className="py-1.5 px-2 text-right text-[#9ca39a]">{b.wins}-{b.losses}</td>
              <td className="py-1.5 px-2 text-right font-bold"
                  style={{
                    color: b.win_rate === null ? "#3a4033"
                      : b.win_rate >= 0.524 ? "#3ee68a"
                      : b.win_rate >= 0.48 ? "#f5c062" : "#ef4444",
                  }}>
                {b.win_rate !== null ? `${(b.win_rate * 100).toFixed(1)}%` : "—"}
              </td>
              <td className="py-1.5 px-2 text-right text-[#6b7068]">
                {b.ci_low !== null && b.ci_high !== null
                  ? `${(b.ci_low * 100).toFixed(0)}-${(b.ci_high * 100).toFixed(0)}%`
                  : "—"}
              </td>
              <td className="py-1.5 px-2 text-right"
                  style={{
                    color: b.roi === null ? "#3a4033"
                      : b.roi >= 0 ? "#3ee68a" : "#ef4444",
                  }}>
                {b.roi !== null ? `${b.roi > 0 ? "+" : ""}${(b.roi * 100).toFixed(1)}%` : "—"}
              </td>
              <td className="py-1.5 px-2 text-right text-[#9ca39a]">
                {b.avg_clv !== null
                  ? `${b.avg_clv > 0 ? "+" : ""}${(b.avg_clv * 100).toFixed(1)}pp`
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Shared toggle pill — same shape as PerformanceOverTimePanel ─────────────

function TogglePill<T extends string | number>({
  label, value, options, onChange,
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
              value === o.key ? "bg-[#3ee68a]/15 text-[#3ee68a]" : "text-[#6b7068] hover:text-white"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
