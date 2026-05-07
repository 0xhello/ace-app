"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { LayoutGrid, Sparkles, Bell, Terminal, Settings, LogOut } from "lucide-react";
import { signOut } from "next-auth/react";
import Image from "next/image";

interface SidebarProps {
  role?: string;
  email?: string;
}

const BASE_NAV = [
  { href: "/dashboard",          label: "Board",   icon: LayoutGrid },
  { href: "/dashboard/tracked",  label: "Tracked", icon: Sparkles   },
  { href: "/dashboard/alerts",   label: "Alerts",  icon: Bell       },
];

export default function Sidebar({ role, email }: SidebarProps) {
  const pathname = usePathname();

  const nav = [
    ...BASE_NAV,
    ...(role === "admin" ? [{ href: "/dashboard/ops", label: "Ops", icon: Terminal }] : []),
  ];

  const initials = email ? email.slice(0, 2).toUpperCase() : "—";

  return (
    <aside className="flex flex-col w-[56px] lg:w-[208px] shrink-0 h-screen border-r border-[#22251f] bg-[#0a0b0a]">

      {/* Logo */}
      <Link href="/" className="flex items-center gap-2.5 px-3 lg:px-4 h-14 border-b border-[#22251f] shrink-0 hover:opacity-80 transition-opacity">
        <Image src="/ace-logo.png" alt="ACE" width={28} height={28} className="shrink-0" />
      </Link>

      {/* Nav */}
      <nav className="flex flex-col gap-px px-2 py-3 shrink-0">
        {nav.map(({ href, label, icon: Icon }) => {
          const active =
            pathname === href ||
            (href !== "/dashboard" && pathname.startsWith(href));
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
              <Icon
                className={cn(
                  "h-[15px] w-[15px] shrink-0",
                  active && "drop-shadow-[0_0_4px_rgba(0,255,127,0.3)]"
                )}
              />
              <span className="hidden lg:block">{label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Account area */}
      <div className="px-2 lg:px-3 py-3 border-t border-[#22251f] shrink-0 space-y-1">

        {/* Settings link */}
        <Link
          href="/dashboard/settings"
          className={cn(
            "flex items-center gap-2.5 px-2 lg:px-3 py-2 rounded-lg text-[12px] font-medium transition-all",
            pathname.startsWith("/dashboard/settings")
              ? "bg-[#3ee68a]/8 text-[#3ee68a]"
              : "text-[#6b7068] hover:text-[#d4d7d0] hover:bg-white/[0.03]"
          )}
        >
          <Settings className="h-[15px] w-[15px] shrink-0" />
          <span className="hidden lg:block">Settings</span>
        </Link>

        {/* Sign out */}
        <button
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="flex items-center gap-2.5 w-full px-2 lg:px-3 py-2 rounded-lg text-[12px] font-medium text-[#6b7068] hover:text-[#ef4444] hover:bg-[#ef4444]/[0.04] transition-all"
        >
          <LogOut className="h-[15px] w-[15px] shrink-0" />
          <span className="hidden lg:block">Sign out</span>
        </button>

        {/* User chip */}
        <div className="flex items-center gap-2.5 px-2 lg:px-3 py-2 mt-1 rounded-lg border border-[#1a1e1a] bg-[#0f110f]">
          <div className="h-6 w-6 rounded-full bg-[#1a2e22] flex items-center justify-center text-[9px] font-bold text-[#3ee68a] shrink-0 select-none">
            {initials}
          </div>
          <div className="hidden lg:block min-w-0 flex-1">
            <p className="text-[10px] font-medium text-[#9ca39a] leading-tight truncate">{email || "—"}</p>
            <p className="text-[8px] font-mono text-[#3a4033] leading-tight mt-px capitalize">{role ?? "user"} · Beta</p>
          </div>
        </div>

      </div>
    </aside>
  );
}
