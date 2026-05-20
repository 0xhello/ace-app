"use client";

/**
 * Shared ops UI primitives.
 *
 * Every per-sport tab was built at a different point in this project's
 * lifecycle and ended up with slightly different visual language (card
 * styles, colors, button shapes, section header patterns). That made the
 * dashboard hard to scan side-to-side as an operator — your eyes had to
 * recalibrate per tab. These primitives are the shared visual vocabulary
 * so a worker-status block looks the same whether you're on MLB or Soccer.
 *
 * Conventions:
 *   - Background: bg-[#0d0f0d] on top of #0a0b0a page
 *   - Borders: border-[#22251f] for cards, border-[#1a1e1a] for nested
 *   - Accent green: #3ee68a (section heads, healthy worker, win, edge)
 *   - Amber: #f5c062 (warn, tier B, NBA accent)
 *   - Red: #ef4444 (errors, lost picks)
 *   - Muted text: #6b7068 (labels) / #9ca39a (secondary value) / #c4c7c0 (body)
 *
 * Sport accents (kept in OverviewOpsTab.SPORT_ACCENT for now; can move here
 * if/when we need them in more than one place).
 */
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// ── KPI card — single number with label and optional subtitle ────────────────

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
    <div className={cn(
      "rounded-lg border border-[#22251f] bg-[#0d0f0d] px-4 py-3",
      className,
    )}>
      <p className="text-[9px] text-[#6b7068] uppercase tracking-[0.15em] mb-1.5">{label}</p>
      <p
        className="text-[20px] font-bold font-mono tabular-nums leading-none"
        style={{ color: color ?? "#ffffff" }}
      >
        {value}
      </p>
      {sub && <p className="text-[10px] text-[#6b7068] mt-1.5 leading-tight">{sub}</p>}
    </div>
  );
}

// ── Section header — icon + accent-green title, optional right-aligned slot ──

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
    <div className={cn("flex items-center justify-between mb-3", className)}>
      <p className="text-[10px] font-bold text-[#3ee68a] uppercase tracking-[0.15em] flex items-center gap-1.5">
        <Icon className="h-3 w-3" />
        {title}
      </p>
      {right}
    </div>
  );
}

// ── Section panel — wraps SectionHead + children with consistent borders ─────

export function Panel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn(
      "rounded-lg border border-[#22251f] bg-[#0d0f0d] p-5",
      className,
    )}>
      {children}
    </div>
  );
}

// ── Action button — Scan/Grade/Refresh share one consistent style ────────────

type ActionButtonVariant = "primary" | "ghost";

export function ActionButton({
  icon: Icon,
  label,
  busy,
  disabled,
  variant = "ghost",
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  busy?: boolean;
  disabled?: boolean;
  variant?: ActionButtonVariant;
  onClick: () => void;
}) {
  const isPrimary = variant === "primary";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex items-center gap-1.5 text-[10px] uppercase tracking-[0.15em] font-bold",
        "px-3 py-2 rounded-lg transition-colors",
        isPrimary && "border border-[#3ee68a]/20 bg-[#3ee68a]/[0.05] text-[#3ee68a] hover:bg-[#3ee68a]/10 hover:border-[#3ee68a]/40",
        !isPrimary && "border border-[#22251f] bg-[#0d0f0d] text-[#9ca39a] hover:text-white hover:border-[#3ee68a]/30",
        disabled && "opacity-50 cursor-not-allowed",
      )}
    >
      <Icon className={cn("h-3 w-3", busy && (label.toLowerCase().includes("refresh") ? "animate-spin" : "animate-pulse"))} />
      {label}
    </button>
  );
}

// ── Worker / job health strip — three cards: worker, fetch job, grade job ────

export interface JobHealth {
  lastRunAt: string | null;
  lastError: string | null;
}

export function JobHealthStrip({
  worker,
  fetch,
  grade,
}: {
  worker: { lastPollAt: string | null; lastPollOk: boolean | null };
  fetch: JobHealth;
  grade: JobHealth;
}) {
  const workerLabel =
    worker.lastPollOk === null ? "—" : worker.lastPollOk ? "OK" : "Error";
  const workerColor =
    worker.lastPollOk === false ? "#ef4444" : worker.lastPollOk ? "#3ee68a" : "#9ca39a";

  return (
    <div className="grid grid-cols-3 gap-3">
      <KpiCard
        label="Worker"
        value={workerLabel}
        sub={worker.lastPollAt ?? "no polls yet"}
        color={workerColor}
      />
      <KpiCard
        label="Fetch job"
        value={fetch.lastRunAt ? "ran" : "—"}
        sub={fetch.lastError || fetch.lastRunAt || "no runs yet"}
        color={fetch.lastError ? "#ef4444" : "#ffffff"}
      />
      <KpiCard
        label="Grade job"
        value={grade.lastRunAt ? "ran" : "—"}
        sub={grade.lastError || grade.lastRunAt || "no runs yet"}
        color={grade.lastError ? "#ef4444" : "#ffffff"}
      />
    </div>
  );
}

// ── Page header — sport badge + title + actions slot ─────────────────────────

export function OpsPageHeader({
  badge,
  badgeColor = "#3ee68a",
  title,
  actions,
}: {
  badge: string;
  badgeColor?: string;
  title: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 flex-wrap">
      <div>
        <p
          className="text-[10px] font-bold uppercase tracking-[0.18em] mb-1"
          style={{ color: badgeColor }}
        >
          {badge}
        </p>
        <h1 className="text-[20px] font-bold text-white">{title}</h1>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

// ── Status pill for tier / state badges ──────────────────────────────────────

export function StatusPill({ label, tone }: { label: string; tone: "win" | "loss" | "open" | "void" | "a" | "b" | "c" }) {
  const toneClasses: Record<typeof tone, string> = {
    win:  "bg-[#3ee68a]/20 text-[#3ee68a]",
    loss: "bg-[#ef4444]/20 text-[#ef4444]",
    open: "bg-[#6b7068]/15 text-[#9ca39a]",
    void: "bg-[#6b7068]/15 text-[#6b7068]",
    a:    "bg-[#3ee68a]/20 text-[#3ee68a]",
    b:    "bg-[#f5c062]/15 text-[#f5c062]",
    c:    "bg-[#6b7068]/15 text-[#6b7068]",
  };
  return (
    <span className={cn(
      "inline-block px-1.5 py-[1px] rounded text-[8px] font-bold uppercase tracking-[0.1em]",
      toneClasses[tone],
    )}>{label}</span>
  );
}

// ── Footer strip — refreshed timestamp + optional schema state ───────────────

export function OpsFooter({
  refreshedAt,
  schemaText,
}: {
  refreshedAt: string;
  schemaText?: string;
}) {
  return (
    <div className="flex items-center justify-between text-[9px] text-[#6b7068] uppercase tracking-[0.12em]">
      {schemaText
        ? <span>{schemaText}</span>
        : <span />}
      <span>refreshed · {new Date(refreshedAt).toLocaleTimeString()}</span>
    </div>
  );
}
