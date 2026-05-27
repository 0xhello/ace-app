"use client";

/**
 * Shared ops UI primitives — the visual vocabulary every tab uses.
 *
 * The dashboard's tabs (Overview / NBA / MLB / Soccer / NFL / Users) were
 * each built at different points and ended up with subtly different card
 * styles, status patterns, button shapes, and color tokens. Operators had
 * to recalibrate their eyes per tab — that's exactly the friction this
 * module is here to remove.
 *
 * The visual language was picked from the Soccer tab (the most polished),
 * generalized, and reused everywhere. After this lands, every tab should
 * look like the same product.
 *
 * Conventions:
 *   Backgrounds  bg-[#0a0b0a] (page)   bg-[#0d0f0d] (card)   bg-[#101310] (nested)
 *   Borders      border-[#181c18] / border-[#1e2220] (card)   border-[#1a1e1a] (inner)
 *   Accent green #3ee68a   amber #f5c062   red #ef4444
 *   Text         #ffffff (heading/value)   #c4c7c0 (body)   #9ca39a (secondary)
 *                #6b7068 (muted label)   #4a524a (faint)   #3a4033 (placeholder)
 */
import type { LucideIcon } from "lucide-react";
import { useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw, Settings } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Sport accents (centralized so every tab agrees) ──────────────────────────

export const SPORT_ACCENT: Record<string, string> = {
  overview: "#3ee68a",  // green
  nba:      "#f5c062",  // amber
  wc:       "#3ee68a",  // green
  soccer:   "#3ee68a",
  mlb:      "#7ab8ff",  // soft blue
  nfl:      "#c084fc",  // soft violet (planned)
  users:    "#9ca39a",  // neutral
};

// ── Tag — small pill for status/category labels ──────────────────────────────

export function Tag({ label, color = "#6b7068" }: { label: string; color?: string }) {
  return (
    <span
      className="text-[8px] font-bold uppercase tracking-widest border rounded px-1.5 py-0.5"
      style={{ color, borderColor: `${color}35` }}
    >
      {label}
    </span>
  );
}

// ── Dot — animated colored circle for status strips ──────────────────────────

export function Dot({ color, pulse = false }: { color: string; pulse?: boolean }) {
  return (
    <span className="relative flex h-2.5 w-2.5 shrink-0">
      {pulse && (
        <span
          className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-40"
          style={{ background: color }}
        />
      )}
      <span
        className="relative inline-flex rounded-full h-2.5 w-2.5"
        style={{ background: color }}
      />
    </span>
  );
}

// ── KpiCard — big-number card, the dominant info primitive ───────────────────

export function KpiCard({
  label,
  value,
  sub,
  color,
  className,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex-1 min-w-0 rounded-xl border border-[#1e2220] bg-[#0f110f] px-4 py-4",
        className,
      )}
    >
      <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-[#3a4033] mb-2.5">
        {label}
      </p>
      <p
        className="text-[26px] font-black font-mono leading-none tabular-nums"
        style={{ color: color ?? "#d4d7d0" }}
      >
        {value}
      </p>
      {sub && (
        <p className="text-[10px] text-[#4a524a] mt-1.5 leading-tight">{sub}</p>
      )}
    </div>
  );
}

// ── SectionHead — icon + accent-green title, optional right-aligned slot ─────

export function SectionHead({
  icon: Icon,
  title,
  right,
  className,
}: {
  icon: LucideIcon;
  title: string;
  right?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between mb-4", className)}>
      <div className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 text-[#3ee68a]" />
        <p className="text-[11px] font-bold text-[#3ee68a] uppercase tracking-[0.2em]">
          {title}
        </p>
      </div>
      {right}
    </div>
  );
}

// ── Panel — bordered card wrapper, the section container ─────────────────────

export function Panel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-[#181c18] bg-[#0d0f0d] p-5",
        className,
      )}
    >
      {children}
    </div>
  );
}

// ── ActionButton — Scan / Grade / Refresh in two consistent variants ─────────

type ActionButtonVariant = "primary" | "ghost" | "subtle";

export function ActionButton({
  icon: Icon,
  label,
  busy,
  disabled,
  variant = "ghost",
  onClick,
}: {
  icon: LucideIcon;
  label?: string;
  busy?: boolean;
  disabled?: boolean;
  variant?: ActionButtonVariant;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex items-center gap-1.5 rounded-lg transition-colors disabled:opacity-40",
        "text-[10px] uppercase tracking-[0.15em] font-bold px-2.5 py-1.5",
        variant === "primary" &&
          "border border-[#3ee68a]/20 bg-[#3ee68a]/5 text-[#3ee68a] hover:bg-[#3ee68a]/10",
        variant === "ghost" &&
          "border border-[#1e2220] text-[#6b7068] hover:text-[#9ca39a] hover:border-[#2e332a]",
        variant === "subtle" &&
          "text-[#4a524a] hover:text-[#9ca39a]",
      )}
    >
      <Icon
        className={cn(
          "h-3 w-3",
          busy &&
            (Icon === RefreshCw ? "animate-spin" : "animate-pulse"),
        )}
      />
      {label}
    </button>
  );
}

// ── WorkerStatusStrip — horizontal dot+label+timeago row ─────────────────────
// The compact, glance-able health indicator (Soccer pattern). Replaces the
// 3-stacked-card JobHealthStrip we previously had on MLB/Overview.

export interface JobMeta {
  lastRunAt: string | null;
  lastError: string | null;
}

export interface WorkerMeta {
  lastPollAt: string | null;
  lastPollOk: boolean | null;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso.replace(" ", "T")).getTime();
  if (Number.isNaN(ms)) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function WorkerStatusStrip({
  worker,
  fetch,
  grade,
  extra,
}: {
  worker?: WorkerMeta;
  fetch?: JobMeta;
  grade?: JobMeta;
  extra?: React.ReactNode;
}) {
  const workerColor =
    !worker || worker.lastPollOk === false
      ? "#ef4444"
      : worker.lastPollAt
      ? "#3ee68a"
      : "#3a4033";

  const jobColor = (m?: JobMeta): string => {
    if (!m) return "#3a4033";
    if (m.lastError) return "#ef4444";
    if (!m.lastRunAt) return "#3a4033";
    return "#3ee68a";
  };

  const errors: string[] = [];
  if (fetch?.lastError) errors.push("scan");
  if (grade?.lastError) errors.push("grade");

  return (
    <div className="flex items-center gap-4 rounded-xl border border-[#181c18] bg-[#0d0f0d] px-4 py-3 flex-wrap gap-y-2">
      {worker && (
        <div className="flex items-center gap-1.5">
          <Dot color={workerColor} pulse={workerColor === "#3ee68a"} />
          <span className="text-[10px] text-[#6b7068]">Worker</span>
          <span className="text-[10px] font-mono text-[#4a524a]">
            {timeAgo(worker.lastPollAt)}
          </span>
        </div>
      )}
      {fetch && (
        <>
          <div className="h-3 w-px bg-[#1e2220]" />
          <div className="flex items-center gap-1.5">
            <Dot color={jobColor(fetch)} />
            <span className="text-[10px] text-[#6b7068]">Scan</span>
            <span className="text-[10px] font-mono text-[#4a524a]">
              {timeAgo(fetch.lastRunAt)}
            </span>
          </div>
        </>
      )}
      {grade && (
        <>
          <div className="h-3 w-px bg-[#1e2220]" />
          <div className="flex items-center gap-1.5">
            <Dot color={jobColor(grade)} />
            <span className="text-[10px] text-[#6b7068]">Grade</span>
            <span className="text-[10px] font-mono text-[#4a524a]">
              {timeAgo(grade.lastRunAt)}
            </span>
          </div>
        </>
      )}
      {extra && (
        <>
          <div className="h-3 w-px bg-[#1e2220]" />
          {extra}
        </>
      )}
      {errors.length > 0 && (
        <>
          <div className="h-3 w-px bg-[#1e2220]" />
          <div className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-[#ef4444] animate-pulse" />
            <span className="text-[9px] font-bold text-[#ef4444]">
              {errors.length} error{errors.length !== 1 ? "s" : ""}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

// ── OpsPageHeader — sport icon + title + optional tag + actions slot ─────────

export function OpsPageHeader({
  icon: Icon,
  title,
  tag,
  tagColor,
  actions,
}: {
  icon: LucideIcon;
  title: string;
  tag?: string;
  tagColor?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between flex-wrap gap-3">
      <div className="flex items-center gap-3">
        <Icon className="h-4 w-4 text-[#3ee68a]" />
        <h1 className="text-[18px] font-bold text-white tracking-tight">{title}</h1>
        {tag && <Tag label={tag} color={tagColor ?? "#6b7068"} />}
      </div>
      {actions && <div className="flex items-center gap-3">{actions}</div>}
    </div>
  );
}

// ── StatusPill — small win/loss/open/tier badge ──────────────────────────────

type PillTone = "win" | "loss" | "open" | "void" | "a" | "b" | "c";

export function StatusPill({ label, tone }: { label: string; tone: PillTone }) {
  const cls: Record<PillTone, string> = {
    win:  "bg-[#3ee68a]/20 text-[#3ee68a]",
    loss: "bg-[#ef4444]/20 text-[#ef4444]",
    open: "bg-[#f5c062]/15 text-[#f5c062]",
    void: "bg-[#6b7068]/15 text-[#6b7068]",
    a:    "bg-[#3ee68a]/20 text-[#3ee68a]",
    b:    "bg-[#f5c062]/15 text-[#f5c062]",
    c:    "bg-[#6b7068]/15 text-[#6b7068]",
  };
  return (
    <span
      className={cn(
        "inline-block px-1.5 py-[1px] rounded text-[8px] font-bold uppercase tracking-[0.12em]",
        cls[tone],
      )}
    >
      {label}
    </span>
  );
}

// ── OpsFooter — refreshed timestamp + optional schema/state string ───────────

export function OpsFooter({
  refreshedAt,
  schemaText,
}: {
  refreshedAt: string;
  schemaText?: string;
}) {
  return (
    <div className="flex items-center justify-between text-[9px] text-[#6b7068] uppercase tracking-[0.12em]">
      {schemaText ? <span>{schemaText}</span> : <span />}
      <span>refreshed · {new Date(refreshedAt).toLocaleTimeString()}</span>
    </div>
  );
}

// ── ErrorBanner — red-tinted alert panel for surfaced job errors ─────────────

export function ErrorBanner({ messages }: { messages: string[] }) {
  if (!messages.length) return null;
  return (
    <div className="rounded-xl border border-[#ef4444]/20 bg-[#ef4444]/[0.03] px-4 py-3.5 space-y-2">
      {messages.map((m, i) => (
        <div key={i} className="flex items-start gap-2.5">
          <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[#ef4444]" />
          <p className="text-[11px] text-[#c4c7c0]">{m}</p>
        </div>
      ))}
    </div>
  );
}

// ── LoadingState / EmptyState — consistent placeholders ──────────────────────

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex-1 overflow-y-auto bg-[#0a0b0a] flex items-center justify-center">
      <div className="flex items-center gap-2 text-[#4a524a]">
        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
        <span className="text-[12px]">{label}</span>
      </div>
    </div>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] text-[#6b7068] text-center py-6">{children}</p>
  );
}

// ── EngineInternals — collapsible "show me the raw data" container ──────────
//
// Used across NBA / MLB / Soccer ops tabs to hide engine-room data (manual
// job triggers, dense KPI strips, raw signal tables, debug pipelines) from
// the default view. The user opens it only when troubleshooting. Default
// closed so the top of the page stays calm.
//
// Pass a short `subtitle` to give a hint about what's inside, e.g.
// "raw metrics, manual job triggers, candidate queue".

export function EngineInternals({
  children,
  defaultOpen = false,
  subtitle = "raw metrics + manual job triggers",
}: {
  children: React.ReactNode;
  defaultOpen?: boolean;
  subtitle?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border border-[#1a1e1a] bg-[#0a0b0a]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-5 py-3 text-left hover:bg-[#0d100d] rounded-xl transition-colors"
      >
        {open
          ? <ChevronDown className="h-4 w-4 text-[#6b7068]" />
          : <ChevronRight className="h-4 w-4 text-[#6b7068]" />}
        <Settings className="h-3.5 w-3.5 text-[#6b7068]" />
        <span className="text-[12px] font-semibold uppercase tracking-wider text-[#9ca39a]">Engine internals</span>
        <span className="text-[10px] text-[#3a4033] ml-2">{subtitle}</span>
      </button>
      {open && (
        <div className="px-5 pb-5 pt-2 space-y-4 border-t border-[#1a1e1a]">
          {children}
        </div>
      )}
    </div>
  );
}
