"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutGrid,
  Sparkles,
  Star,
  Layers,
  Settings,
  Bell,
} from "lucide-react";

const NAV = [
  { href: "/dashboard", label: "Board", icon: LayoutGrid },
  { href: "/dashboard/picks", label: "AI Picks", icon: Sparkles },
  { href: "/dashboard/watchlist", label: "Watchlist", icon: Star },
  { href: "/dashboard/parlay", label: "Parlay", icon: Layers },
  { href: "/dashboard/alerts", label: "Alerts", icon: Bell },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex flex-col w-[60px] lg:w-52 shrink-0 h-screen border-r border-[#1e1e24] bg-[#0d0d10]">
      {/* Logo */}
      <div className="flex items-center gap-3 px-4 h-14 border-b border-[#1e1e24]">
        <img src="/favicon.png" alt="ACE" className="h-7 w-7 shrink-0" />
        <span className="hidden lg:block text-[15px] font-bold tracking-[0.2em] text-white">ACE</span>
        <span className="hidden lg:block text-[10px] font-semibold text-[#00ff7f] border border-[#00ff7f]/20 bg-[#00ff7f]/8 rounded px-1.5 py-0.5 tracking-wider">BETA</span>
      </div>

      {/* Nav */}
      <nav className="flex flex-col gap-0.5 px-2 py-3 flex-1">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-3 px-2 lg:px-3 py-2.5 rounded-lg text-[13px] font-medium transition-all duration-100",
                active
                  ? "bg-[#00ff7f]/10 text-[#00ff7f] border border-[#00ff7f]/15"
                  : "text-[#71717a] hover:text-white hover:bg-white/5 border border-transparent"
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="hidden lg:block">{label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Bottom */}
      <div className="px-4 py-4 border-t border-[#1e1e24]">
        <div className="hidden lg:flex items-center gap-2 text-[11px] text-[#52525b]">
          <span className="h-1.5 w-1.5 rounded-full bg-[#00ff7f] animate-pulse shrink-0" />
          <span>Live · 40+ books</span>
        </div>
        <div className="flex lg:hidden justify-center">
          <span className="h-1.5 w-1.5 rounded-full bg-[#00ff7f] animate-pulse" />
        </div>
      </div>
    </aside>
  );
}
