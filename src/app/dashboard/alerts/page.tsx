"use client";

import { useEffect, useState } from "react";
import {
  loadAlerts, saveAlert, deleteAlert, dismissAlert,
  requestNotificationPermission, type PriceAlert,
} from "@/lib/alerts";
import { cn } from "@/lib/utils";
import { Bell, BellOff, Plus, Trash2, CheckCircle2, Clock, X } from "lucide-react";

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
      "rounded-xl border bg-[#0c0c0e] p-4 transition-all",
      isTriggered ? "border-[#4ade80]/25 bg-[#4ade80]/[0.03]" : "border-[#141417]"
    )}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-semibold text-white truncate">{alert.matchup}</p>
          <p className="text-[10px] text-[#52525b] mt-0.5">
            <span className="text-[#71717a]">{alert.team}</span>
            {" · "}{MARKET_LABELS[alert.market]}
            {" · odds "}{CONDITION_LABELS[alert.condition]}
            {" "}<span className="font-mono text-[#a1a1aa]">{alert.threshold > 0 ? "+" : ""}{alert.threshold}</span>
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isTriggered && (
            <button onClick={onDismiss} className="text-[9px] text-[#4ade80] hover:text-white transition-colors font-medium">
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
          <span className="flex items-center gap-1 text-[9px] font-bold text-[#4ade80] uppercase tracking-wide">
            <CheckCircle2 className="h-3 w-3" /> Triggered {alert.triggeredAt ? timeAgo(alert.triggeredAt) : ""}
            {alert.triggeredOdds !== undefined && (
              <span className="ml-1 font-mono">(hit {alert.triggeredOdds > 0 ? "+" : ""}{alert.triggeredOdds})</span>
            )}
          </span>
        ) : (
          <span className="flex items-center gap-1 text-[9px] text-[#52525b] uppercase tracking-wide">
            <Clock className="h-3 w-3" /> Watching · set {timeAgo(alert.createdAt)}
          </span>
        )}
        {alert.book !== "any" && (
          <span className="ml-auto text-[9px] text-[#3f3f46]">{alert.book}</span>
        )}
      </div>
    </div>
  );
}

const BLANK: Omit<PriceAlert, "id" | "status" | "createdAt"> = {
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
  const [notifPermission, setNotifPermission] = useState<NotificationPermission>("default");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ ...BLANK });

  useEffect(() => {
    setAlerts(loadAlerts());
    if ("Notification" in window) setNotifPermission(Notification.permission);
  }, []);

  function refresh() { setAlerts(loadAlerts()); }

  async function enableNotifications() {
    const perm = await requestNotificationPermission();
    setNotifPermission(perm);
  }

  function handleCreate() {
    if (!form.matchup.trim() || !form.team.trim()) return;
    saveAlert({
      ...form,
      id: `alert-${Date.now()}`,
      status: "active",
      createdAt: new Date().toISOString(),
    });
    setForm({ ...BLANK });
    setShowForm(false);
    refresh();
  }

  const active = alerts.filter((a) => a.status === "active");
  const triggered = alerts.filter((a) => a.status === "triggered");
  const dismissed = alerts.filter((a) => a.status === "dismissed");

  return (
    <div className="flex-1 overflow-y-auto bg-[#09090b]">
      <div className="max-w-3xl mx-auto px-6 py-6">

        {/* Header */}
        <div className="flex items-center justify-between gap-4 mb-6">
          <div>
            <h1 className="text-[20px] font-bold text-white">Alerts</h1>
            <p className="text-[12px] text-[#52525b] mt-1">Get notified when odds hit your target price.</p>
          </div>
          <button
            onClick={() => setShowForm(!showForm)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#00ff7f]/10 border border-[#00ff7f]/20 text-[#00ff7f] text-[11px] font-bold hover:bg-[#00ff7f]/15 transition-colors"
          >
            <Plus className="h-3.5 w-3.5" /> New Alert
          </button>
        </div>

        {/* Notification permission banner */}
        {notifPermission !== "granted" && (
          <div className="rounded-xl border border-[#f59e0b]/20 bg-[#f59e0b]/[0.04] p-4 mb-5 flex items-center gap-3">
            <BellOff className="h-4 w-4 text-[#f59e0b] shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-semibold text-white">Browser notifications are off</p>
              <p className="text-[10px] text-[#71717a] mt-0.5">Enable them to get alerted even when the tab is in the background.</p>
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

        {/* New alert form */}
        {showForm && (
          <div className="rounded-xl border border-[#1e1e24] bg-[#0c0c0e] p-4 mb-5">
            <div className="flex items-center justify-between mb-4">
              <p className="text-[12px] font-bold text-white">New price alert</p>
              <button onClick={() => setShowForm(false)} className="text-[#3f3f46] hover:text-[#71717a]">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="text-[9px] text-[#52525b] uppercase tracking-wider block mb-1">Matchup</label>
                <input
                  value={form.matchup}
                  onChange={(e) => setForm({ ...form, matchup: e.target.value })}
                  placeholder="e.g. Lakers @ Celtics"
                  className="w-full bg-[#111113] border border-[#1e1e24] rounded-lg px-3 py-2 text-[11px] text-white placeholder:text-[#3f3f46] outline-none focus:border-[#2a2a35]"
                />
              </div>
              <div>
                <label className="text-[9px] text-[#52525b] uppercase tracking-wider block mb-1">Team / Side</label>
                <input
                  value={form.team}
                  onChange={(e) => setForm({ ...form, team: e.target.value })}
                  placeholder="e.g. LA Lakers"
                  className="w-full bg-[#111113] border border-[#1e1e24] rounded-lg px-3 py-2 text-[11px] text-white placeholder:text-[#3f3f46] outline-none focus:border-[#2a2a35]"
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3 mb-4">
              <div>
                <label className="text-[9px] text-[#52525b] uppercase tracking-wider block mb-1">Market</label>
                <select
                  value={form.market}
                  onChange={(e) => setForm({ ...form, market: e.target.value as any })}
                  className="w-full bg-[#111113] border border-[#1e1e24] rounded-lg px-3 py-2 text-[11px] text-white outline-none"
                >
                  <option value="ml">Moneyline</option>
                  <option value="spread">Spread</option>
                  <option value="total">Total</option>
                </select>
              </div>
              <div>
                <label className="text-[9px] text-[#52525b] uppercase tracking-wider block mb-1">Condition</label>
                <select
                  value={form.condition}
                  onChange={(e) => setForm({ ...form, condition: e.target.value as any })}
                  className="w-full bg-[#111113] border border-[#1e1e24] rounded-lg px-3 py-2 text-[11px] text-white outline-none"
                >
                  <option value="drops_below">Drops below</option>
                  <option value="rises_above">Rises above</option>
                </select>
              </div>
              <div>
                <label className="text-[9px] text-[#52525b] uppercase tracking-wider block mb-1">Target odds</label>
                <input
                  type="number"
                  value={form.threshold}
                  onChange={(e) => setForm({ ...form, threshold: Number(e.target.value) })}
                  className="w-full bg-[#111113] border border-[#1e1e24] rounded-lg px-3 py-2 text-[11px] font-mono text-white outline-none focus:border-[#2a2a35]"
                />
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleCreate}
                disabled={!form.matchup.trim() || !form.team.trim()}
                className="flex-1 py-2 rounded-lg bg-[#00ff7f]/10 border border-[#00ff7f]/20 text-[#00ff7f] text-[11px] font-bold hover:bg-[#00ff7f]/15 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Create Alert
              </button>
              <button onClick={() => setShowForm(false)} className="px-4 py-2 rounded-lg border border-[#1e1e24] text-[#52525b] text-[11px] hover:text-[#a1a1aa] transition-colors">
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Triggered */}
        {triggered.length > 0 && (
          <div className="mb-5">
            <p className="text-[10px] text-[#4ade80] font-semibold uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <CheckCircle2 className="h-3 w-3" /> Triggered ({triggered.length})
            </p>
            <div className="space-y-2">
              {triggered.map((a) => (
                <AlertCard key={a.id} alert={a}
                  onDelete={() => { deleteAlert(a.id); refresh(); }}
                  onDismiss={() => { dismissAlert(a.id); refresh(); }}
                />
              ))}
            </div>
          </div>
        )}

        {/* Active */}
        <div className="mb-5">
          <p className="text-[10px] text-[#52525b] font-semibold uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Bell className="h-3 w-3" /> Watching ({active.length})
          </p>
          {active.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[#1e1e24] py-10 text-center">
              <Bell className="h-5 w-5 text-[#27272a] mx-auto mb-2" />
              <p className="text-[12px] text-[#52525b] font-medium">No active alerts</p>
              <p className="text-[10px] text-[#3f3f46] mt-1">Hit "New Alert" to watch a price.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {active.map((a) => (
                <AlertCard key={a.id} alert={a}
                  onDelete={() => { deleteAlert(a.id); refresh(); }}
                  onDismiss={() => { dismissAlert(a.id); refresh(); }}
                />
              ))}
            </div>
          )}
        </div>

        {/* Dismissed (collapsed) */}
        {dismissed.length > 0 && (
          <p className="text-[10px] text-[#27272a] text-center">{dismissed.length} dismissed alert{dismissed.length > 1 ? "s" : ""} hidden</p>
        )}
      </div>
    </div>
  );
}
