/**
 * Deterministic mock signal system for ACE.
 *
 * Generates realistic signals per game based on game ID hash.
 * Not random — same game always produces same signals so UI is stable.
 * Replace with real backend when signal pipeline is built.
 */

import type { Signal, SignalType, SignalSeverity, AffectedTeam, SignalDirection, ConfidenceRead, AIPick, PickTag } from "@/types/signal";

// Simple deterministic hash from string
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function pick<T>(arr: T[], seed: number): T {
  return arr[seed % arr.length];
}

const INJURY_TEMPLATES: Array<{
  summary: string;
  details: string;
  severity: SignalSeverity;
  direction: SignalDirection;
  benefits: string[];
  harms: string[];
}> = [
  {
    summary: "Key starter questionable",
    details: "Starting point guard listed as questionable with ankle soreness. Game-time decision expected.",
    severity: "high",
    direction: "negative",
    benefits: ["Opponent moneyline", "Opponent spread"],
    harms: ["Team moneyline", "Team spread", "Player props"],
  },
  {
    summary: "Rotation player ruled out",
    details: "Bench rotation player confirmed out with hamstring strain. Limited impact on team output.",
    severity: "low",
    direction: "negative",
    benefits: ["Minimal impact"],
    harms: ["Depth slightly reduced"],
  },
  {
    summary: "Star returning from injury",
    details: "Star player cleared to play after missing 3 games. Expected minutes restriction.",
    severity: "high",
    direction: "positive",
    benefits: ["Team moneyline", "Team spread"],
    harms: ["Opponent spread", "Under bets if pace increases"],
  },
  {
    summary: "Injury uncertainty unresolved",
    details: "Multiple players on injury report with no clear update. Lineup unclear until warmups.",
    severity: "medium",
    direction: "uncertain",
    benefits: ["Impact unclear until lineup confirmed"],
    harms: ["All team markets carry elevated uncertainty"],
  },
];

const WEATHER_TEMPLATES: Array<{
  summary: string;
  details: string;
  severity: SignalSeverity;
  direction: SignalDirection;
  benefits: string[];
  harms: string[];
}> = [
  {
    summary: "Wind conditions favor Under",
    details: "Sustained winds 18+ mph expected at game time. Historically suppresses scoring in outdoor games.",
    severity: "medium",
    direction: "negative",
    benefits: ["Under total", "Defensive teams"],
    harms: ["Over total", "Passing game props"],
  },
  {
    summary: "Clear conditions, no weather impact",
    details: "Standard indoor arena or clear outdoor conditions. No weather-related adjustments needed.",
    severity: "low",
    direction: "uncertain",
    benefits: [],
    harms: [],
  },
  {
    summary: "Rain expected at game time",
    details: "70% chance of rain with moderate precipitation. Could affect ball handling and pace.",
    severity: "medium",
    direction: "negative",
    benefits: ["Under total", "Run-heavy teams"],
    harms: ["Over total", "Pass-heavy teams"],
  },
];

const MARKET_TEMPLATES: Array<{
  summary: string;
  details: string;
  severity: SignalSeverity;
  direction: SignalDirection;
  benefits: string[];
  harms: string[];
}> = [
  {
    summary: "Line moving toward home team",
    details: "Spread has moved 1.5 points toward home since open. Sharp action detected on home side.",
    severity: "medium",
    direction: "positive",
    benefits: ["Home spread (current)", "Home ML"],
    harms: ["Away spread value eroding"],
  },
  {
    summary: "Reverse line movement detected",
    details: "Public money heavily on one side but line moving opposite. Possible sharp counter-action.",
    severity: "high",
    direction: "uncertain",
    benefits: ["Contrarian side may hold value"],
    harms: ["Public side losing value"],
  },
  {
    summary: "Total dropping across books",
    details: "Over/under line dropped 2 points across multiple sportsbooks in last hour.",
    severity: "medium",
    direction: "negative",
    benefits: ["Under at current number"],
    harms: ["Over bettors seeing worse value"],
  },
];

const CONFIDENCE_TEMPLATES: Array<{
  summary: string;
  details: string;
  severity: SignalSeverity;
  direction: SignalDirection;
  benefits: string[];
  harms: string[];
}> = [
  {
    summary: "Model confidence elevated",
    details: "ACE model shows strong conviction on this game. Multiple signals aligned in same direction.",
    severity: "low",
    direction: "positive",
    benefits: ["ACE-recommended side"],
    harms: [],
  },
  {
    summary: "Confidence dropping — signals conflicting",
    details: "New information is degrading model confidence. Injury and market signals pointing different directions.",
    severity: "high",
    direction: "uncertain",
    benefits: ["Caution warranted on all sides"],
    harms: ["Previously high-confidence picks losing edge"],
  },
];

function generateSignalsForGame(gameId: string, homeTeam: string, awayTeam: string): Signal[] {
  const h = hash(gameId);
  const signalCount = (h % 4); // 0-3 signals per game
  if (signalCount === 0) return [];

  const signals: Signal[] = [];
  const now = new Date().toISOString();

  const allTemplates = [
    ...INJURY_TEMPLATES.map((t) => ({ ...t, type: "injury" as SignalType, source: "injury" as const })),
    ...WEATHER_TEMPLATES.map((t) => ({ ...t, type: "weather" as SignalType, source: "weather" as const })),
    ...MARKET_TEMPLATES.map((t) => ({ ...t, type: "market" as SignalType, source: "market" as const })),
    ...CONFIDENCE_TEMPLATES.map((t) => ({ ...t, type: "confidence" as SignalType, source: "ai" as const })),
  ];

  for (let i = 0; i < signalCount; i++) {
    const templateIdx = (h + i * 7) % allTemplates.length;
    const t = allTemplates[templateIdx];
    const affectedTeam: AffectedTeam = pick(["home", "away", "both"] as AffectedTeam[], h + i * 3);
    const teamName = affectedTeam === "home" ? homeTeam : affectedTeam === "away" ? awayTeam : "both teams";
    const certainty = pick(["confirmed", "likely", "speculative"] as const, h + i * 5);

    signals.push({
      id: `sig-${gameId}-${i}`,
      gameId,
      type: t.type,
      severity: t.severity,
      certainty,
      affectedTeam,
      direction: t.direction,
      summary: t.summary.replace(/Team/g, teamName),
      details: t.details.replace(/Team/g, teamName),
      benefits: t.benefits,
      harms: t.harms,
      sourceCategory: t.source,
      isForced: t.severity === "high",
      isDemo: true,
      createdAt: now,
    });
  }

  return signals;
}

function generateConfidence(gameId: string): ConfidenceRead {
  const h = hash(gameId);
  const pct = 55 + (h % 40); // 55-94

  if (pct >= 85) {
    return {
      tier: "high",
      pct,
      label: `High (${pct}%) — Stable`,
      explanation: "Signals aligned, no major risks detected",
      status: "stable",
    };
  }
  if (pct >= 70) {
    const statuses = ["stable", "volatile"] as const;
    const status = pick([...statuses], h + 1);
    return {
      tier: "medium",
      pct,
      label: `Medium (${pct}%) — ${status === "stable" ? "Slight uncertainty" : "Volatile"}`,
      explanation: status === "stable" ? "Minor injury uncertainty" : "Market signals diverging from model",
      status,
    };
  }
  return {
    tier: "low",
    pct,
    label: `Low (${pct}%) — Signals conflicting`,
    explanation: "Multiple conflicting signals, exercise caution",
    status: "degraded",
  };
}

// Public API

export function getSignalsForGame(gameId: string, homeTeam: string, awayTeam: string): Signal[] {
  return generateSignalsForGame(gameId, homeTeam, awayTeam);
}

export function getConfidenceForGame(gameId: string): ConfidenceRead {
  return generateConfidence(gameId);
}

export function getTopSignalForGame(gameId: string, homeTeam: string, awayTeam: string): Signal | null {
  const signals = generateSignalsForGame(gameId, homeTeam, awayTeam);
  if (!signals.length) return null;
  // Return highest severity signal
  const severityOrder: Record<string, number> = { high: 3, medium: 2, low: 1 };
  return signals.sort((a, b) => (severityOrder[b.severity] || 0) - (severityOrder[a.severity] || 0))[0];
}

export function hasHighSeveritySignal(gameId: string, homeTeam: string, awayTeam: string): boolean {
  return generateSignalsForGame(gameId, homeTeam, awayTeam).some((s) => s.severity === "high");
}

export function generateAIPicks(): AIPick[] {
  return [
    {
      id: "ai-1",
      gameId: "gsw-phx",
      type: "TOTAL",
      pick: "O 228.5",
      game: "GSW @ PHX",
      odds: -105,
      market: "Total",
      confidence: { tier: "high", pct: 91, label: "High (91%) — Stable", explanation: "Signals aligned, no major risks", status: "stable" },
      reasoning: "Pace mismatch + both teams top-5 tempo. No injury impact on scoring.",
      tag: "stable",
      edge: "+4.2%",
      signals: [],
    },
    {
      id: "ai-2",
      gameId: "bos-lal",
      type: "ML",
      pick: "LAL ML",
      game: "BOS @ LAL",
      odds: -145,
      market: "Moneyline",
      confidence: { tier: "high", pct: 87, label: "High (87%) — Stable", explanation: "Home advantage + fatigue signal", status: "stable" },
      reasoning: "Back-to-back fatigue for Boston. Home court edge amplified.",
      tag: "stable",
      edge: "+3.1%",
      signals: [],
    },
    {
      id: "ai-3",
      gameId: "gsw-phx",
      type: "PROP",
      pick: "Curry O 28.5",
      game: "GSW @ PHX",
      odds: -115,
      market: "Player Prop",
      confidence: { tier: "medium", pct: 78, label: "Medium (78%) — Slight uncertainty", explanation: "Matchup strong but minutes unclear", status: "stable" },
      reasoning: "PHX perimeter defense weakened by injury. Usage rate projected up.",
      tag: "watch",
      edge: "+2.8%",
      signals: [],
    },
    {
      id: "ai-4",
      gameId: "mil-cle",
      type: "SPREAD",
      pick: "MIL -4.5",
      game: "MIL @ CLE",
      odds: -108,
      market: "Spread",
      confidence: { tier: "medium", pct: 74, label: "Medium (74%) — Volatile", explanation: "Market diverging from model slightly", status: "volatile" },
      reasoning: "Reverse line movement suggests sharp action. Model holds conviction.",
      tag: "volatile",
      edge: "+1.9%",
      signals: [],
    },
  ];
}
