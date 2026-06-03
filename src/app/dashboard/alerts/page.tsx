"use client";

import { useEffect, useState, useCallback } from "react";
import type { PriceAlert } from "@/lib/alerts";
import { requestNotificationPermission } from "@/lib/alerts";
import { cn } from "@/lib/utils";
import { Bell, BellOff, Plus, Trash2, CheckCircle2, Clock, X, Star } from "lucide-react";
import { Skeleton } from "@/components/ui/Skeleton";

const MARKET_LABELS: Record<string, string> = { ml: "Moneyline", spread: "Spread", total: "Total" };
const CONDITION_LABELS: Record<string, string> = { rises_above: "rises above", drops_below: "drops below" };

function timeAgo(iso: string) {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (d < 1) return "just now";
  if (d < 60) return `${d}m ago`;
  return `${Math.floor(d / 60)}h ago`;
}

function AlertCard({ alert, onDelete, onDismiss }: { alert: PriceAlert; onDelete: () => void; onDismiss: () => void }) {
  const isTriggered = alert.status === "triggered";
  return (
    <div className={cn(
      "rounded-xl border bg-[#121412] p-4 transition-all",
      isTriggered ? "border-[#3ee68a]/25 bg-[#3ee68a]/[0.03]" : "border-[#22251f]"
    )}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-semibold text-white truncate">{alert.matchup}</p>
          <p className="text-[10px] text-[#6b7068] mt-0.5">
            <span className="text-[#9ca39a]">{alert.team}</span>
            {" · "}{MARKET_LABELS[alert.market]}
            {" · odds "}{CONDITION_LABELS[alert.condition]}
            {" "}<span className="font-mono text-[#d4d7d0]">{alert.threshold > 0 ? "+" : ""}{alert.threshold}</span>
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isTriggered && (
            <button onClick={onDismiss} className="text-[9px] text-[#3ee68a] hover:text-white transition-colors font-medium">
              Dismiss
            </button>
          )}
          <button onClick={onDelete} className="text-[#27272a] hover:text-[#ef4444] transition-colors">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 mt-3">
        {isTriggered ? (
          <span className="flex items-center gap-1 text-[9px] font-bold text-[#3ee68a] uppercase tracking-wide">
            <CheckCircle2 className="h-3 w-3" /> Triggered {alert.triggeredAt ? timeAgo(alert.triggeredAt) : ""}
            {alert.triggeredOdds !== undefined && (
              <span className="ml-1 font-mono">(hit {alert.triggeredOdds > 0 ? "+" : ""}{alert.triggeredOdds})</span>
            )}
          </span>
        ) : (
          <span className="flex items-center gap-1 text-[9px] text-[#6b7068] uppercase tracking-wide">
            <Clock className="h-3 w-3" /> Watching · set {timeAgo(alert.createdAt)}
          </span>
        )}
        {alert.book !== "any" && (
          <span className="ml-auto text-[9px] text-[#6b7068]">{alert.book}</span>
        )}
      </div>
    </div>
  );
}

type AlertForm = {
  gameId: string;
  matchup: string;
  team: string;
  market: "ml" | "spread" | "total";
  side: "away" | "home" | "over" | "under";
  condition: "rises_above" | "drops_below";
  threshold: number;
  book: string;
};

const BLANK: AlertForm = {
  gameId: "",
  matchup: "",
  team: "",
  market: "ml",
  side: "away",
  condition: "drops_below",
  threshold: -110,
  book: "any",
};

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<PriceAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [notifPermission, setNotifPermission] = useState<NotificationPermission>("default");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ ...BLANK });
  const [watchedGames, setWatchedGames] = useState<any[]>([]);

  const fetchAlerts = useCallback(async () => {
    try {
      const res = await fetch("/api/alerts");
      if (res.ok) {
        const data = await res.json();
        setAlerts(data.alerts ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAlerts();
    if ("Notification" in window) setNotifPermission(Notification.permission);

    async function loadWatching() {
      try {
        const [wl, board] = await Promise.all([
          fetch("/api/watchlist").then((r) => r.json()),
          fetch("/api/board").then((r) => r.json()),
        ]);
        const ids = new Set<string>(wl.gameIds ?? []);
        setWatchedGames((board.games ?? []).filter((g: any) => ids.has(g.id)));
      } catch {}
    }
    loadWatching();
  }, [fetchAlerts]);

  async function enableNotifications() {
    const perm = await requestNotificationPermission();
    setNotifPermission(perm);
  }

  async function handleCreate() {
    if (!form.matchup.trim() || !form.team.trim()) return;
    const alert: PriceAlert = {
      ...form,
      id: `alert-${Date.now()}`,
      status: "active",
      createdAt: new Date().toISOString(),
    };
    await fetch("/api/alerts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alert }),
    });
    setForm({ ...BLANK });
    setShowForm(false);
    fetchAlerts();
  }

  async function handleDelete(id: string) {
    await fetch(`/api/alerts/${id}`, { method: "DELETE" });
    fetchAlerts();
  }

  async function handleDismiss(id: string) {
    await fetch(`/api/alerts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "dismissed" }),
    });
    fetchAlerts();
  }

  const active = alerts.filter((a) => a.status === "active");
  const triggered = alerts.filter((a) => a.status === "triggered");
  const dismissed = alerts.filter((a) => a.status === "dismissed");

  if (loading) {
    return (
      <div className="flex-1 overflow-y-auto bg-[#0a0b0a]">
        <div className="max-w-3xl mx-auto px-6 py-6">
          <div className="flex items-center justify-between gap-4 mb-6">
            <div className="space-y-2">
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-3 w-64" />
            </div>
            <Skeleton className="h-9 w-28 rounded-lg" />
          </div>
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="rounded-xl border border-[#1b201a] bg-[#0d0f0d] p-4 flex items-center gap-3">
                <Skeleton className="h-8 w-8 rounded-lg" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3 w-40" />
                  <Skeleton className="h-2.5 w-24" />
                </div>
                <Skeleton className="h-6 w-16 rounded-md" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto bg-[#0a0b0a]">
      <div className="max-w-3xl mx-auto px-6 py-6">

        <div className="flex items-center justify-between gap-4 mb-6">
          <div>
            <h1 className="text-[20px] font-bold text-white">Alerts</h1>
            <p className="text-[12px] text-[#6b7068] mt-1">Get notified when odds hit your target price.</p>
          </div>
          <button
            onClick={() => setShowForm(!showForm)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#3ee68a]/10 border border-[#3ee68a]/20 text-[#3ee68a] text-[11px] font-bold hover:bg-[#3ee68a]/15 transition-colors"
          >
            <Plus className="h-3.5 w-3.5" /> New Alert
          </button>
        </div>

        {notifPermission !== "granted" && (
          <div className="rounded-xl border border-[#f59e0b]/20 bg-[#f59e0b]/[0.04] p-4 mb-5 flex items-center gap-3">
            <BellOff className="h-4 w-4 text-[#f59e0b] shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-semibold text-white">Browser notifications are off</p>
              <p className="text-[10px] text-[#9ca39a] mt-0.5">Enable them to get alerted even when the tab is in the background.</p>
            </div>
            {notifPermission !== "denied" && (
              <button
                onClick={enableNotifications}
                className="shrink-0 px-3 py-1.5 rounded-lg bg-[#f59e0b]/15 border border-[#f59e0b]/25 text-[#f59e0b] text-[10px] font-bold hover:bg-[#f59e0b]/25 transition-colors"
              >
                Enable
              </button>
            )}
          </div>
        )}

        {showForm && (
          <div className="rounded-xl border border-[#2e332a] bg-[#121412] p-4 mb-5">
            <div className="flex items-center justify-between mb-4">
              <p className="text-[12px] font-bold text-white">New price alert</p>
              <button onClick={() => setShowForm(false)} className="text-[#6b7068] hover:text-[#9ca39a]">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="text-[9px] text-[#6b7068] uppercase tracking-wider block mb-1">Matchup</label>
                <input
                  value={form.matchup}
                  onChange={(e) => setForm({ ...form, matchup: e.target.value })}
                  placeholder="e.g. Lakers @ Celtics"
                  className="w-full bg-[#111113] border border-[#2e332a] rounded-lg px-3 py-2 text-[11px] text-white placeholder:text-[#6b7068] outline-none focus:border-[#2a2a35]"
                />
              </div>
              <div>
                <label className="text-[9px] text-[#6b7068] uppercase tracking-wider block mb-1">Team / Side</label>
                <input
                  value={form.team}
                  onChange={(e) => setForm({ ...form, team: e.target.value })}
                  placeholder="e.g. LA Lakers"
                  className="w-full bg-[#111113] border border-[#2e332a] rounded-lg px-3 py-2 text-[11px] text-white placeholder:text-[#6b7068] outline-none focus:border-[#2a2a35]"
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3 mb-4">
              <div>
                <label className="text-[9px] text-[#6b7068] uppercase tracking-wider block mb-1">Market</label>
                <select
                  value={form.market}
                  onChange={(e) => setForm({ ...form, market: e.target.value as any })}
                  className="w-full bg-[#111113] border border-[#2e332a] rounded-lg px-3 py-2 text-[11px] text-white outline-none"
                >
                  <option value="ml">Moneyline</option>
                  <option value="spread">Spread</option>
                  <option value="total">Total</option>
                </select>
              </div>
              <div>
                <label className="text-[9px] text-[#6b7068] uppercase tracking-wider block mb-1">Condition</label>
                <select
                  value={form.condition}
                  onChange={(e) => setForm({ ...form, condition: e.target.value as any })}
                  className="w-full bg-[#111113] border border-[#2e332a] rounded-lg px-3 py-2 text-[11px] text-white outline-none"
                >
                  <option value="drops_below">Drops below</option>
                  <option value="rises_above">Rises above</option>
                </select>
              </div>
              <div>
                <label className="text-[9px] text-[#6b7068] uppercase tracking-wider block mb-1">Target odds</label>
                <input
                  type="number"
                  value={form.threshold}
                  onChange={(e) => setForm({ ...form, threshold: Number(e.target.value) })}
                  className="w-full bg-[#111113] border border-[#2e332a] rounded-lg px-3 py-2 text-[11px] font-mono text-white outline-none focus:border-[#2a2a35]"
                />
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleCreate}
                disabled={!form.matchup.trim() || !form.team.trim()}
                className="flex-1 py-2 rounded-lg bg-[#3ee68a]/10 border border-[#3ee68a]/20 text-[#3ee68a] text-[11px] font-bold hover:bg-[#3ee68a]/15 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Create Alert
              </button>
              <button onClick={() => setShowForm(false)} className="px-4 py-2 rounded-lg border border-[#2e332a] text-[#6b7068] text-[11px] hover:text-[#d4d7d0] transition-colors">
                Cancel
              </button>
            </div>
          </div>
        )}

        {watchedGames.length > 0 && (
          <div className="mb-6">
            <p className="text-[10px] text-[#6b7068] font-semibold uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <Star className="h-3 w-3 fill-current text-[#3ee68a]" /> Watched Games
            </p>
            <div className="space-y-2">
              {watchedGames.map((g: any) => {
                const homeAbbr = g.home_team.split(" ").at(-1);
                const awayAbbr = g.away_team.split(" ").at(-1);
                const allSpreads = g.bookmakers?.flatMap((b: any) => b.markets?.spreads ?? []) ?? [];
                const homeSpread = allSpreads.find((s: any) => s.name === g.home_team);
                const homeLine = homeSpread?.point ?? null;
                const spreadOdds = homeSpread?.price ?? -110;
                const matchupLabel = `${awayAbbr} @ ${homeAbbr}`;
                return (
                  <div key={g.id} className="rounded-xl border border-[#22251f] bg-[#121412] p-3 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-[12px] font-semibold text-white">{matchupLabel}</p>
                      {homeLine !== null && (
                        <p className="text-[10px] text-[#6b7068] mt-0.5">
                          {homeAbbr} {homeLine > 0 ? "+" : ""}{homeLine} · {spreadOdds > 0 ? "+" : ""}{spreadOdds}
                        </p>
                      )}
                    </div>
                    <button
                      onClick={() => {
                        setForm({
                          gameId: g.id,
                          matchup: matchupLabel,
                          team: g.home_team,
                          market: "spread",
                          side: "home",
                          condition: "drops_below",
                          threshold: spreadOdds,
                          book: "any",
                        });
                        setShowForm(true);
                        window.scrollTo({ top: 0, behavior: "smooth" });
                      }}
                      className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[#2e332a] text-[#6b7068] text-[10px] font-semibold hover:text-[#3ee68a] hover:border-[#3ee68a]/30 transition-colors"
                    >
                      <Bell className="h-3 w-3" /> Set alert
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {triggered.length > 0 && (
          <div className="mb-5">
            <p className="text-[10px] text-[#3ee68a] font-semibold uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <CheckCircle2 className="h-3 w-3" /> Triggered ({triggered.length})
            </p>
            <div className="space-y-2">
              {triggered.map((a) => (
                <AlertCard key={a.id} alert={a}
                  onDelete={() => handleDelete(a.id)}
                  onDismiss={() => handleDismiss(a.id)}
                />
              ))}
            </div>
          </div>
        )}

        <div className="mb-5">
          <p className="text-[10px] text-[#6b7068] font-semibold uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Bell className="h-3 w-3" /> Watching ({active.length})
          </p>
          {active.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[#2e332a] py-10 text-center">
              <Bell className="h-5 w-5 text-[#27272a] mx-auto mb-2" />
              <p className="text-[12px] text-[#6b7068] font-medium">No active alerts</p>
              <p className="text-[10px] text-[#6b7068] mt-1">Hit "New Alert" to watch a price.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {active.map((a) => (
                <AlertCard key={a.id} alert={a}
                  onDelete={() => handleDelete(a.id)}
                  onDismiss={() => handleDismiss(a.id)}
                />
              ))}
            </div>
          )}
        </div>

        {dismissed.length > 0 && (
          <p className="text-[10px] text-[#27272a] text-center">{dismissed.length} dismissed alert{dismissed.length > 1 ? "s" : ""} hidden</p>
        )}
      </div>
    </div>
  );
}
