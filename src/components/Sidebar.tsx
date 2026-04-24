"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { LayoutGrid, Sparkles, Bell, Settings, Crown } from "lucide-react";

const NAV = [
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

export default function Sidebar() {
  const pathname = usePathname();

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
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = pathname === href;
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

      {/* ACE Pro upgrade */}
      <div className="hidden lg:block px-3 pb-3 shrink-0">
        <div className="rounded-xl border border-[#3ee68a]/10 bg-[#3ee68a]/[0.03] p-3">
          <div className="flex items-center gap-1.5 mb-1.5">
            <Crown className="h-3 w-3 text-[#3ee68a]" />
            <span className="text-[10px] font-bold text-[#3ee68a] uppercase tracking-wider">ACE Pro</span>
          </div>
          <p className="text-[10px] text-[#6b7068] leading-relaxed mb-2.5">
            Unlimited tracked games, props, and SMS alerts.
          </p>
          <button className="w-full py-1.5 rounded-md bg-[#3ee68a]/10 border border-[#3ee68a]/20 text-[10px] font-bold text-[#3ee68a] hover:bg-[#3ee68a]/15 transition-colors">
            Upgrade — $19/mo
          </button>
        </div>
      </div>

      {/* Account card */}
      <div className="px-2 lg:px-3 py-3 border-t border-[#22251f] shrink-0">
        <Link
          href="/dashboard/settings"
          className="flex items-center gap-2.5 px-2 lg:px-3 py-2 rounded-lg border border-[#22251f] hover:border-[#2e332a] bg-[#121412] hover:bg-[#161a16] transition-all"
        >
          <div className="h-7 w-7 rounded-full bg-[#1a2e22] flex items-center justify-center text-[10px] font-bold text-[#3ee68a] shrink-0 select-none">
            SP
          </div>
          <div className="hidden lg:block min-w-0 flex-1">
            <p className="text-[11px] font-semibold text-white leading-tight">Sprizzy</p>
            <p className="text-[9px] font-mono text-[#6b7068] leading-tight mt-px">Free · ACE Beta</p>
          </div>
          <Settings className="hidden lg:block h-3 w-3 text-[#6b7068] shrink-0" />
        </Link>
        {/* Live indicator (icon-only when collapsed) */}
        <div className="flex lg:hidden justify-center mt-2">
          <span className="h-1.5 w-1.5 rounded-full bg-[#3ee68a] animate-pulse" />
        </div>
      </div>
    </aside>
  );
}
