import type { ComponentType } from "react";
import OverviewOpsTab from "@/components/ops/overview/OverviewOpsTab";
import NBAOpsTab from "@/components/ops/nba/NBAOpsTab";
import MLBOpsTab from "@/components/ops/mlb/MLBOpsTab";
import SoccerOpsTab from "@/components/ops/soccer/SoccerOpsTab";
export type OpsSportKey = "overview" | "nba" | "mlb" | "soccer";
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
    key: "overview",
    label: "Overview",
    status: "live",
    description: "Cross-sport signal volume, win rates, and worker health across NBA, WC, and MLB.",
    component: OverviewOpsTab,
  },
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
    status: "live",
    description: "ML / run line / totals divergence vs Pinnacle benchmark with pick logging + CLV.",
    component: MLBOpsTab,
  },
  {
    key: "soccer",
    label: "Soccer",
    status: "live",
    description: "FIFA World Cup 2026 — h2h / AH / totals divergence with pick logging + CLV. Kickoff Jun 11.",
    component: SoccerOpsTab,
  },
];
