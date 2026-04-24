import { Game } from "@/types/game";

export interface PriceAlert {
  id: string;
  gameId: string;
  matchup: string;
  team: string;
  market: "ml" | "spread" | "total";
  side: "away" | "home" | "over" | "under";
  condition: "rises_above" | "drops_below";
  threshold: number; // American odds
  book: string; // "any" or specific book key
  status: "active" | "triggered" | "dismissed";
  createdAt: string;
  triggeredAt?: string;
  triggeredOdds?: number;
  triggeredBook?: string;
}

const KEY = "ace_alerts";

export function loadAlerts(): PriceAlert[] {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(localStorage.getItem(KEY) ?? "[]"); }
  catch { return []; }
}

export function saveAlert(alert: PriceAlert): void {
  const alerts = loadAlerts();
  localStorage.setItem(KEY, JSON.stringify([alert, ...alerts]));
}

export function dismissAlert(id: string): void {
  const alerts = loadAlerts().map((a) => a.id === id ? { ...a, status: "dismissed" as const } : a);
  localStorage.setItem(KEY, JSON.stringify(alerts));
}

export function deleteAlert(id: string): void {
  localStorage.setItem(KEY, JSON.stringify(loadAlerts().filter((a) => a.id !== id)));
}

// Returns newly triggered alerts (mutates localStorage)
export function checkAlerts(games: Game[]): PriceAlert[] {
  const alerts = loadAlerts();
  const triggered: PriceAlert[] = [];

  const updated = alerts.map((alert) => {
    if (alert.status !== "active") return alert;

    const game = games.find((g) => g.id === alert.gameId);
    if (!game) return alert;

    const prices: number[] = [];

    for (const bk of game.bookmakers) {
      if (alert.book !== "any" && bk.sportsbook !== alert.book) continue;

      if (alert.market === "ml") {
        const team = alert.side === "away" ? game.away_team : game.home_team;
        const o = (bk.markets.h2h || []).find((x) => x.name === team);
        if (o) prices.push(o.price);
      } else if (alert.market === "spread") {
        const team = alert.side === "away" ? game.away_team : game.home_team;
        const o = (bk.markets.spreads || []).find((x) => x.name === team);
        if (o) prices.push(o.price);
      } else if (alert.market === "total") {
        const side = alert.side === "over" ? "Over" : "Under";
        const o = (bk.markets.totals || []).find((x) => x.name === side);
        if (o) prices.push(o.price);
      }
    }

    if (!prices.length) return alert;

    // Best price available
    const best = Math.max(...prices);
    const hit =
      (alert.condition === "rises_above" && best > alert.threshold) ||
      (alert.condition === "drops_below" && best < alert.threshold);

    if (hit) {
      const updatedAlert = {
        ...alert,
        status: "triggered" as const,
        triggeredAt: new Date().toISOString(),
        triggeredOdds: best,
      };
      triggered.push(updatedAlert);
      return updatedAlert;
    }

    return alert;
  });

  if (triggered.length) {
    localStorage.setItem(KEY, JSON.stringify(updated));
  }

  return triggered;
}

export function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!("Notification" in window)) return Promise.resolve("denied");
  if (Notification.permission !== "default") return Promise.resolve(Notification.permission);
  return Notification.requestPermission();
}

export function fireNotification(alert: PriceAlert): void {
  if (Notification.permission !== "granted") return;
  new Notification("ACE Price Alert", {
    body: `${alert.team} ${alert.market.toUpperCase()} hit ${alert.condition === "rises_above" ? "↑" : "↓"} ${alert.threshold > 0 ? "+" : ""}${alert.threshold} (now ${alert.triggeredOdds! > 0 ? "+" : ""}${alert.triggeredOdds})`,
    icon: "/favicon.png",
    tag: alert.id,
  });
}
