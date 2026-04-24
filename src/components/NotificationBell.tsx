"use client";

import Link from "next/link";
import { useMemo, useState, useEffect } from "react";
import { Bell, AlertTriangle, Info, ChevronRight } from "lucide-react";
import type { Game } from "@/types/game";
import type { NotificationItem } from "@/types/notification";
import { generateNotifications } from "@/lib/notifications";
import { loadAlerts } from "@/lib/alerts";
import type { PriceAlert } from "@/lib/alerts";
import { cn } from "@/lib/utils";

function timeAgo(iso: string) {
  const mins = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins >= 60) return `${Math.floor(mins / 60)}h ago`;
  return `${mins}m ago`;
}

export default function NotificationBell({ games }: { games: Game[] }) {
  const [open, setOpen] = useState(false);
  const [triggeredAlerts, setTriggeredAlerts] = useState<PriceAlert[]>([]);

  useEffect(() => {
    setTriggeredAlerts(loadAlerts().filter((a) => a.status === "triggered"));
  }, [open]); // refresh when bell is opened

  const signalNotifs = useMemo(() => generateNotifications(games), [games]);

  const alertNotifs: NotificationItem[] = triggeredAlerts.map((a) => ({
    id: `price-${a.id}`,
    gameId: a.gameId,
    title: "Price alert triggered",
    body: `${a.team} ${a.market.toUpperCase()} ${a.condition === "rises_above" ? "↑" : "↓"} ${a.threshold > 0 ? "+" : ""}${a.threshold}${a.triggeredOdds !== undefined ? ` (now ${a.triggeredOdds > 0 ? "+" : ""}${a.triggeredOdds})` : ""}`,
    kind: "market-shock" as const,
    severity: "warning" as const,
    forced: true,
    createdAt: a.triggeredAt ?? a.createdAt,
    href: "/dashboard/alerts",
  }));

  const notifications = [...alertNotifs, ...signalNotifs]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 10);

  const unread = notifications.length;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative p-1.5 rounded-lg text-[#3f3f46] hover:text-[#71717a] hover:bg-white/[0.03] transition-all"
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-[#ef4444]" />}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-[320px] rounded-xl border border-[#141417] bg-[#0c0c0e] shadow-2xl z-50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-[#141417]">
            <div>
              <p className="text-[12px] font-semibold text-white">Notifications</p>
              <p className="text-[10px] text-[#52525b]">Alerts + signals</p>
            </div>
            <span className="text-[10px] font-mono text-[#ef4444]">{unread}</span>
          </div>

          <div className="max-h-[360px] overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="px-4 py-6 text-center text-[11px] text-[#52525b]">No new alerts</div>
            ) : notifications.map((n) => (
              <Link
                key={n.id}
                href={n.href}
                onClick={() => setOpen(false)}
                className="flex items-start gap-3 px-4 py-3 border-b border-[#141417] last:border-b-0 hover:bg-white/[0.02] transition-colors"
              >
                <div className={cn(
                  "mt-0.5 h-7 w-7 rounded-lg border flex items-center justify-center shrink-0",
                  n.severity === "critical"
                    ? "border-[#ef4444]/20 bg-[#ef4444]/8 text-[#ef4444]"
                    : n.severity === "warning"
                    ? "border-[#f59e0b]/20 bg-[#f59e0b]/8 text-[#f59e0b]"
                    : "border-[#1e1e24] bg-[#111113] text-[#71717a]"
                )}>
                  {n.severity === "critical" ? <AlertTriangle className="h-3.5 w-3.5" /> : <Info className="h-3.5 w-3.5" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                    <p className="text-[11px] font-semibold text-white">{n.title}</p>
                    {n.forced && <span className="text-[8px] font-bold text-[#ef4444] uppercase tracking-wider">Forced</span>}
                  </div>
                  <p className="text-[10px] text-[#71717a] leading-relaxed">{n.body}</p>
                  <p className="text-[9px] text-[#3f3f46] mt-1">{timeAgo(n.createdAt)}</p>
                </div>
                <ChevronRight className="h-3.5 w-3.5 text-[#27272a] shrink-0 mt-1" />
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
