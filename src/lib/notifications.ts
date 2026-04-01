import type { Game } from "@/types/game";
import type { NotificationItem } from "@/types/notification";
import { getConfidenceForGame, getSignalsForGame } from "@/lib/signals";

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function generateNotifications(games: Game[]): NotificationItem[] {
  const items: NotificationItem[] = [];

  for (const game of games.slice(0, 12)) {
    const h = hash(game.id);
    const confidence = getConfidenceForGame(game.id);
    const signals = getSignalsForGame(game.id, game.home_team, game.away_team);
    const top = signals[0];
    const href = `/dashboard/tracked/${game.id}`;

    if (top?.severity === "high") {
      items.push({
        id: `notif-high-${game.id}`,
        gameId: game.id,
        title: top.type === "injury" ? "Key player status changed" : "Major signal update",
        body: top.summary,
        kind: top.type === "injury" ? "injury-out" : "market-shock",
        severity: "critical",
        forced: true,
        createdAt: new Date(Date.now() - (h % 50) * 60000).toISOString(),
        href,
      });
    }

    if (game.status === "live" && h % 3 === 0) {
      items.push({
        id: `notif-live-${game.id}`,
        gameId: game.id,
        title: "Tracked game is live",
        body: `${game.away_team} @ ${game.home_team} just went live`,
        kind: "game-live",
        severity: "info",
        forced: true,
        createdAt: new Date(Date.now() - (h % 15) * 60000).toISOString(),
        href,
      });
    }

    if (confidence.status === "degraded" || (confidence.status === "volatile" && confidence.pct < 75)) {
      items.push({
        id: `notif-conf-${game.id}`,
        gameId: game.id,
        title: "Confidence dropped",
        body: confidence.explanation,
        kind: "confidence-drop",
        severity: confidence.status === "degraded" ? "warning" : "info",
        forced: confidence.status === "degraded",
        createdAt: new Date(Date.now() - (h % 35) * 60000).toISOString(),
        href,
      });
    }
  }

  const severityRank = { critical: 3, warning: 2, info: 1 } as const;
  return items
    .sort((a, b) => severityRank[b.severity] - severityRank[a.severity])
    .slice(0, 8);
}
