"use client";

import { Clock, Database, Target } from "lucide-react";
import PlaceholderOpsTab from "@/components/ops/PlaceholderOpsTab";

export default function SoccerOpsTab() {
  return (
    <PlaceholderOpsTab
      sport="Soccer"
      status="planned"
      title="Soccer Ops will get its own market model"
      description="Soccer should not inherit NBA spread assumptions. This tab reserves the space while we design sport-native markets and grading."
      items={[
        { icon: Target, label: "Markets", text: "1X2, draw-no-bet, totals, BTTS, and Asian handicap candidates." },
        { icon: Clock, label: "Timing", text: "Lineup confirmation windows and late scratches matter more here." },
        { icon: Database, label: "Schema", text: "Use soccer-specific event metadata instead of cover-prob fields." },
      ]}
    />
  );
}
