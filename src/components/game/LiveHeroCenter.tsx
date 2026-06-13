"use client";

/**
 * LiveHeroCenter — the center slot of the match hero. Pre-match it shows "VS" +
 * kickoff time. Once the match is live it polls the live feed (~20s) and shows
 * the big live SCORE + clock right where the "VS" was, so the scoreline is the
 * first thing you see. Renders only real data; never simulates.
 */
import { useEffect, useRef, useState } from "react";

interface LiveState {
  live?: boolean; finished?: boolean; status?: string | null; minute?: number | null;
  extra?: number | null; clock?: string | null;
  home_score?: number | null; away_score?: number | null;
}
const POLL_MS = 20_000;

export default function LiveHeroCenter({
  gameId, fixtureId, poll, kickoffLabel,
}: { gameId: string; fixtureId: string | null; poll: boolean; kickoffLabel: string }) {
  const [s, setS] = useState<LiveState | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!poll || !fixtureId) return;
    let alive = true;
    const run = async () => {
      try {
        const r = await fetch(`/api/game/${gameId}/live?fixtureId=${fixtureId}`, { cache: "no-store" });
        const j = (await r.json()) as LiveState;
        if (alive) setS(j);
      } catch { /* keep last */ }
    };
    run();
    timer.current = setInterval(run, POLL_MS);
    return () => { alive = false; if (timer.current) clearInterval(timer.current); };
  }, [gameId, fixtureId, poll]);

  const live = !!s?.live;
  const finished = !!s?.finished;

  if (live || finished) {
    const clock = finished ? "FT" : s?.clock || (s?.minute != null ? `${s.minute}${s.extra ? `+${s.extra}` : ""}'` : (s?.status || "LIVE"));
    return (
      <div className="flex flex-col items-center gap-1.5 px-2">
        <span className="text-[34px] md:text-[38px] font-black font-mono tabular-nums leading-none">
          {s?.away_score ?? 0}<span className="text-[#3a4033] mx-2">–</span>{s?.home_score ?? 0}
        </span>
        <span className={finished
          ? "inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-[#7a8278]"
          : "inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-[#ef6b6b]"}>
          {!finished && <span className="h-1.5 w-1.5 rounded-full bg-[#ef4444] animate-pulse" />}
          {finished ? "Full time" : "Live"}<span className="text-[#c4c7c0] font-mono">{clock}</span>
        </span>
      </div>
    );
  }

  // pre-match
  return (
    <div className="flex flex-col items-center gap-1.5 px-2">
      <span className="text-[15px] font-black tracking-[0.18em] text-[#3a4033]">VS</span>
      <span className="text-[10px] text-[#6b7068] whitespace-nowrap">{kickoffLabel}</span>
    </div>
  );
}
