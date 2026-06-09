import type { Game } from "@/types/game";
import type { PreparedGameIntel } from "@/lib/game-intel-cache";
import { lineupsAreLive, type MatchAlphaDigest } from "@/lib/match-alpha";
import { formatEtTime } from "@/lib/time-format";

export type MatchReadStatus = "quiet" | "watch" | "lineups" | "live" | "final";
export type MatchReadImportance = "low" | "medium" | "high";
export type MatchReadMomentType =
  | "lineup_window"
  | "since_last_check"
  | "lineups_confirmed"
  | "live_event"
  | "tactical_watch"
  | "quiet";

export interface MatchReadMoment {
  type: MatchReadMomentType;
  rank: number;
  label: string;
  title: string;
  detail: string;
  importance: MatchReadImportance;
}

export interface MatchReadWindow {
  label: string;
  time: string;
  detail: string;
}

export interface MatchRead {
  sport: "soccer";
  status: MatchReadStatus;
  headline: string;
  summary: string;
  moments: MatchReadMoment[];
  nextWindows: MatchReadWindow[];
}

function kickoffDate(game: Game): Date | null {
  const d = new Date(game.commence_time);
  return Number.isFinite(d.getTime()) ? d : null;
}

function formatTime(d: Date): string {
  return formatEtTime(d, { weekday: "short" });
}

function hoursToKickoff(game: Game): number | null {
  const d = kickoffDate(game);
  if (!d) return null;
  return (d.getTime() - Date.now()) / 3_600_000;
}

function lineupWindow(game: Game): MatchReadWindow | null {
  const d = kickoffDate(game);
  if (!d) return null;
  const start = new Date(d.getTime() - 60 * 60_000);
  return {
    label: "Lineups",
    time: `${formatTime(start)}–${formatTime(d)}`,
    detail: "Confirmed XIs usually make this page much sharper.",
  };
}

function kickoffWindow(game: Game): MatchReadWindow | null {
  const d = kickoffDate(game);
  if (!d) return null;
  return {
    label: "Kickoff",
    time: formatTime(d),
    detail: "Score, cards, subs and tempo become the main read once it starts.",
  };
}

export function buildSoccerMatchRead(
  game: Game,
  prepared: PreparedGameIntel | null,
  alpha: MatchAlphaDigest,
): MatchRead | null {
  if (!game.sport.startsWith("soccer")) return null;

  const isLive = game.status === "live";
  const isFinal = game.status === "final";
  const h = hoursToKickoff(game);
  // Only trust lineup coverage as CONFIRMED XIs near kickoff (or live/final) —
  // rows further out are projected/stale. Avoids "Starting XIs are in" days out.
  const lineupsConfirmed = lineupsAreLive(game, alpha.coverage.lineups);
  const moments: MatchReadMoment[] = [];

  if (alpha.coverage.latestChange) {
    moments.push({
      type: "since_last_check",
      rank: 0,
      label: alpha.coverage.latestChange.label,
      title: "Match read updated",
      detail: alpha.coverage.latestChange.detail,
      importance: "high",
    });
  }

  if (isLive) {
    moments.push({
      type: "live_event",
      rank: 1,
      label: "Live",
      title: game.scoreboard?.clock ? `Clock: ${game.scoreboard.clock}` : "Live now",
      detail: "Score, cards, subs and pressure matter more than pre-match notes now.",
      importance: "high",
    });
  }

  if (lineupsConfirmed) {
    moments.push({
      type: "lineups_confirmed",
      rank: isLive ? 3 : 1,
      label: "Lineups",
      title: alpha.coverage.starters >= 22 ? "Starting XIs are in" : `${alpha.coverage.lineups} names on the sheet`,
      detail: alpha.coverage.starters >= 22
        ? "The page can move from pre-match assumptions to actual shape, roles and matchups."
        : "The sheet is partially populated. Wait for confirmed XIs before treating it as decisive.",
      importance: alpha.coverage.starters >= 22 ? "high" : "medium",
    });
  } else if (!isLive && !isFinal) {
    moments.push({
      type: "lineup_window",
      rank: h != null && h <= 4 ? 1 : 2,
      label: "Watch",
      title: "Lineups are the next real signal",
      detail: h != null && h > 24
        ? "Nothing needs to be forced this far out. Confirmed XIs should matter more than early noise."
        : "This is where the read can change quickly: starters, formation and late scratches.",
      importance: h != null && h <= 4 ? "high" : "medium",
    });
  }

  if (!moments.length) {
    moments.push({
      type: "quiet",
      rank: 99,
      label: "Quiet",
      title: "Nothing meaningful has changed",
      detail: "No match-state change strong enough to alter the page yet.",
      importance: "low",
    });
  }

  const sorted = moments.sort((a, b) => a.rank - b.rank).slice(0, 5);
  const primary = sorted[0];
  const nextWindows = [lineupWindow(game), kickoffWindow(game)].filter(Boolean) as MatchReadWindow[];

  let status: MatchReadStatus = "quiet";
  if (isFinal) status = "final";
  else if (isLive) status = "live";
  else if (lineupsConfirmed) status = "lineups";
  else if (primary.importance !== "low") status = "watch";

  const headline = isFinal
    ? "Final read"
    : isLive
      ? "Game state is live"
      : primary.type === "quiet"
        ? "No clear angle yet"
        : primary.title;

  const summary = isLive
    ? "The pre-match read takes a back seat now. Watch score, pressure, cards and substitutions."
    : primary.type === "quiet"
      ? "Quiet is fine. There is no need to manufacture a bet before the useful signals arrive."
      : primary.detail;

  return {
    sport: "soccer",
    status,
    headline,
    summary,
    moments: sorted,
    nextWindows,
  };
}
