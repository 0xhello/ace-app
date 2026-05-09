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
    <div className="flex-1 overflow-y-auto bg-[#0a0b0a]">
      <OpsTabBar activeSport={activeSport} onChange={onSportChange} />
      {children}
    </div>
  );
}
