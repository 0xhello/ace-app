import Link from "next/link";
import { ArrowLeft, Bell, Filter, LineChart, Lock, Database, TrendingUp, Activity } from "lucide-react";
import { fetchGameIntel } from "@/lib/intel-data";
import { ConfidencePill } from "@/components/ConfidenceBadge";
import { SignalChip } from "@/components/SignalBadge";

export const dynamic = "force-dynamic";

function Sparkline({ values }: { values: { idx: number; pct: number }[] }) {
  const width = 220;
  const height = 52;
  const max = Math.max(...values.map(v => v.pct));
  const min = Math.min(...values.map(v => v.pct));
  const range = Math.max(1, max - min);
  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = height - ((v.pct - min) / range) * height;
    return `${x},${y}`;
  }).join(" ");
  return (
    <svg width={width} height={height} className="overflow-visible">
      <polyline fill="none" stroke="#00ff7f" strokeWidth="2" points={points} />
    </svg>
  );
}

function historyFromConfidence(pct: number, delta?: number | null) {
  return Array.from({ length: 12 }).map((_, i) => ({ idx: i, pct: Math.max(45, Math.min(95, pct - (delta ?? 0) + ((i % 5) - 2))) }));
}

function coverageText(value?: string) {
  if (!value) return "none";
  if (value === "not_applicable") return "n/a";
  return value;
}

function sourceStatusLabel(status: any, fallback: string) {
  if (!status) return fallback;
  if (status.ok && status.coverage) return `${coverageText(status.coverage)} coverage`;
  if (status.ok) return "Ready";
  if (status.coverage) return `${coverageText(status.coverage)} coverage`;
  return fallback;
}

function marketLabel(key: string) {
  if (key === "ml") return "Moneyline";
  if (key === "spread") return "Spread";
  if (key === "total") return "Total";
  return key;
}

function changeSummary(confidence: any, signals: any[]) {
  const delta = confidence?.delta;
  const top = signals?.[0];
  if (delta == null || delta === 0) {
    return top?.summary || "No material change surfaced yet.";
  }
  if (delta > 0) {
    return `Confidence improved ${delta} points — ${top?.summary || "supporting context strengthened"}`;
  }
  return `Confidence fell ${Math.abs(delta)} points — ${top?.summary || "new uncertainty entered the read"}`;
}

function impactSummary(signals: any[]) {
  const benefits = Array.from(new Set(signals.flatMap((s: any) => s.benefits || []))).filter(Boolean);
  const harms = Array.from(new Set(signals.flatMap((s: any) => s.harms || []))).filter(Boolean);
  return { benefits, harms };
}

function relativeTimeLabel(value?: string) {
  if (!value) return "timing unavailable";
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return "timing unavailable";
  const diffMs = Date.now() - then;
  const diffMin = Math.max(0, Math.round(diffMs / 60000));
  if (diffMin <= 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d ago`;
}

function signalTone(signal: any) {
  if (signal?.severity === "high") return "border-[#3f1d1d] bg-[#140c0c]";
  if (signal?.severity === "medium") return "border-[#1e1e24] bg-[#0b0b0d]";
  return "border-[#141417] bg-[#09090b]";
}

export default async function TrackedGamePage({ params }: { params: Promise<{ gameId: string }> }) {
  const { gameId } = await params;
  const intel = await fetchGameIntel(gameId);

  if (!intel?.game) {
    return <div className="p-8 text-[#71717a]">Tracked game not found.</div>;
  }

  const game = intel.game;
  const confidence = intel.confidence;
  const signals = intel.signals || [];
  const history = historyFromConfidence(confidence?.pct ?? 70, confidence?.delta);
  const scoreboard = intel.scoreboard;
  const sourceStatus = intel.source_status || {};
  const coverage = intel.coverage || {};
  const marketConfidence = intel.market_confidence || {};
  const impact = impactSummary(signals);
  const trackedSummary = changeSummary(confidence, signals);
  const topObservedAt = signals?.[0]?.observedAt || signals?.[0]?.derivedAt || intel.updated_at;
  const deltaLabel = confidence?.delta == null ? "Flat" : confidence.delta > 0 ? `+${confidence.delta}` : `${confidence.delta}`;

  return (
    <div className="flex-1 overflow-y-auto bg-[#09090b]">
      <div className="max-w-6xl mx-auto px-6 py-6 space-y-6">
        <Link href="/dashboard/tracked" className="inline-flex items-center gap-2 text-[11px] text-[#71717a] hover:text-white transition-colors">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to tracked
        </Link>

        <div className="rounded-2xl border border-[#141417] bg-[#0c0c0e] p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[11px] text-[#52525b] uppercase tracking-widest mb-1">Tracked game intelligence</p>
              <h1 className="text-[22px] font-bold text-white">{game.away_team} @ {game.home_team}</h1>
              <div className="flex items-center gap-3 mt-2 text-[11px] text-[#71717a] flex-wrap">
                <span>{game.status === "live" ? "LIVE" : "Upcoming"}</span>
                {scoreboard?.away_score != null && scoreboard?.home_score != null && (
                  <>
                    <span>•</span>
                    <span className="text-white font-medium">{scoreboard.away_score} - {scoreboard.home_score}</span>
                  </>
                )}
                {scoreboard?.clock && (
                  <>
                    <span>•</span>
                    <span>{scoreboard.clock}</span>
                  </>
                )}
                <span>•</span>
                <span>{game.sport_title}</span>
              </div>
            </div>
            <button disabled className="px-3 py-2 rounded-lg border border-[#1e1e24] text-[11px] text-[#52525b] cursor-not-allowed inline-flex items-center gap-2">
              <Lock className="h-3.5 w-3.5" /> View Full Markets & Props
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[1.2fr_0.8fr] gap-4">
          <div className="rounded-2xl border border-[#141417] bg-[#0c0c0e] p-5">
            <p className="text-[11px] text-[#52525b] uppercase tracking-widest mb-3">Current tracked read</p>
            <div className="flex items-center gap-3 mb-3 flex-wrap">
              <ConfidencePill confidence={confidence} />
              <span className="text-[11px] px-2 py-1 rounded-md border border-[#1e1e24] text-[#71717a] uppercase tracking-wider">{confidence?.status}</span>
              <span className="text-[11px] px-2 py-1 rounded-md border border-[#1e1e24] text-[#71717a] uppercase tracking-wider">Δ {deltaLabel}</span>
              <span className="text-[11px] px-2 py-1 rounded-md border border-[#1e1e24] text-[#71717a] uppercase tracking-wider">updated {relativeTimeLabel(topObservedAt)}</span>
            </div>
            <p className="text-[18px] font-semibold text-white mb-2">{confidence?.label}</p>
            <p className="text-[12px] text-[#a1a1aa] leading-relaxed">{trackedSummary}</p>
          </div>

          <div className="rounded-2xl border border-[#141417] bg-[#0c0c0e] p-5">
            <p className="text-[11px] text-[#52525b] uppercase tracking-widest mb-3">Source status</p>
            <div className="space-y-2 text-[12px]">
              <div className="flex items-center justify-between"><span className="text-[#71717a]">Odds</span><span className="text-[#00ff7f]">Ready</span></div>
              <div className="flex items-center justify-between"><span className="text-[#71717a]">Scoreboard</span><span className="text-white">{sourceStatus.scoreboard?.matched ? "Matched" : sourceStatus.scoreboard?.ok ? "Reachable" : "Unavailable"}</span></div>
              <div className="flex items-center justify-between"><span className="text-[#71717a]">Injuries</span><span className="text-white">{sourceStatusLabel(sourceStatus.injuries, coverageText(coverage.injury_coverage))}</span></div>
              <div className="flex items-center justify-between"><span className="text-[#71717a]">Weather</span><span className="text-white">{sourceStatusLabel(sourceStatus.weather, coverageText(coverage.weather_coverage))}</span></div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[0.9fr_1.1fr] gap-4">
          <div className="rounded-2xl border border-[#141417] bg-[#0c0c0e] p-5">
            <div className="flex items-center justify-between mb-4">
              <p className="text-[11px] text-[#52525b] uppercase tracking-widest">Confidence history</p>
              <div className="text-[11px] text-[#71717a] inline-flex items-center gap-1.5"><LineChart className="h-3.5 w-3.5 text-[#00ff7f]" /> Internal trend</div>
            </div>
            <Sparkline values={history} />
          </div>

          <div className="rounded-2xl border border-[#141417] bg-[#0c0c0e] p-5">
            <div className="flex items-center justify-between mb-4">
              <p className="text-[11px] text-[#52525b] uppercase tracking-widest">Market confidence</p>
              <div className="text-[11px] text-[#71717a] inline-flex items-center gap-1.5"><Activity className="h-3.5 w-3.5 text-[#00ff7f]" /> Monitoring view</div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {Object.entries(marketConfidence).map(([key, value]: any) => (
                <div key={key} className={`rounded-xl border p-3 ${value?.credible ? 'border-[#1e1e24] bg-[#0b0b0d]' : 'border-[#141417] bg-[#09090b]'}`}>
                  <p className="text-[10px] text-[#52525b] uppercase tracking-widest mb-1">{marketLabel(key)}</p>
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-[15px] font-semibold text-white">{value?.credible ? `${value.pct}%` : '—'}</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-md border border-[#1e1e24] text-[#71717a] uppercase">{value?.tier || 'quiet'}</span>
                  </div>
                  <p className="text-[11px] text-[#e4e4e7] mb-1">{value?.lean || 'No credible lean yet'}</p>
                  <p className="text-[11px] text-[#71717a] leading-relaxed">{value?.reason || 'Waiting for a stronger market-specific edge.'}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-[#141417] bg-[#0c0c0e] p-5">
          <div className="flex items-center justify-between mb-4">
            <p className="text-[11px] text-[#52525b] uppercase tracking-widest">Signals feed</p>
            <div className="flex items-center gap-2">
              <button className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[#1e1e24] text-[11px] text-[#71717a] hover:text-white transition-colors">
                <Filter className="h-3.5 w-3.5" /> Filter signals
              </button>
              <button className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[#1e1e24] text-[11px] text-[#71717a] hover:text-white transition-colors">
                <Bell className="h-3.5 w-3.5" /> Mute low/medium
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-[#141417] bg-[#09090b] p-4 mb-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-[11px] text-[#52525b] uppercase tracking-widest">Impact summary</p>
              <div className="text-[11px] text-[#71717a] inline-flex items-center gap-1.5"><TrendingUp className="h-3.5 w-3.5 text-[#00ff7f]" /> What changed</div>
            </div>
            <div className="space-y-3 text-[12px]">
              <div>
                <p className="text-[#52525b] uppercase tracking-widest text-[10px] mb-1">Who benefits</p>
                <p className="text-white">{impact.benefits.length ? impact.benefits.join(', ') : 'No clear beneficiary surfaced yet.'}</p>
              </div>
              <div>
                <p className="text-[#52525b] uppercase tracking-widest text-[10px] mb-1">Who is impacted</p>
                <p className="text-white">{impact.harms.length ? impact.harms.join(', ') : 'No clear negative impact surfaced yet.'}</p>
              </div>
              <div>
                <p className="text-[#52525b] uppercase tracking-widest text-[10px] mb-1">What changed</p>
                <p className="text-white">{trackedSummary}</p>
                <p className="mt-1 text-[10px] text-[#71717a] uppercase tracking-wider">Latest update {relativeTimeLabel(topObservedAt)}</p>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            {signals.length === 0 ? (
              <div className="rounded-xl border border-[#141417] bg-[#09090b] p-4 text-[12px] text-[#71717a] inline-flex items-center gap-2">
                <Database className="h-4 w-4 text-[#3f3f46]" /> No internal signals yet from real adapters.
              </div>
            ) : signals.map((signal: any) => (
              <details key={signal.id} className={`rounded-xl border p-3 group ${signalTone(signal)}`}>
                <summary className="list-none cursor-pointer">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <SignalChip signal={signal} compact />
                        <span className="text-[10px] px-2 py-0.5 rounded-md border border-[#1e1e24] text-[#71717a] uppercase tracking-wider">{relativeTimeLabel(signal.observedAt || signal.derivedAt)}</span>
                        <span className="text-[10px] text-[#52525b] uppercase tracking-wider">benefits: {signal.benefits?.length ? signal.benefits.join(", ") : "impact unclear"}</span>
                        <span className="text-[10px] text-[#52525b] uppercase tracking-wider">harms: {signal.harms?.length ? signal.harms.join(", ") : "impact unclear"}</span>
                      </div>
                      <p className="text-[12px] text-white font-medium">{signal.summary}</p>
                    </div>
                    <span className="text-[10px] text-[#3f3f46]">expand</span>
                  </div>
                </summary>
                <div className="mt-3 pt-3 border-t border-[#141417] space-y-2">
                  <pre className="text-[11px] text-[#a1a1aa] whitespace-pre-wrap break-words">{typeof signal.details === "string" ? signal.details : JSON.stringify(signal.details, null, 2)}</pre>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[11px]">
                    <div><span className="text-[#52525b]">Certainty:</span> <span className="text-white">{signal.certainty}</span></div>
                    <div><span className="text-[#52525b]">Source:</span> <span className="text-white">{signal.sourceCategory}</span></div>
                    <div><span className="text-[#52525b]">Direction:</span> <span className="text-white">{signal.direction}</span></div>
                    <div><span className="text-[#52525b]">Affected:</span> <span className="text-white">{signal.affectedTeam}</span></div>
                    <div><span className="text-[#52525b]">Observed:</span> <span className="text-white">{signal.observedAt || "—"}</span></div>
                    <div><span className="text-[#52525b]">Derived:</span> <span className="text-white">{signal.derivedAt || "—"}</span></div>
                    <div><span className="text-[#52525b]">Source time:</span> <span className="text-white">{signal.sourceTimestamp || "—"}</span></div>
                  </div>
                </div>
              </details>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
