"use client";

import { Database, Hammer, CloudSun } from "lucide-react";
import PlaceholderOpsTab from "@/components/ops/PlaceholderOpsTab";

export default function MLBOpsTab() {
  return (
    <PlaceholderOpsTab
      sport="MLB"
      status="next up"
      title="MLB Ops is staged, not wired yet"
      description="This tab is intentionally a placeholder so the live NBA/XGBoost flow stays untouched while we prepare MLB-specific ops contracts."
      items={[
        { icon: Database, label: "Data shape", text: "Separate MLB signal payloads from the current NBA spread schema." },
        { icon: Hammer, label: "Markets", text: "Support moneyline, run line, totals, and F5/full-game splits." },
        { icon: CloudSun, label: "Context", text: "Pitcher, bullpen, park, and weather modules belong here." },
      ]}
    />
  );
}
