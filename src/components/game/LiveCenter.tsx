"use client";

/**
 * LiveCenter — the live match-events timeline. The big scoreline + clock live in
 * the hero (LiveHeroCenter); this module is the labeled feed of what's happened:
 * goals, cards, subs, VAR — each with a clear text label, newest first. Polls
 * the live feed (~20s). Honest pre-match placeholder until the match is live.
 * Real data only — never fabricates.
 */
import { useEffect, useRef, useState } from "react";
import { ArrowLeftRight } from "lucide-react";
import { liveWinProb } from "@/lib/live-win-prob";
import LiveSignalPanel from "@/components/game/LiveSignalPanel";

interface LiveEvent {
  minute: number | null;
  extra: number | null;
  type: "goal" | "own-goal" | "redcard" | "yellowcard" | "substitution" | "var";
  team: "home" | "away";
  player: string | null;
  related: string | null;
}
interface StatPair { home?: number | string | null; away?: number | string | null }
interface LiveStats {
  shots_on_target?: StatPair;
  shots_total?: StatPair;
  possession?: StatPair;
  corners?: StatPair;
  dangerous_attacks?: StatPair;
}
interface LiveState {
  live?: boolean; finished?: boolean; status?: string | null; minute?: number | null;
  home_team?: string | null; away_team?: string | null;
  home_score?: number | null; away_score?: number | null; events?: LiveEvent[];
  statistics?: LiveStats;
}
const POLL_MS = 20_000;

const META: Record<LiveEvent["type"], { label: string; chip: string }> = {
  "goal":         { label: "Goal",     chip: "bg-[#16331f] text-[#5fe39a] ring-[#215a2e]" },
  "own-goal":     { label: "Own goal", chip: "bg-[#331515] text-[#ef9a9a] ring-[#4a2020]" },
  "yellowcard":   { label: "Yellow",   chip: "bg-[#2a2710] text-[#e3c34a] ring-[#3a3518]" },
  "redcard":      { label: "Red",      chip: "bg-[#331515] text-[#ef8e8e] ring-[#4a2020]" },
  "substitution": { label: "Sub",      chip: "bg-[#16181c] text-[#9aa3b0] ring-[#262c34]" },
  "var":          { label: "VAR",      chip: "bg-[#16181c] text-[#9aa3b0] ring-[#262c34]" },
};

function TypeChip({ type }: { type: LiveEvent["type"] }) {
  const m = META[type];
  const isCard = type === "yellowcard" || type === "redcard";
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 ring-1 text-[9px] font-bold uppercase tracking-wide shrink-0 ${m.chip}`}>
      {type === "goal" || type === "own-goal" ? <span className="h-1.5 w-1.5 rounded-full bg-current" />
        : type === "substitution" ? <ArrowLeftRight className="h-2.5 w-2.5" strokeWidth={2.5} />
        : isCard ? <span className="h-2.5 w-[7px] rounded-[1px] bg-current" />
        : null}
      {m.label}
    </span>
  );
}

function statDisplay(v: number | string | null | undefined, suffix = "") {
  if (v == null || v === "") return "—";
  return `${v}${suffix}`;
}

function StatRow({ label, pair, suffix = "" }: { label: string; pair?: StatPair; suffix?: string }) {
  return (
    <div className="grid grid-cols-[52px_1fr_52px] items-center gap-3 py-1.5 text-[11px]">
      <span className="font-mono font-bold text-[#8a93a3] text-right tabular-nums">{statDisplay(pair?.away, suffix)}</span>
      <span className="text-center text-[#6b7068] uppercase tracking-[0.14em] text-[9px] font-bold">{label}</span>
      <span className="font-mono font-bold text-[#5fe39a] tabular-nums">{statDisplay(pair?.home, suffix)}</span>
    </div>
  );
}

function EventRow({ ev, home, away }: { ev: LiveEvent; home: string; away: string }) {
  const team = ev.team === "home" ? home : away;
  const isGoal = ev.type === "goal" || ev.type === "own-goal";
  const min = ev.minute != null ? `${ev.minute}${ev.extra ? `+${ev.extra}` : ""}'` : "";
  return (
    <div className={`flex items-center gap-2.5 px-2 py-2.5 rounded-lg animate-[fadeIn_0.4s_ease] ${isGoal ? "bg-[#3ee68a]/[0.05]" : ""}`}>
      <span className="text-[11px] font-mono text-[#6b7068] w-[34px] shrink-0 tabular-nums text-right">{min}</span>
      <TypeChip type={ev.type} />
      <span className={`text-[12.5px] truncate min-w-0 ${isGoal ? "text-white font-semibold" : "text-[#c4c7c0]"}`}>
        {ev.player || META[ev.type].label}
        {ev.related && ev.type === "substitution" && <span className="text-[#6b7068]"> ↔ {ev.related}</span>}
      </span>
      <span className="ml-auto text-[10.5px] text-[#7a8278] shrink-0 truncate max-w-[110px]">{team}</span>
    </div>
  );
}

export default function LiveCenter({
  gameId, fixtureId, homeTeam, awayTeam, homePrior, awayPrior, totalLine, marketNote,
}: {
  gameId: string; fixtureId: string | null; homeTeam: string; awayTeam: string;
  homePrior?: number; awayPrior?: number; totalLine?: number | null;
  marketNote?: string | null;
}) {
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

  // Pre-match / not yet live: intentional placeholder.
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
            <p className="text-[11px] text-[#6b7068] mt-0.5">The score, clock and key moments will appear here in real time. Projected lineups land ~1 hour before kickoff.</p>
          </div>
        </div>
      </div>
    );
  }

  const events = state?.events ?? [];
  const clock = finished ? "Full time" : state?.minute != null ? `${state.minute}'` : "Live";
  const wp = liveWinProb({
    homePrior: homePrior ?? 0.4, awayPrior: awayPrior ?? 0.35,
    homeScore: state?.home_score ?? 0, awayScore: state?.away_score ?? 0,
    minute: state?.minute ?? null, totalLine: totalLine ?? null, finished,
  });
  const wpPct = (n: number) => `${Math.round(n * 100)}%`;
  const stats = state?.statistics;
  const hasStats = !!stats && [stats.shots_on_target, stats.shots_total, stats.possession, stats.corners]
    .some((pair) => pair?.home != null || pair?.away != null);
  return (
    <div className="relative overflow-hidden rounded-2xl border border-[#26321f] bg-[#0a0c0a]">
      <div className="pointer-events-none absolute inset-0 opacity-[0.05] bg-[repeating-linear-gradient(0deg,transparent,transparent_3px,#3ee68a_3px,#3ee68a_4px)]" />
      <div className="relative flex items-center justify-between px-5 pt-4 pb-2.5 border-b border-[#161a16]">
        <span className="text-[10.5px] font-bold uppercase tracking-[0.2em] text-[#aab0a4]">Match events</span>
        <span className={finished
          ? "text-[10px] font-mono uppercase tracking-[0.12em] text-[#7a8278]"
          : "inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-[#ef6b6b]"}>
          {!finished && <span className="h-1.5 w-1.5 rounded-full bg-[#ef4444] animate-pulse" />}{clock}
        </span>
      </div>
      <LiveSignalPanel state={state} home={home} away={away} />
      {/* live win-probability — updates with score + time */}
      <div className="relative px-5 pt-3.5 pb-3 border-b border-[#161a16]">
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-[#141714]">
          <div className="bg-[#3a4250]" style={{ width: `${wp.away * 100}%` }} />
          <div className="bg-[#6b6f3a]" style={{ width: `${wp.draw * 100}%` }} />
          <div className="bg-[#3ee68a]" style={{ width: `${wp.home * 100}%` }} />
        </div>
        <div className="mt-2 flex items-center justify-between text-[10.5px] font-mono">
          <span className="text-[#8a93a3] truncate max-w-[34%]">{away} {wpPct(wp.away)}</span>
          <span className="text-[#b8b06a]">Draw {wpPct(wp.draw)}</span>
          <span className="text-[#5fe39a] truncate max-w-[34%] text-right">{home} {wpPct(wp.home)}</span>
        </div>
        <p className="mt-2 text-[9.5px] text-[#4a524a]">{finished ? "Final result." : "Live win chance — updates with the score and time left."}</p>
        {!finished && marketNote && (
          <p className="mt-2 pt-2 border-t border-[#121512] text-[11px] text-[#9ca39a] leading-relaxed">
            <span className="text-[#5fe39a] font-semibold">Market read · </span>{marketNote}
            <span className="text-[#4a524a]"> From the latest odds refresh — a read, not a recommendation.</span>
          </p>
        )}
      </div>
      {hasStats && (
        <div className="relative px-5 py-3 border-b border-[#161a16]">
          <div className="mb-1 grid grid-cols-[52px_1fr_52px] items-center gap-3 text-[9px] uppercase tracking-[0.16em] text-[#4a524a]">
            <span className="text-right truncate">{away}</span>
            <span className="text-center">Live stats</span>
            <span className="truncate">{home}</span>
          </div>
          <StatRow label="Possession" pair={stats?.possession} suffix="%" />
          <StatRow label="Danger attacks" pair={stats?.dangerous_attacks} />
          <StatRow label="Shots" pair={stats?.shots_total} />
          <StatRow label="SOT" pair={stats?.shots_on_target} />
          <StatRow label="Corners" pair={stats?.corners} />
        </div>
      )}
      {events.length > 0 ? (
        <div className="relative px-3 py-2 max-h-[300px] overflow-y-auto">
          {events.map((ev, i) => <EventRow key={`${ev.minute}-${ev.type}-${i}`} ev={ev} home={home} away={away} />)}
        </div>
      ) : (
        <p className="relative px-5 py-4 text-[11.5px] text-[#6b7068]">
          {loaded ? "No goals, cards or subs yet — they'll appear here the moment they happen." : "Loading live feed…"}
        </p>
      )}
      <div className="relative px-5 py-2 border-t border-[#121512]">
        <span className="text-[9.5px] text-[#4a524a] uppercase tracking-wide">Auto-updating · refreshes every 20s</span>
      </div>
    </div>
  );
}
