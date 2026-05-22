"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

// Tournament window — must stay in sync with the worker's WC_ACTIVE_WINDOW
// in ml/nba_spread/worker.py (Jun 4 test start, Jun 11 kickoff, Jul 19 final).
const KICKOFF_ISO   = "2026-06-11T21:00:00-04:00"; // 9 PM ET opener at Estadio Azteca
const FINAL_ISO     = "2026-07-19T23:59:59-04:00";

type WCPhase = "pre" | "live" | "ended";

function getPhase(now: Date): WCPhase {
  const t = now.getTime();
  if (t < new Date(KICKOFF_ISO).getTime()) return "pre";
  if (t < new Date(FINAL_ISO).getTime())   return "live";
  return "ended";
}

function useCountdown(targetIso: string) {
  const [diff, setDiff] = useState<number | null>(null);
  useEffect(() => {
    const target = new Date(targetIso).getTime();
    const tick = () => setDiff(Math.max(0, target - Date.now()));
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, [targetIso]);
  if (diff === null) return null;
  return {
    days:  Math.floor(diff / 86_400_000),
    hours: Math.floor((diff % 86_400_000) / 3_600_000),
    mins:  Math.floor((diff %  3_600_000) / 60_000),
  };
}

/**
 * Inline WC banner at the top of the dashboard games list.
 *
 * - Pre-kickoff:  countdown + "coverage starts June 11" promise.
 * - In-tournament: tournament-active strip with "live" indicator.
 * - Post-final:   renders nothing.
 *
 * Designed to feel like a piece of the board, not a marketing intrusion —
 * narrow vertical footprint, V4 green accent, no CTAs that go nowhere.
 */
export default function WCBanner() {
  const [phase, setPhase] = useState<WCPhase | null>(null);

  useEffect(() => {
    const update = () => setPhase(getPhase(new Date()));
    update();
    const id = setInterval(update, 60_000);
    return () => clearInterval(id);
  }, []);

  const cd = useCountdown(KICKOFF_ISO);

  // SSR / pre-hydration: don't render anything to avoid layout flash
  if (phase === null) return null;
  if (phase === "ended") return null;

  if (phase === "pre") {
    return (
      <div className="border-b border-[#1b201a] bg-[linear-gradient(180deg,#0a1410_0%,#0a0b0a_100%)] px-5 py-4">
        <div className="mx-auto max-w-[1200px] flex items-center gap-4">
          {/* Soccer icon */}
          <div className="shrink-0 h-9 w-9 rounded-lg bg-[#3ee68a]/10 border border-[#3ee68a]/20 flex items-center justify-center">
            <span className="text-[16px]">⚽</span>
          </div>

          {/* Headline */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span className="h-1.5 w-1.5 rounded-full bg-[#3ee68a] animate-pulse" />
              <span className="text-[10px] font-bold text-[#3ee68a] uppercase tracking-[0.18em]">
                World Cup 2026 · {cd ? `${cd.days} days out` : "Jun 11"}
              </span>
            </div>
            <p className="text-[12px] text-[#9ca39a] leading-snug max-w-[640px]">
              ACE is training a soccer intelligence model on the Big Five —
              EPL, La Liga, Bundesliga, Serie A, Ligue 1, UCL.{" "}
              <span className="text-[#d4d7d0]">First model-driven picks ship for the World Cup, June 11.</span>{" "}
              Every signal, every pick, every result tracked publicly from kickoff.
            </p>
          </div>

          {/* Countdown chip */}
          {cd && (
            <div className="shrink-0 hidden sm:flex items-end gap-1 font-mono">
              <CountdownDigit n={cd.days}  label="d" />
              <span className="text-[14px] text-[#3a4033] mb-1 leading-none">:</span>
              <CountdownDigit n={cd.hours} label="h" />
              <span className="text-[14px] text-[#3a4033] mb-1 leading-none">:</span>
              <CountdownDigit n={cd.mins}  label="m" />
            </div>
          )}
        </div>
      </div>
    );
  }

  // phase === "live"
  return (
    <div className="border-b border-[#1b201a] bg-[linear-gradient(180deg,#0c1a13_0%,#0a0b0a_100%)] px-5 py-4">
      <div className="mx-auto max-w-[1200px] flex items-center gap-4">
        <div className="shrink-0 h-9 w-9 rounded-lg bg-[#3ee68a]/15 border border-[#3ee68a]/30 flex items-center justify-center">
          <span className="text-[16px]">⚽</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="h-1.5 w-1.5 rounded-full bg-[#ef4444] animate-pulse" />
            <span className="text-[10px] font-bold text-[#ef4444] uppercase tracking-[0.18em]">
              World Cup 2026 · LIVE
            </span>
          </div>
          <p className="text-[12px] text-[#9ca39a] leading-snug max-w-[640px]">
            Tournament in play. Filter by <span className="text-[#3ee68a]">⚽ Soccer</span> to
            see today&apos;s matches, ACE picks, and results — all updating in real time.
          </p>
        </div>
      </div>
    </div>
  );
}

function CountdownDigit({ n, label }: { n: number; label: string }) {
  return (
    <div className="flex items-end gap-0.5">
      <span className="text-[22px] font-bold text-white leading-none tabular-nums">
        {String(n).padStart(2, "0")}
      </span>
      <span className="text-[9px] text-[#6b7068] mb-1 uppercase tracking-widest">
        {label}
      </span>
    </div>
  );
}

// Re-export the phase helper so other components (e.g. cross-sport ops overview)
// can detect "are we live during WC right now?" without duplicating dates.
export { getPhase };
