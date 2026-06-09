"use client";

/**
 * LiveCenter — real-time match module for the game page. Polls
 * /api/game/[gameId]/live?fixtureId=… every ~20s and shows the live score,
 * match clock and key events as they happen. REST polling (no WebSocket); a
 * 20s cadence looks real-time for soccer. Shows an honest pre-match placeholder
 * until the match is actually live, and a final state once it ends. Never
 * fabricates — it renders only what the API returns.
 */
import { useEffect, useRef, useState } from "react";
import { Radio, ArrowLeftRight, AlertTriangle } from "lucide-react";

interface LiveEvent {
  minute: number | null;
  extra: number | null;
  type: "goal" | "own-goal" | "redcard" | "yellowcard" | "substitution" | "var";
  team: "home" | "away";
  player: string | null;
  related: string | null;
}
interface LiveState {
  live?: boolean;
  finished?: boolean;
  status?: string | null;
  minute?: number | null;
  home_team?: string | null;
  away_team?: string | null;
  home_score?: number | null;
  away_score?: number | null;
  events?: LiveEvent[];
}

const POLL_MS = 20_000;

function clock(s: LiveState): string {
  if (s.finished) return "FT";
  if (s.minute != null) return `${s.minute}'`;
  return s.status || "LIVE";
}

function EventRow({ ev, home, away }: { ev: LiveEvent; home: string; away: string }) {
  const team = ev.team === "home" ? home : away;
  const isGoal = ev.type === "goal" || ev.type === "own-goal";
  const min = ev.minute != null ? `${ev.minute}${ev.extra ? `+${ev.extra}` : ""}'` : "";
  const icon = isGoal
    ? <span className={`h-2 w-2 rounded-full ${ev.type === "own-goal" ? "bg-[#ef6b6b]" : "bg-[#3ee68a]"}`} />
    : ev.type === "substitution"
      ? <ArrowLeftRight className="h-3 w-3 text-[#7a8278]" strokeWidth={2} />
      : ev.type === "redcard"
        ? <span className="h-3 w-2 rounded-[1px] bg-[#ef4444]" />
        : ev.type === "yellowcard"
          ? <span className="h-3 w-2 rounded-[1px] bg-[#e3c34a]" />
          : <AlertTriangle className="h-3 w-3 text-[#7a8278]" strokeWidth={2} />;
  return (
    <div className="flex items-center gap-3 py-2 animate-[fadeIn_0.4s_ease]">
      <span className="text-[11px] font-mono text-[#6b7068] w-[34px] shrink-0 tabular-nums">{min}</span>
      <span className="flex h-4 w-4 items-center justify-center shrink-0">{icon}</span>
      <span className={`text-[12.5px] truncate ${isGoal ? "text-white font-semibold" : "text-[#c4c7c0]"}`}>
        {ev.player || (isGoal ? "Goal" : ev.type)}
        {ev.related && ev.type === "substitution" && <span className="text-[#6b7068]"> ↔ {ev.related}</span>}
      </span>
      <span className="ml-auto text-[10px] text-[#565c52] shrink-0 truncate max-w-[90px]">{team}</span>
    </div>
  );
}

export default function LiveCenter({
  gameId, fixtureId, homeTeam, awayTeam,
}: { gameId: string; fixtureId: string | null; homeTeam: string; awayTeam: string }) {
  const [state, setState] = useState<LiveState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!fixtureId) { setLoaded(true); return; }
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch(`/api/game/${gameId}/live?fixtureId=${fixtureId}`, { cache: "no-store" });
        const j = (await r.json()) as LiveState;
        if (alive) { setState(j); setLoaded(true); }
      } catch { if (alive) setLoaded(true); }
    };
    poll();
    timer.current = setInterval(poll, POLL_MS);
    return () => { alive = false; if (timer.current) clearInterval(timer.current); };
  }, [gameId, fixtureId]);

  const live = !!state?.live;
  const finished = !!state?.finished;
  const home = state?.home_team || homeTeam;
  const away = state?.away_team || awayTeam;

  // Pre-match (or not yet loaded / not live): intentional placeholder.
  if (!live && !finished) {
    return (
      <div className="relative overflow-hidden rounded-2xl border border-[#1a1f18] bg-[#0a0c0a] px-5 py-4">
        <div className="pointer-events-none absolute inset-0 opacity-[0.05] bg-[repeating-linear-gradient(0deg,transparent,transparent_3px,#3ee68a_3px,#3ee68a_4px)]" />
        <div className="relative flex items-center gap-3">
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="absolute inline-flex h-full w-full rounded-full bg-[#3ee68a]/40 animate-ping" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-[#3ee68a]/70" />
          </span>
          <div>
            <p className="text-[12.5px] text-[#c4c7c0] font-medium">Opens at kickoff</p>
            <p className="text-[11px] text-[#6b7068] mt-0.5">Live score, clock and key moments stream here in real time. Projected lineups land ~1 hour before kickoff.</p>
          </div>
        </div>
      </div>
    );
  }

  const events = state?.events ?? [];
  return (
    <div className="relative overflow-hidden rounded-2xl border border-[#26321f] bg-[#0a0c0a]">
      <div className="pointer-events-none absolute inset-0 opacity-[0.05] bg-[repeating-linear-gradient(0deg,transparent,transparent_3px,#3ee68a_3px,#3ee68a_4px)]" />
      {/* live scoreboard */}
      <div className="relative flex items-center justify-between px-5 pt-4 pb-3 border-b border-[#161a16]">
        <span className={finished
          ? "inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-[#7a8278]"
          : "inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-[#ef6b6b]"}>
          {!finished && <span className="h-1.5 w-1.5 rounded-full bg-[#ef4444] animate-pulse" />}
          {finished ? "Full time" : "Live"}
        </span>
        <span className="text-[11px] font-mono text-[#c4c7c0] tabular-nums">{clock(state!)}</span>
      </div>
      <div className="relative grid grid-cols-[1fr_auto_1fr] items-center gap-3 px-5 py-4">
        <span className="text-[13px] font-semibold text-[#e7eae4] text-right truncate">{away}</span>
        <span className="text-[26px] font-black font-mono tabular-nums leading-none px-2">
          {state?.away_score ?? 0}<span className="text-[#3a4033] mx-1.5">–</span>{state?.home_score ?? 0}
        </span>
        <span className="text-[13px] font-semibold text-[#e7eae4] truncate">{home}</span>
      </div>
      {/* events feed */}
      {events.length > 0 ? (
        <div className="relative px-5 pb-3 border-t border-[#161a16] divide-y divide-[#121512] max-h-[260px] overflow-y-auto">
          {events.map((ev, i) => <EventRow key={`${ev.minute}-${ev.type}-${i}`} ev={ev} home={home} away={away} />)}
        </div>
      ) : (
        <p className="relative px-5 py-3 border-t border-[#161a16] text-[11.5px] text-[#6b7068]">
          {loaded ? "No key events yet — goals, cards and subs will appear here." : "Loading live feed…"}
        </p>
      )}
      <div className="relative flex items-center gap-1.5 px-5 py-2 border-t border-[#121512]">
        <Radio className="h-3 w-3 text-[#3ee68a]" strokeWidth={1.8} />
        <span className="text-[9.5px] text-[#4a524a] uppercase tracking-wide">Updates every 20s · Sportmonks live feed</span>
      </div>
    </div>
  );
}
