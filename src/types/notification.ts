export type NotificationSeverity = "info" | "warning" | "critical";

export interface NotificationItem {
  id: string;
  gameId: string;
  title: string;
  body: string;
  kind: "injury-out" | "game-live" | "game-final" | "confidence-drop" | "market-shock";
  severity: NotificationSeverity;
  forced: boolean;
  createdAt: string;
  href: string;
}
