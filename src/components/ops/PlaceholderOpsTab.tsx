"use client";

import type { LucideIcon } from "lucide-react";
import { Activity } from "lucide-react";

interface PlaceholderItem {
  icon: LucideIcon;
  label: string;
  text: string;
}

interface PlaceholderOpsTabProps {
  sport: string;
  status: string;
  title: string;
  description: string;
  items: PlaceholderItem[];
}

export default function PlaceholderOpsTab({ sport, status, title, description, items }: PlaceholderOpsTabProps) {
  return (
    <div className="flex-1 overflow-y-auto bg-[#0a0b0a]">
      <div className="mx-auto max-w-[1200px] px-6 py-7">
        <div className="rounded-2xl border border-[#181c18] bg-[#0d0f0d] p-6 shadow-[0_18px_60px_rgba(0,0,0,0.28)]">
          <div className="mb-6 flex items-center justify-between gap-4">
            <div>
              <div className="mb-2 flex items-center gap-2">
                <Activity className="h-4 w-4 text-[#3ee68a]" />
                <span className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#3ee68a]">{sport} Ops</span>
                <span className="rounded border border-[#2e332a] px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-[0.12em] text-[#6b7068]">{status}</span>
              </div>
              <h2 className="text-[20px] font-bold tracking-tight text-white">{title}</h2>
              <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-[#6b7068]">{description}</p>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            {items.map(({ icon: Icon, label, text }) => (
              <div key={label} className="rounded-xl border border-[#1a1e1a] bg-[#101310] p-4">
                <div className="mb-3 flex items-center gap-2">
                  <Icon className="h-4 w-4 text-[#3ee68a]" />
                  <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#9ca39a]">{label}</span>
                </div>
                <p className="text-[12px] leading-relaxed text-[#5e665d]">{text}</p>
              </div>
            ))}
          </div>

          <div className="mt-5 rounded-xl border border-[#3ee68a]/10 bg-[#3ee68a]/5 px-4 py-3 text-[12px] leading-relaxed text-[#8af3ae]">
            NBA remains wired to the existing model/API/database flow. This placeholder does not call any backend route.
          </div>
        </div>
      </div>
    </div>
  );
}
