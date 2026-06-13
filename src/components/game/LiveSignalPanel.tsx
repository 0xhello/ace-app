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
}

export interface LiveSignalState {
  live?: boolean;
  finished?: boolean;
  status?: string | null;
  minute?: number | null;
  extra?: number | null;
  clock?: string | null;
  home_team?: string | null;
  away_team?: string | null;
  home_score?: number | null;
  away_score?: number | null;
  events?: LiveEvent[];
  statistics?: LiveStats;
}

type Side = "home" | "away";
type SignalTone = "strong" | "control" | "pressure";

interface LiveSignal {
  tone: SignalTone;
  label: string;
  title: string;
  summary: string;
  bullets: string[];
}

function numberVal(v: number | string | null | undefined): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function teamLabel(side: Side, home: string, away: string) {
  return side === "home" ? home : away;
}

function countEvents(events: LiveEvent[], type: LiveEvent["type"], side: Side) {
  return events.filter((ev) => ev.type === type && ev.team === side).length;
}

function displayMinute(state: LiveSignalState) {
  if (state.clock) return state.clock;
  if (state.minute == null) return null;
  return `${state.minute}${state.extra ? `+${state.extra}` : ""}'`;
}

function buildLiveSignal(state: LiveSignalState | null, home: string, away: string): LiveSignal | null {
  if (!state?.live && !state?.finished) return null;

  const events = state.events ?? [];
  const homeScore = state.home_score ?? 0;
  const awayScore = state.away_score ?? 0;
  const scoreDiff = homeScore - awayScore;
  const leader: Side | null = scoreDiff > 0 ? "home" : scoreDiff < 0 ? "away" : null;
  const trailer: Side | null = leader === "home" ? "away" : leader === "away" ? "home" : null;
  const minute = state.minute ?? 0;
  const minuteLabel = displayMinute(state);
  const stats = state.statistics;

  const homeSot = numberVal(stats?.shots_on_target?.home);
  const awaySot = numberVal(stats?.shots_on_target?.away);
  const homeShots = numberVal(stats?.shots_total?.home);
  const awayShots = numberVal(stats?.shots_total?.away);
  const homePoss = numberVal(stats?.possession?.home);
  const awayPoss = numberVal(stats?.possession?.away);
  const homeCorners = numberVal(stats?.corners?.home);
  const awayCorners = numberVal(stats?.corners?.away);
  const homeReds = countEvents(events, "redcard", "home");
  const awayReds = countEvents(events, "redcard", "away");
  const redAdvSide: Side | null = awayReds > homeReds ? "home" : homeReds > awayReds ? "away" : null;

  const sotDiff = homeSot != null && awaySot != null ? homeSot - awaySot : 0;
  const shotDiff = homeShots != null && awayShots != null ? homeShots - awayShots : 0;
  const cornerDiff = homeCorners != null && awayCorners != null ? homeCorners - awayCorners : 0;
  const possDiff = homePoss != null && awayPoss != null ? homePoss - awayPoss : 0;

  const scoreContext = leader
    ? `${teamLabel(leader, home, away)} leads ${leader === "home" ? homeScore : awayScore}-${leader === "home" ? awayScore : homeScore}${minuteLabel ? ` in the ${minuteLabel}` : ""}`
    : minuteLabel ? `Level match in the ${minuteLabel}` : null;
  const redContext = homeReds || awayReds ? `Player-count state: ${away} ${awayReds} red, ${home} ${homeReds} red` : null;

  if (leader && Math.abs(scoreDiff) >= 2 && redAdvSide === leader && minute >= 55) {
    return {
      tone: "strong",
      label: "Live signal",
      title: `${teamLabel(leader, home, away)} control edge`,
      summary: "Score, clock and player-count state are aligned. This is a strong live-state read; the market still needs to confirm price.",
      bullets: [scoreContext, redContext].filter(Boolean) as string[],
    };
  }

  if (leader && (redAdvSide === leader || (leader === "home" ? shotDiff >= 8 : shotDiff <= -8)) && minute >= 45) {
    return {
      tone: "control",
      label: "Live signal",
      title: `${teamLabel(leader, home, away)} control building`,
      summary: "The live state favors the team already ahead. The next check is whether the market has fully adjusted.",
      bullets: [scoreContext, redContext].filter(Boolean) as string[],
    };
  }

  if (trailer) {
    const trailerSotEdge = trailer === "home" ? sotDiff >= 2 : sotDiff <= -2;
    const trailerCornerEdge = trailer === "home" ? cornerDiff >= 2 : cornerDiff <= -2;
    const trailerPossEdge = trailer === "home" ? possDiff >= 8 : possDiff <= -8;
    if (trailerSotEdge || (trailerCornerEdge && trailerPossEdge)) {
      return {
        tone: "pressure",
        label: "Live signal",
        title: `${teamLabel(trailer, home, away)} pressure building`,
        summary: "The trailing side is creating enough pressure to keep the match state unstable. Watch the next live price refresh rather than leaning on the score alone.",
        bullets: [scoreContext, "Pressure trigger: chance creation is outpacing the scoreline."].filter(Boolean) as string[],
      };
    }
  }

  if (redAdvSide) {
    return {
      tone: "control",
      label: "Live signal",
      title: `${teamLabel(redAdvSide, home, away)} player-count edge`,
      summary: "The red-card state has changed the match shape. Wait for the market to refresh before treating it as actionable.",
      bullets: [redContext, scoreContext].filter(Boolean) as string[],
    };
  }

  return null;
}

export default function LiveSignalPanel({ state, home, away }: { state: LiveSignalState | null; home: string; away: string }) {
  const signal = buildLiveSignal(state, home, away);
  if (!signal) return null;

  const toneClass = signal.tone === "strong"
    ? "border-[#2c4a2f] bg-[#0f1a10]"
    : signal.tone === "pressure"
      ? "border-[#4a3f20] bg-[#12100a]"
      : "border-[#26321f] bg-[#0d120c]";

  return (
    <div className={`relative mx-5 mt-4 rounded-xl border px-4 py-3 ${toneClass}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[9.5px] font-bold uppercase tracking-[0.2em] text-[#7a8278]">{signal.label}</p>
          <h3 className="mt-1 text-[14px] font-bold text-[#e7eae4]">{signal.title}</h3>
        </div>
        <span className="shrink-0 rounded-md border border-[#26321f] px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em] text-[#8a9286]">Market check needed</span>
      </div>
      <p className="mt-2 text-[11.5px] leading-relaxed text-[#9ca39a]">{signal.summary}</p>
      {signal.bullets.length > 0 && (
        <div className="mt-2 grid gap-1.5">
          {signal.bullets.map((b, i) => (
            <div key={i} className="flex gap-2 text-[10.5px] text-[#c4c7c0]">
              <span className="mt-1.5 h-1 w-1 rounded-full bg-[#6f786d] shrink-0" />
              <span>{b}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
