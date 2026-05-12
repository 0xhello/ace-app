import type { ComponentType } from "react";
import NBAOpsTab from "@/components/ops/nba/NBAOpsTab";
import MLBOpsTab from "@/components/ops/mlb/MLBOpsTab";
import SoccerOpsTab from "@/components/ops/soccer/SoccerOpsTab";
import NFLOpsTab from "@/components/ops/nfl/NFLOpsTab";

export type OpsSportKey = "nba" | "mlb" | "soccer" | "nfl";
export type OpsSportStatus = "live" | "soon" | "planned";

export interface OpsSportConfig {
  key: OpsSportKey;
  label: string;
  status: OpsSportStatus;
  description: string;
  component: ComponentType;
}

export const OPS_SPORTS: OpsSportConfig[] = [
  {
    key: "nba",
    label: "NBA",
    status: "live",
    description: "Current NBA spread model, signals, execution, and grading flow.",
    component: NBAOpsTab,
  },
  {
    key: "mlb",
    label: "MLB",
    status: "soon",
    description: "Pitchers, weather, F5/full-game markets, and bullpen-aware signals.",
    component: MLBOpsTab,
  },
  {
    key: "soccer",
    label: "Soccer",
    status: "soon",
    description: "FIFA World Cup 2026 — Pinnacle divergence signals on h2h and totals. Launches Jun 11.",
    component: SoccerOpsTab,
  },
  {
    key: "nfl",
    label: "NFL",
    status: "planned",
    description: "Spread/total ops with QB status, injury clusters, and weather context.",
    component: NFLOpsTab,
  },
];
