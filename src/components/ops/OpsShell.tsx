"use client";

import type { ReactNode } from "react";
import type { OpsSportKey } from "@/components/ops/config/sports";
import OpsTabBar from "@/components/ops/OpsTabBar";

interface OpsShellProps {
  activeSport: OpsSportKey;
  onSportChange: (sport: OpsSportKey) => void;
  children: ReactNode;
}

export default function OpsShell({ activeSport, onSportChange, children }: OpsShellProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#0a0b0a]">
      <OpsTabBar activeSport={activeSport} onChange={onSportChange} />
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
