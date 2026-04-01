"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutGrid,
  Sparkles,
  Star,
  Layers,
  Bell,
  Settings,
  Crown,
  Zap,
} from "lucide-react";

const NAV = [
  { href: "/dashboard", label: "Board", icon: LayoutGrid },
  { href: "/dashboard/tracked", label: "Tracked", icon: Sparkles },
  { href: "/dashboard/watchlist", label: "Watchlist", icon: Star },
  { href: "/dashboard/parlay", label: "Builder", icon: Layers },
  { href: "/dashboard/alerts", label: "Alerts", icon: Bell },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex flex-col w-[56px] lg:w-[200px] shrink-0 h-screen border-r border-[#141417] bg-[#08080a]">
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-3 lg:px-4 h-14 border-b border-[#141417]">
        <img src="/favicon.png" alt="ACE" className="h-7 w-7 shrink-0" />
        <div className="hidden lg:flex items-center gap-2">
          <span className="text-[15px] font-extrabold tracking-[0.25em] text-white">ACE</span>
          <span className="text-[8px] font-bold text-[#00ff7f] border border-[#00ff7f]/20 bg-[#00ff7f]/8 rounded px-1 py-[1px] tracking-widest uppercase">Beta</span>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex flex-col gap-px px-2 py-3 flex-1">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-2.5 px-2 lg:px-3 py-2 rounded-lg text-[12px] font-medium transition-all",
                active
                  ? "bg-[#00ff7f]/8 text-[#00ff7f]"
                  : "text-[#52525b] hover:text-[#a1a1aa] hover:bg-white/[0.03]"
              )}
            >
              <Icon className={cn("h-[15px] w-[15px] shrink-0", active && "drop-shadow-[0_0_4px_rgba(0,255,127,0.3)]")} />
              <span className="hidden lg:block">{label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Upgrade nudge */}
      <div className="hidden lg:block px-3 pb-3">
        <div className="rounded-xl border border-[#00ff7f]/10 bg-[#00ff7f]/[0.03] p-3">
          <div className="flex items-center gap-1.5 mb-1.5">
            <Crown className="h-3 w-3 text-[#00ff7f]" />
            <span className="text-[10px] font-bold text-[#00ff7f] uppercase tracking-wider">Pro</span>
          </div>
          <p className="text-[10px] text-[#52525b] leading-relaxed mb-2">
            Unlock AI picks, real-time alerts, and advanced routing.
          </p>
          <button className="w-full py-1.5 rounded-md bg-[#00ff7f]/10 border border-[#00ff7f]/20 text-[10px] font-bold text-[#00ff7f] hover:bg-[#00ff7f]/15 transition-colors">
            Upgrade
          </button>
        </div>
      </div>

      {/* Bottom */}
      <div className="px-2 lg:px-3 py-3 border-t border-[#141417]">
        <Link
          href="/dashboard/settings"
          className="flex items-center gap-2.5 px-2 lg:px-3 py-2 rounded-lg text-[12px] font-medium text-[#3f3f46] hover:text-[#71717a] hover:bg-white/[0.03] transition-all"
        >
          <Settings className="h-[15px] w-[15px] shrink-0" />
          <span className="hidden lg:block">Settings</span>
        </Link>
        <div className="hidden lg:flex items-center gap-2 px-3 mt-2 text-[10px] text-[#3f3f46]">
          <span className="h-1.5 w-1.5 rounded-full bg-[#00ff7f] animate-pulse shrink-0" />
          <span>Live · 40+ books</span>
        </div>
        <div className="flex lg:hidden justify-center mt-2">
          <span className="h-1.5 w-1.5 rounded-full bg-[#00ff7f] animate-pulse" />
        </div>
      </div>
    </aside>
  );
}
