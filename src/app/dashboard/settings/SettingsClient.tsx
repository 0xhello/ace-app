"use client";

import { signOut } from "next-auth/react";
import { LogOut, Shield, User } from "lucide-react";

interface Props {
  email: string;
  role: string;
}

export default function SettingsClient({ email, role }: Props) {
  const initials = email ? email.slice(0, 2).toUpperCase() : "—";

  return (
    <div className="flex-1 overflow-y-auto bg-[#0a0b0a]">
      <div className="max-w-lg mx-auto px-6 py-10">

        {/* Header */}
        <div className="mb-8">
          <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-[#3a4033] mb-1">Account</p>
          <h1 className="text-[22px] font-bold text-white tracking-tight">Settings</h1>
        </div>

        {/* Profile card */}
        <div className="rounded-xl border border-[#1e2220] bg-[#0d0f0d] p-5 mb-4">
          <div className="flex items-center gap-4">
            <div className="h-12 w-12 rounded-full bg-[#1a2e22] flex items-center justify-center text-[14px] font-bold text-[#3ee68a] shrink-0 select-none">
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-white truncate">{email}</p>
              <div className="flex items-center gap-1.5 mt-0.5">
                {role === "admin"
                  ? <Shield className="h-3 w-3 text-[#3ee68a]" />
                  : <User className="h-3 w-3 text-[#6b7068]" />
                }
                <p className="text-[10px] font-mono text-[#6b7068] capitalize">{role} · ACE Beta</p>
              </div>
            </div>
          </div>
        </div>

        {/* Info rows */}
        <div className="rounded-xl border border-[#1e2220] bg-[#0d0f0d] divide-y divide-[#1a1e1a] mb-6">
          <div className="flex items-center justify-between px-5 py-3.5">
            <p className="text-[11px] text-[#6b7068]">Email</p>
            <p className="text-[11px] font-mono text-white">{email}</p>
          </div>
          <div className="flex items-center justify-between px-5 py-3.5">
            <p className="text-[11px] text-[#6b7068]">Role</p>
            <span className="text-[9px] font-bold uppercase tracking-widest border rounded px-1.5 py-0.5"
              style={{ color: role === "admin" ? "#3ee68a" : "#6b7068", borderColor: role === "admin" ? "#3ee68a35" : "#2a2a2a" }}>
              {role}
            </span>
          </div>
          <div className="flex items-center justify-between px-5 py-3.5">
            <p className="text-[11px] text-[#6b7068]">Access</p>
            <p className="text-[11px] text-[#6b7068]">Beta</p>
          </div>
        </div>

        {/* Coming soon */}
        <div className="rounded-xl border border-[#1e2220] bg-[#0d0f0d] px-5 py-4 mb-6">
          <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-[#3a4033] mb-1">Change password</p>
          <p className="text-[11px] text-[#3a4033]">Coming soon</p>
        </div>

        {/* Sign out */}
        <button
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="flex items-center gap-2 w-full rounded-xl border border-[#2a1a1a] bg-[#180d0d] px-5 py-3.5 text-[12px] font-semibold text-[#ef4444] hover:bg-[#1f1010] hover:border-[#3a1a1a] transition-colors"
        >
          <LogOut className="h-3.5 w-3.5" />
          Sign out
        </button>

      </div>
    </div>
  );
}
