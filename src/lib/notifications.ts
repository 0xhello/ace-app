import type { Game } from "@/types/game";
import type { NotificationItem } from "@/types/notification";
import type { GameIntel } from "@/lib/live-signals";

export function generateNotifications(
  games: Game[],
  intelMap: Record<string, GameIntel> = {}
): NotificationItem[] {
  const items: NotificationItem[] = [];

  for (const game of games.slice(0, 20)) {
    const intel = intelMap[game.id];
    const href = `/dashboard/tracked/${game.id}`;

    if (intel) {
      const topSignal = intel.signals.find((s) => s.severity === "high") ?? intel.signals.find((s) => s.severity === "medium");

      if (topSignal && intel.has_high_severity) {
        items.push({
          id: `notif-high-${game.id}`,
          gameId: game.id,
          title: topSignal.type === "model" ? "ACE model signal" : topSignal.type === "weather" ? "Weather alert" : "Signal detected",
          body: topSignal.title,
          kind: topSignal.type === "model" ? "market-shock" : topSignal.type === "weather" ? "market-shock" : "market-shock",
          severity: "critical",
          forced: true,
          createdAt: game.commence_time,
          href,
        });
      }

      if (intel.signals_count > 0 && !intel.has_high_severity && topSignal) {
        items.push({
          id: `notif-sig-${game.id}`,
          gameId: game.id,
          title: "Signal update",
          body: topSignal.title,
          kind: "market-shock",
          severity: "warning",
          forced: false,
          createdAt: game.commence_time,
          href,
        });
      }
    }

    if (game.status === "live") {
      items.push({
        id: `notif-live-${game.id}`,
        gameId: game.id,
        title: "Game is live",
        body: `${game.away_team} @ ${game.home_team} is now in progress`,
        kind: "game-live",
        severity: "info",
        forced: false,
        createdAt: game.commence_time,
        href,
      });
    }
  }

  const severityRank = { critical: 3, warning: 2, info: 1 } as const;
  return items
    .sort((a, b) => severityRank[b.severity] - severityRank[a.severity])
    .slice(0, 8);
}
