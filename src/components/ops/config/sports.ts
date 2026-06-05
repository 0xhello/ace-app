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
    description: "Cross-sport picks, open plays, results, and record.",
    component: OverviewOpsTab,
  },
  {
    key: "nba",
    label: "NBA",
    status: "live",
    description: "NBA picks, open plays, and graded results.",
    component: NBAOpsTab,
  },
  {
    key: "mlb",
    label: "MLB",
    status: "live",
    description: "MLB picks, open plays, CLV, and graded results.",
    component: MLBOpsTab,
  },
  {
    key: "soccer",
    label: "Soccer",
    status: "live",
    description: "Soccer picks, approved tickets, candidate review, and results.",
    component: SoccerOpsTab,
  },
];
