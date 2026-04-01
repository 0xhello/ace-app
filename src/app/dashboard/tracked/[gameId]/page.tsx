import Link from "next/link";
import { ArrowLeft, Bell, Filter, LineChart, Lock, Database } from "lucide-react";
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

function historyFromConfidence(pct: number) {
  return Array.from({ length: 12 }).map((_, i) => ({ idx: i, pct: Math.max(45, Math.min(95, pct + ((i % 5) - 2))) }));
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
  const history = historyFromConfidence(confidence?.pct ?? 70);
  const scoreboard = intel.scoreboard;
  const sourceStatus = intel.source_status || {};

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
            <p className="text-[11px] text-[#52525b] uppercase tracking-widest mb-3">Current AI read</p>
            <div className="flex items-center gap-3 mb-3 flex-wrap">
              <ConfidencePill confidence={confidence} />
              <span className="text-[11px] px-2 py-1 rounded-md border border-[#1e1e24] text-[#71717a] uppercase tracking-wider">{confidence?.status}</span>
            </div>
            <p className="text-[18px] font-semibold text-white mb-2">{confidence?.label}</p>
            <p className="text-[12px] text-[#a1a1aa] leading-relaxed">{confidence?.explanation}</p>
          </div>

          <div className="rounded-2xl border border-[#141417] bg-[#0c0c0e] p-5">
            <p className="text-[11px] text-[#52525b] uppercase tracking-widest mb-3">Source status</p>
            <div className="space-y-2 text-[12px]">
              <div className="flex items-center justify-between"><span className="text-[#71717a]">Odds</span><span className="text-[#00ff7f]">Ready</span></div>
              <div className="flex items-center justify-between"><span className="text-[#71717a]">Scoreboard</span><span className="text-white">{sourceStatus.scoreboard?.matched ? "Matched" : sourceStatus.scoreboard?.ok ? "Reachable" : "Unavailable"}</span></div>
              <div className="flex items-center justify-between"><span className="text-[#71717a]">Injuries</span><span className="text-[#f59e0b]">Mapping needed</span></div>
              <div className="flex items-center justify-between"><span className="text-[#71717a]">Weather</span><span className="text-[#f59e0b]">Venue coords needed</span></div>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-[#141417] bg-[#0c0c0e] p-5">
          <div className="flex items-center justify-between mb-4">
            <p className="text-[11px] text-[#52525b] uppercase tracking-widest">Confidence history</p>
            <div className="text-[11px] text-[#71717a] inline-flex items-center gap-1.5"><LineChart className="h-3.5 w-3.5 text-[#00ff7f]" /> Internal trend</div>
          </div>
          <Sparkline values={history} />
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

          <div className="space-y-3">
            {signals.length === 0 ? (
              <div className="rounded-xl border border-[#141417] bg-[#09090b] p-4 text-[12px] text-[#71717a] inline-flex items-center gap-2">
                <Database className="h-4 w-4 text-[#3f3f46]" /> No internal signals yet from real adapters.
              </div>
            ) : signals.map((signal: any) => (
              <details key={signal.id} className="rounded-xl border border-[#141417] bg-[#09090b] p-3 group">
                <summary className="list-none cursor-pointer">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <SignalChip signal={signal} compact />
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
