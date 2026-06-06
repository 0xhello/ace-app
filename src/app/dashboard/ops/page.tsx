"use client";

import { useMemo, useState } from "react";
import OpsShell from "@/components/ops/OpsShell";
import { OPS_SPORTS, type OpsSportKey } from "@/components/ops/config/sports";

export default function OpsPage() {
  const [activeSport, setActiveSport] = useState<OpsSportKey>("today");
  const ActiveComponent = useMemo(
    () => OPS_SPORTS.find((sport) => sport.key === activeSport)?.component ?? OPS_SPORTS[0].component,
    [activeSport]
  );

  return (
    <OpsShell activeSport={activeSport} onSportChange={setActiveSport}>
      <ActiveComponent />
    </OpsShell>
  );
}
