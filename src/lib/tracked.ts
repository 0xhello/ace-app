import type { Game } from "@/types/game";
import type { Signal } from "@/types/signal";
import { getSignalsForGame, getConfidenceForGame } from "@/lib/signals";

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export type TrackedBucket = "active" | "quiet" | "completed";

export function getTrackedBucket(game: Game): TrackedBucket {
  if (game.status === "final") return "completed";
  const signals = getSignalsForGame(game.id, game.home_team, game.away_team);
  if (signals.length === 0 || hash(game.id) % 5 === 0) return "quiet";
  return "active";
}

export function getTrackedSummary(game: Game): string {
  const top = getSignalsForGame(game.id, game.home_team, game.away_team)[0];
  if (!top) return "No material signals in the last 30 min";
  return top.summary;
}

export function getTrackingSince(gameId: string): string {
  const h = hash(gameId);
  const mins = 20 + (h % 140);
  if (mins >= 60) {
    const hours = Math.floor(mins / 60);
    const rem = mins % 60;
    return `${hours}h ${rem}m ago`;
  }
  return `${mins}m ago`;
}

export function getConfidenceHistory(gameId: string, homeTeam = "", awayTeam = "") {
  const base = getConfidenceForGame(gameId, homeTeam, awayTeam).pct;
  const h = hash(gameId);
  return Array.from({ length: 12 }).map((_, i) => {
    const drift = ((h + i * 17) % 9) - 4;
    const pct = Math.max(45, Math.min(95, base + drift));
    return { idx: i, pct };
  });
}

export function getPrimaryLean(game: Game): string {
  const conf = getConfidenceForGame(game.id, game.home_team, game.away_team);
  const signals = getSignalsForGame(game.id, game.home_team, game.away_team);
  const first = signals[0];
  if (!first) return "No actionable lean";
  if (first.affectedTeam === "home") return `${game.home_team} favored by signals`;
  if (first.affectedTeam === "away") return `${game.away_team} favored by signals`;
  return conf.pct >= 75 ? "Totals market holds stronger signal" : "Mixed read — stay selective";
}

export function sortSignals(signals: Signal[]) {
  const sev = { high: 3, medium: 2, low: 1 } as const;
  return [...signals].sort((a, b) => sev[b.severity] - sev[a.severity]);
}
