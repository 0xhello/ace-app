/**
 * Canonical pick TIER — the single source of truth for "Proven vs
 * Experimental", shared by every surface that displays a soccer pick
 * (ops verdict badges, /performance, the consumer dashboard).
 *
 * It agrees with docs/SOCCER_MODEL_BACKTEST_V2.md and the ops
 * MARKET_VERDICTS table. If the backtest verdict changes, change it HERE.
 *
 * Tiers:
 *   proven       — positive ROI on a leakage-free held-out backtest.
 *                  Today: ONLY Over 2.5 goals.
 *   experimental — tracking live, not yet proven on a clean backtest
 *                  (BTTS, scorer props, other totals lines).
 *   avoid        — backtest shows no edge / loses (1X2, Under 2.5, corners).
 *                  Never surfaced as a pick; shown in ops for transparency.
 */
export type PickTier = "proven" | "experimental" | "avoid";

export interface TierInfo {
  tier: PickTier;
  label: string;
  blurb: string;
}

export const TIERS: Record<PickTier, TierInfo> = {
  proven: {
    tier: "proven",
    label: "Proven",
    blurb: "Positive ROI on a leakage-free, held-out backtest.",
  },
  experimental: {
    tier: "experimental",
    label: "Experimental",
    blurb: "Tracking live — not yet proven on a clean backtest.",
  },
  avoid: {
    tier: "avoid",
    label: "No edge",
    blurb: "Backtest shows no edge — shown for transparency, never bet.",
  },
};

function normMarket(market: string): string {
  const s = (market || "").toLowerCase();
  if (s.includes("total") || s.includes("goals_over") || s === "tot" || s === "o/u") return "totals";
  if (s.includes("btts") || s.includes("both_teams")) return "btts";
  if (s.includes("corner")) return "corners";
  if (s.includes("scorer") || s.includes("goalscorer") || s.includes("anytime")) return "scorer";
  if (s === "h2h" || s.includes("1x2") || s.includes("fulltime_result") || s.includes("moneyline")) return "1x2";
  return s;
}

/** Tier for a SOCCER market+side(+line). */
export function soccerMarketTier(
  market: string,
  side?: string | null,
  line?: number | null,
): TierInfo {
  const m = normMarket(market);
  const sd = (side || "").toLowerCase();
  if (m === "totals") {
    const isOver = sd.includes("over") || sd === "o";
    const is25 = line == null || Math.abs(line - 2.5) < 1e-9;
    if (is25) return isOver ? TIERS.proven : TIERS.avoid; // Over 2.5 proven; Under 2.5 loses
    return TIERS.experimental; // other totals lines untested
  }
  if (m === "btts" || m === "scorer") return TIERS.experimental;
  if (m === "1x2" || m === "corners") return TIERS.avoid;
  return TIERS.experimental; // unknown soccer market → conservative
}

function isSoccer(sport: string): boolean {
  return (sport || "").toLowerCase().includes("soccer");
}

/**
 * Sport-aware tier. Only soccer carries a Proven/Experimental claim right now
 * (NBA/MLB have their own validation, out of scope here) — returns null for
 * other sports so callers can omit the badge.
 */
export function pickTier(
  sport: string,
  market: string,
  side?: string | null,
  line?: number | null,
): TierInfo | null {
  if (!isSoccer(sport)) return null;
  return soccerMarketTier(market, side, line);
}
