"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { LayoutGrid, Sparkles, Bell, Settings, Terminal } from "lucide-react";
import { signOut } from "next-auth/react";

interface SidebarProps {
  role?: string;
  email?: string;
}

const BASE_NAV = [
  { href: "/dashboard", label: "Board", icon: LayoutGrid },
  { href: "/dashboard/tracked", label: "Tracked", icon: Sparkles },
  { href: "/dashboard/alerts", label: "Alerts", icon: Bell },
];

const SAVED_FILTERS = [
  "NBA · High impact",
  "Tonight — live edge",
  "Sharp money moves",
  "Divisional NFL",
];

export default function Sidebar({ role, email }: SidebarProps) {
  const pathname = usePathname();

  const nav = [
    ...BASE_NAV,
    ...(role === "admin" ? [{ href: "/dashboard/ops", label: "Ops", icon: Terminal }] : []),
  ];

  const initials = email
    ? email.slice(0, 2).toUpperCase()
    : "—";

  return (
    <aside className="flex flex-col w-[56px] lg:w-[208px] shrink-0 h-screen border-r border-[#22251f] bg-[#0a0b0a]">
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-3 lg:px-4 h-14 border-b border-[#22251f] shrink-0">
        <img src="/favicon.png" alt="ACE" className="h-7 w-7 shrink-0" />
        <div className="hidden lg:flex items-center gap-2">
          <span className="text-[15px] font-extrabold tracking-[0.25em] text-white">ACE</span>
          <span className="text-[8px] font-bold text-[#3ee68a] border border-[#3ee68a]/20 bg-[#3ee68a]/8 rounded px-1 py-[1px] tracking-widest uppercase">Beta</span>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex flex-col gap-px px-2 py-3 shrink-0">
        {nav.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || (href !== "/dashboard" && pathname.startsWith(href));
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-2.5 px-2 lg:px-3 py-2 rounded-lg text-[12px] font-medium transition-all",
                active
                  ? "bg-[#3ee68a]/8 text-[#3ee68a]"
                  : "text-[#6b7068] hover:text-[#d4d7d0] hover:bg-white/[0.03]"
              )}
            >
              <Icon className={cn("h-[15px] w-[15px] shrink-0", active && "drop-shadow-[0_0_4px_rgba(0,255,127,0.3)]")} />
              <span className="hidden lg:block">{label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Saved filters */}
      <div className="hidden lg:block px-2 pb-3 shrink-0">
        <p className="text-[9px] text-[#3a4033] uppercase tracking-[0.12em] font-semibold mb-1 px-3">Saved Filters</p>
        {SAVED_FILTERS.map((label) => (
          <button
            key={label}
            className="flex items-center gap-2 w-full px-3 py-1.5 rounded-lg text-[11px] text-[#6b7068] hover:text-[#9ca39a] hover:bg-white/[0.02] transition-colors text-left"
          >
            <span className="h-[3px] w-[3px] rounded-full bg-[#3a4033] shrink-0" />
            {label}
          </button>
        ))}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Account card */}
      <div className="px-2 lg:px-3 py-3 border-t border-[#22251f] shrink-0">
        <div className="flex items-center gap-2.5 px-2 lg:px-3 py-2 rounded-lg border border-[#22251f] bg-[#121412]">
          <div className="h-7 w-7 rounded-full bg-[#1a2e22] flex items-center justify-center text-[10px] font-bold text-[#3ee68a] shrink-0 select-none">
            {initials}
          </div>
          <div className="hidden lg:block min-w-0 flex-1">
            <p className="text-[11px] font-semibold text-white leading-tight truncate">{email || "—"}</p>
            <p className="text-[9px] font-mono text-[#6b7068] leading-tight mt-px capitalize">{role ?? "user"} · ACE Beta</p>
          </div>
          <button
            onClick={() => signOut({ callbackUrl: "/login" })}
            title="Sign out"
            className="hidden lg:block"
          >
            <Settings className="h-3 w-3 text-[#6b7068] hover:text-[#9ca39a] transition-colors" />
          </button>
        </div>
        {/* Live indicator (icon-only when collapsed) */}
        <div className="flex lg:hidden justify-center mt-2">
          <span className="h-1.5 w-1.5 rounded-full bg-[#3ee68a] animate-pulse" />
        </div>
      </div>
    </aside>
  );
}
