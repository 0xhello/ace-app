import type { ComponentType } from "react";
import TodayOpsTab from "@/components/ops/today/TodayOpsTab";
import ResultsOpsTab from "@/components/ops/results/ResultsOpsTab";
import ResearchOpsTab from "@/components/ops/research/ResearchOpsTab";
import DiagnosticsOpsTab from "@/components/ops/diagnostics/DiagnosticsOpsTab";

export type OpsSportKey = "today" | "results" | "research" | "diagnostics";
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
    key: "today",
    label: "Today",
    status: "live",
    description: "Open paper-tracked picks and stale rows needing grade.",
    component: TodayOpsTab,
  },
  {
    key: "results",
    label: "Results",
    status: "live",
    description: "Graded canonical paper-tracked performance.",
    component: ResultsOpsTab,
  },
  {
    key: "research",
    label: "Research",
    status: "live",
    description: "Candidates, validation, backtests, and calibration work.",
    component: ResearchOpsTab,
  },
  {
    key: "diagnostics",
    label: "Diagnostics",
    status: "live",
    description: "Workers, quota, raw tables, and operational tools.",
    component: DiagnosticsOpsTab,
  },
];
