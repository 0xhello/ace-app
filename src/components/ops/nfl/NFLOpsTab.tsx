"use client";

import { AlertTriangle, CloudSun, Database } from "lucide-react";
import PlaceholderOpsTab from "@/components/ops/PlaceholderOpsTab";

export default function NFLOpsTab() {
  return (
    <PlaceholderOpsTab
      sport="NFL"
      status="planned"
      title="NFL Ops is reserved for football-specific signals"
      description="NFL needs its own injury, QB, weather, spread, and total treatment. Keeping it separate protects the NBA pipeline."
      items={[
        { icon: AlertTriangle, label: "Injuries", text: "QB status and clustered offensive line/secondary injuries should drive severity." },
        { icon: CloudSun, label: "Weather", text: "Wind, precipitation, and temperature need total-specific handling." },
        { icon: Database, label: "Execution", text: "NFL grading and market timing should be built as a new module." },
      ]}
    />
  );
}
