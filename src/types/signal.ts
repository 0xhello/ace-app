export type SignalType = "injury" | "weather" | "market" | "confidence" | "model" | "news";
export type SignalSeverity = "low" | "medium" | "high";
export type SignalCertainty = "confirmed" | "likely" | "speculative";
export type AffectedTeam = "home" | "away" | "both" | "neutral";
export type SignalDirection = "positive" | "negative" | "uncertain";
export type SourceCategory = "injury" | "weather" | "market" | "ai" | "mock";

export interface Signal {
  id: string;
  gameId: string;
  type: SignalType;
  severity: SignalSeverity;
  certainty: SignalCertainty;
  affectedTeam: AffectedTeam;
  direction: SignalDirection;
  summary: string;
  details: string;
  benefits: string[];
  harms: string[];
  sourceCategory: SourceCategory;
  isForced: boolean;
  isDemo: boolean;
  createdAt: string;
  expiresAt?: string;
}

export type ConfidenceTier = "high" | "medium" | "low";

export interface ConfidenceRead {
  tier: ConfidenceTier;
  pct: number;
  label: string;       // e.g. "High (91%) — Stable"
  explanation: string;  // 1-line reason
  status: "stable" | "volatile" | "degraded";
}

export type PickTag = "stable" | "volatile" | "watch";

export interface AIPick {
  id: string;
  gameId: string;
  type: string;
  pick: string;
  game: string;
  odds: number;
  market: string;
  confidence: ConfidenceRead;
  reasoning: string;       // signal-based, not stat-based
  tag: PickTag;
  edge: string;
  signals: Signal[];
}
