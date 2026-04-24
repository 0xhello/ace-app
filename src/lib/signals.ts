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

// ── Market-level AI recommendation system ──────────────────────────────────

export type MarketRec = "ml-away" | "ml-home" | "sp-away" | "sp-home" | "ov" | "un";

function signalScore(sig: Signal): number {
  let score = 0;
  if (sig.severity === "high") score += 6;
  else if (sig.severity === "medium") score += 3;
  else score += 1;
  if (sig.certainty === "confirmed") score += 4;
  else if (sig.certainty === "likely") score += 2;
  if (sig.direction !== "uncertain") score += 2;
  return score;
}

function signalToMarket(signal: Signal, tiebreakSeed: number): MarketRec | null {
  if (signal.direction === "uncertain") return null;

  if (signal.type === "weather") {
    const b = signal.benefits.join(" ").toLowerCase();
    if (b.includes("under")) return "un";
    if (b.includes("over")) return "ov";
    return null;
  }

  if (signal.type === "market") {
    const b = signal.benefits.join(" ").toLowerCase();
    if (b.includes("under")) return "un";
    if (b.includes("over")) return "ov";
    if (b.includes("home")) return tiebreakSeed % 2 === 0 ? "sp-home" : "ml-home";
    if (b.includes("away")) return tiebreakSeed % 2 === 0 ? "sp-away" : "ml-away";
    return null;
  }

  if (signal.type === "injury" || signal.type === "news") {
    if (signal.direction === "negative") {
      if (signal.affectedTeam === "home") return tiebreakSeed % 2 === 0 ? "ml-away" : "sp-away";
      if (signal.affectedTeam === "away") return tiebreakSeed % 2 === 0 ? "ml-home" : "sp-home";
    }
    if (signal.direction === "positive") {
      if (signal.affectedTeam === "home") return tiebreakSeed % 2 === 0 ? "ml-home" : "sp-home";
      if (signal.affectedTeam === "away") return tiebreakSeed % 2 === 0 ? "ml-away" : "sp-away";
    }
  }

  return null;
}

/**
 * For a given game, returns which specific market the AI recommends.
 * Only returns a recommendation when signals are strong enough and clearly aligned.
 * Returns null if no high-conviction edge exists.
 */
export function getAIRecommendation(gameId: string, homeTeam: string, awayTeam: string): { market: MarketRec; confidence: number; reason: string } | null {
  const signals = generateSignalsForGame(gameId, homeTeam, awayTeam);
  if (signals.length === 0) return null;

  const h = hash(gameId);

  const actionable = signals
    .filter((s) => s.direction !== "uncertain" && s.certainty !== "speculative")
    .sort((a, b) => signalScore(b) - signalScore(a));

  if (actionable.length === 0) return null;

  const top = actionable[0];
  if (signalScore(top) < 8) return null;

  const market = signalToMarket(top, h);
  if (!market) return null;

  const confidence = generateConfidence(gameId, homeTeam, awayTeam);
  if (confidence.pct < 65) return null;

  const reasons: Partial<Record<MarketRec, string[]>> = {
    "ml-home": ["Home side has structural advantage; away carrying injury risk", "Line value on home side after sharp movement"],
    "ml-away": ["Away team better positioned; home side weakened by signal stack", "Road team showing edge at current price"],
    "sp-home": ["Home spread showing value after reverse line movement", "Home team undervalued at current number"],
    "sp-away": ["Away spread holds value; sharp money disagrees with public", "Road team well-positioned against the spread"],
    "ov": ["Pace and scoring conditions favor the over", "Defensive limitations create over value"],
    "un": ["Conditions strongly suppress scoring; defensive edge confirmed", "Key offensive factors limited"],
  };

  const reasonList = reasons[market] ?? ["Signal alignment detected at current price"];
  return { market, confidence: confidence.pct, reason: pick(reasonList, h + 7) };
}

/**
 * Deterministic movement direction for a market cell.
 * Returns "up" | "down" | null
 */
export function getMovementDirection(gameId: string, marketKey: string): "up" | "down" | null {
  const h = hash(gameId + marketKey);
  // ~30% of cells show movement
  if (h % 10 < 7) return null;
  return h % 2 === 0 ? "up" : "down";
}

// ── Signal templates ──────────────────────────────────────────────────────

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
  const signalCount = (h % 4);
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

function generateConfidence(gameId: string, homeTeam: string, awayTeam: string): ConfidenceRead {
  const signals = generateSignalsForGame(gameId, homeTeam, awayTeam);
  const h = hash(gameId);

  if (signals.length === 0) {
    const base = 52 + (h % 13);
    return {
      tier: "low",
      pct: base,
      label: `Low (${base}%) — Insufficient data`,
      explanation: "No significant signals detected for this game",
      status: "stable",
    };
  }

  let score = 60;
  const directions = signals.map((s) => s.direction);
  const hasPositive = directions.includes("positive");
  const hasNegative = directions.includes("negative");
  let hasConflict = hasPositive && hasNegative;

  for (const sig of signals) {
    if (sig.direction === "uncertain") {
      score -= 6;
      hasConflict = true;
      continue;
    }
    if (sig.severity === "high" && sig.certainty === "confirmed") score += 14;
    else if (sig.severity === "high" && sig.certainty === "likely") score += 9;
    else if (sig.severity === "high") score += 5;
    else if (sig.severity === "medium" && sig.certainty === "confirmed") score += 6;
    else if (sig.severity === "medium") score += 3;
    else score += 2;
  }

  if (hasConflict) score -= 8;

  const noise = (h % 11) - 5;
  score = Math.max(52, Math.min(94, Math.round(score + noise)));

  const status: "stable" | "volatile" | "degraded" = hasConflict ? "degraded" : "stable";

  if (score >= 80) {
    return {
      tier: "high",
      pct: score,
      label: `High (${score}%) — ${status === "stable" ? "Stable" : "Conflicted"}`,
      explanation: hasConflict ? "Strong signals with minor divergence" : "Signals aligned with strong conviction",
      status,
    };
  }
  if (score >= 65) {
    return {
      tier: "medium",
      pct: score,
      label: `Medium (${score}%) — ${status === "stable" ? "Moderate confidence" : "Conflicting signals"}`,
      explanation: hasConflict ? "Mixed signals reduce conviction" : "Moderate signal alignment",
      status,
    };
  }
  return {
    tier: "low",
    pct: score,
    label: `Low (${score}%) — ${hasConflict ? "Signals conflicting" : "Weak signals"}`,
    explanation: hasConflict ? "Conflicting signals, exercise caution" : "Insufficient signal clarity",
    status: "degraded",
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

export function getSignalsForGame(gameId: string, homeTeam: string, awayTeam: string): Signal[] {
  return generateSignalsForGame(gameId, homeTeam, awayTeam);
}

export function getConfidenceForGame(gameId: string, homeTeam: string, awayTeam: string): ConfidenceRead {
  return generateConfidence(gameId, homeTeam, awayTeam);
}

export function getTopSignalForGame(gameId: string, homeTeam: string, awayTeam: string): Signal | null {
  const signals = generateSignalsForGame(gameId, homeTeam, awayTeam);
  if (!signals.length) return null;
  const severityOrder: Record<string, number> = { high: 3, medium: 2, low: 1 };
  return signals.sort((a, b) => (severityOrder[b.severity] || 0) - (severityOrder[a.severity] || 0))[0];
}

export function hasHighSeveritySignal(gameId: string, homeTeam: string, awayTeam: string): boolean {
  return generateSignalsForGame(gameId, homeTeam, awayTeam).some((s) => s.severity === "high");
}

export function generateAIPicks(): AIPick[] {
  const seeds = [
    { id: "ai-1", gameId: "gsw-phx", home: "PHX", away: "GSW", type: "TOTAL", pick: "O 228.5", game: "GSW @ PHX", odds: -105, market: "Total", reasoning: "Pace mismatch + both teams top-5 tempo. No injury impact on scoring.", tag: "stable" as PickTag, edge: "+4.2%" },
    { id: "ai-2", gameId: "bos-lal", home: "LAL", away: "BOS", type: "ML", pick: "LAL ML", game: "BOS @ LAL", odds: -145, market: "Moneyline", reasoning: "Back-to-back fatigue for Boston. Home court edge amplified.", tag: "stable" as PickTag, edge: "+3.1%" },
    { id: "ai-3", gameId: "gsw-phx-prop", home: "PHX", away: "GSW", type: "PROP", pick: "Curry O 28.5", game: "GSW @ PHX", odds: -115, market: "Player Prop", reasoning: "PHX perimeter defense weakened by injury. Usage rate projected up.", tag: "watch" as PickTag, edge: "+2.8%" },
    { id: "ai-4", gameId: "mil-cle", home: "CLE", away: "MIL", type: "SPREAD", pick: "MIL -4.5", game: "MIL @ CLE", odds: -108, market: "Spread", reasoning: "Reverse line movement suggests sharp action. Model holds conviction.", tag: "volatile" as PickTag, edge: "+1.9%" },
  ];

  return seeds.map((s) => ({
    id: s.id,
    gameId: s.gameId,
    type: s.type,
    pick: s.pick,
    game: s.game,
    odds: s.odds,
    market: s.market,
    confidence: generateConfidence(s.gameId, s.home, s.away),
    reasoning: s.reasoning,
    tag: s.tag,
    edge: s.edge,
    signals: generateSignalsForGame(s.gameId, s.home, s.away),
  }));
}
