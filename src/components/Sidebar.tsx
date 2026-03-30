"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { LayoutDashboard, TrendingUp, Star, Calculator, Settings } from "lucide-react";

const NAV = [
  { href: "/dashboard", label: "Games", icon: LayoutDashboard },
  { href: "/dashboard/picks", label: "AI Picks", icon: TrendingUp },
  { href: "/dashboard/watchlist", label: "Watchlist", icon: Star },
  { href: "/dashboard/parlay", label: "Parlay Builder", icon: Calculator },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden lg:flex flex-col w-56 min-h-screen bg-ace-card border-r border-ace-border px-3 py-6">
      <div className="flex items-center gap-2 px-3 mb-8">
        <span className="text-xl font-bold text-ace-gold tracking-wide">ACE</span>
        <span className="text-xs bg-ace-gold/20 text-ace-gold px-2 py-0.5 rounded-full font-medium">BETA</span>
      </div>

      <nav className="flex flex-col gap-1">
        {NAV.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
              pathname === href
                ? "bg-ace-gold/15 text-ace-gold"
                : "text-ace-muted hover:text-white hover:bg-ace-border"
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {label}
          </Link>
        ))}
      </nav>

      <div className="mt-auto px-3">
        <div className="flex items-center gap-2 text-xs text-ace-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-ace-green animate-pulse" />
          Live data
        </div>
      </div>
    </aside>
  );
}
