"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Activity, AlertTriangle, Brain, CheckCircle2, Clock,
  RefreshCw, Target, TrendingUp, Zap, Trophy, UserX,
} from "lucide-react";
import {
  KpiCard,
  SectionHead,
  ActionButton,
  WorkerStatusStrip,
  OpsPageHeader,
  ErrorBanner,
  LoadingState,
  Panel,
  Tag,
  EmptyState,
  EngineInternals,
} from "@/components/ops/shared/primitives";
import {
  TodaySlatePanel,
  OpenSignalsPanel,
  CLVStatsPanel,
  ByBookPanel,
  StaleSignalsPanel,
  ActivityStreamPanel,
} from "@/components/ops/shared/panels";
import PlayerPriorsPanel from "@/components/ops/soccer/PlayerPriorsPanel";
import MarketProbePanel from "@/components/ops/soccer/MarketProbePanel";
import SuggestedPicksPanel from "@/components/ops/soccer/SuggestedPicksPanel";
import FriendliesPanel from "@/components/ops/soccer/FriendliesPanel";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SoccerSignal {
  id: number;
  game_date: string;
  home_team: string;
  away_team: string;
  commence_time: string | null;
  market: string;
  bet_side: string;
  total_line: number | null;
  pinnacle_prob: number | null;
  book: string;
  book_prob: number | null;
  book_odds: number | null;
  edge_pp: number | null;
  home_score: number | null;
  away_score: number | null;
  result: string | null;
  correct: number | null;
  status: string;
  notes: string | null;
}

interface Stats {
  total: number; open: number; graded: number;
  wins: number; losses: number;
  winRate: number | null; roi: number | null;
  h2h:    { graded: number; wins: number };
  totals: { graded: number; wins: number };
}

interface JobMeta {
  lastRunAt: string | null;
  lastError: string | null;
  marketEventsChecked?: number;
  pricedCards?: number;
  mapped?: number;
  synced?: number;
  cards?: number;
  priced?: number;
}
interface SoccerCandidate {
  id: number;
  game_id: string;
  sport_key: string;
  tournament: string;
  game_date: string;
  home_team: string;
  away_team: string;
  model_home_team: string;
  model_away_team: string;
  commence_time: string | null;
  market: string;
  bet_side: string;
  total_line: number | null;
  model_prob: number;
  book_prob: number;
  book_odds: number;
  book: string;
  edge_pp: number;
  confidence_tier: "A" | "B" | "C";
  status: string;
  rationale_json: string | null;
  review_notes: string | null;
  reviewed_at: string | null;
  home_score: number | null;
  away_score: number | null;
  result: string | null;
  correct: number | null;
  graded_at: string | null;
  exposed_to_beta: number;
  detected_at: string;
  updated_at: string;
}
interface ActualPick {
  id: number;
  source: "approved" | "shortlist";
  status: string;
  tournament: string;
  game_date: string;
  commence_time: string | null;
  matchup: string;
  market: string;
  pick: string;
  book: string;
  odds: number;
  model_prob: number;
  market_prob: number;
  edge_pp: number;
  confidence_tier: "A" | "B" | "C";
  stake_units: number;
  reason: string;
  correct: number | null;
  result: string | null;
}
interface FootballRoute {
  book: string;
  odds: number;
  market_prob: number;
}
interface FootballPick {
  market: string;
  pick: string;
  model_prob: number;
  confidence: "A" | "B" | "C";
  football_case: string[];
  route: FootballRoute | null;
}
interface FootballAnalysisCard {
  game_id: string;
  league: string;
  matchup: string;
  commence_time: string | null;
  prediction: {
    home_win?: number;
    draw?: number;
    away_win?: number;
    lambda_home?: number;
    lambda_away?: number;
    over_2_5?: number;
    under_2_5?: number;
    btts_yes?: number;
  };
  variables: {
    home_form_last5?: { record?: string; gf?: number; ga?: number; n?: number };
    away_form_last5?: { record?: string; gf?: number; ga?: number; n?: number };
    home_flow_home_last10?: Record<string, number | null | undefined>;
    away_flow_away_last10?: Record<string, number | null | undefined>;
    h2h_last5?: { record?: string; goal_diff?: number; n?: number };
  };
  picks: FootballPick[];
}
interface PropCard {
  id: number;
  game_id: string;
  tournament: string;
  commence_time: string | null;
  home_team: string;
  away_team: string;
  team: string;
  opponent: string;
  player_name: string;
  market: string;
  model_prob: number | null;
  model_mean: number | null;
  book: string | null;
  book_odds: number | null;
  book_point: number | null;
  implied_prob: number | null;
  edge_pp: number | null;
  decision: "pick" | "lean" | "watch" | "pass";
  confidence_tier: "A" | "B" | "C";
  blocker_reasons?: string[];
  bettor_notes?: string[];
  context?: {
    team_environment?: { projected_team_goals?: number | null; recent_xg_for?: number | null };
    opponent_weakness?: { grade?: string | null; recent_xg_against?: number | null } | null;
    role_today?: { lineup_status?: string | null; penalty_role?: string | null };
  };
}
interface WCInjury {
  team_name: string;
  player_name: string;
  status: "out" | "suspended" | "questionable";
  reason: string | null;
  updated_at: string;
}
interface WCPayload {
  worker: { lastPollAt: string | null; lastPollOk: boolean | null };
  jobs:   { fetch: JobMeta; grade: JobMeta; candidates?: JobMeta; propCards?: JobMeta; livePipeline?: JobMeta; sportmonksInventory?: JobMeta };
  signals: SoccerSignal[];
  candidates: SoccerCandidate[];
  actualPicks: ActualPick[];
  footballAnalysis: FootballAnalysisCard[];
  propCards: PropCard[];
  propCardStats?: { by_decision: Record<string, number>; priced: number; top_edge_pp: number | null };
  candidateStats?: { total: number; by_status: Record<string, number>; top_edge_pp: number | null; record?: { graded: number; wins: number; losses: number; win_rate: number | null } };
  stats:   Stats;
  injuries: WCInjury[];
  refreshedAt: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(ts: string | null): string {
  if (!ts) return "never";
  const d = new Date(ts.replace(" ", "T"));
  const diff = Date.now() - d.getTime();
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h > 48) return `${Math.floor(h / 24)}d ago`;
  if (h > 0)  return `${h}h ${m}m ago`;
  if (m > 0)  return `${m}m ago`;
  return "just now";
}

function fmtPct(v: number | null) {
  return v !== null ? `${(v * 100).toFixed(1)}%` : "—";
}
function fmtRoi(v: number | null) {
  if (v === null) return "—";
  const s = (v * 100).toFixed(1);
  return v >= 0 ? `+${s}%` : `${s}%`;
}
function fmtEdge(v: number | null) {
  if (v === null) return "—";
  return `+${(v * 100).toFixed(1)}pp`;
}
function fmtOdds(v: number | null) {
  if (v === null) return "—";
  return v >= 0 ? `+${v}` : `${v}`;
}

function stakeSizeLabel(units: number | null | undefined): string {
  if (typeof units !== "number" || !Number.isFinite(units) || units <= 0) return "No bet";
  if (units < 0.5) return "Small bet";
  if (units < 1.25) return "Standard bet";
  if (units < 2.5) return "Strong bet";
  return "Max bet";
}

function stakeSizeExplain(units: number | null | undefined): string {
  if (typeof units !== "number" || !Number.isFinite(units) || units <= 0) return "Do not risk money on this yet.";
  if (units < 0.5) return "Risk about a quarter to half of your normal bet size.";
  if (units < 1.25) return "Risk your normal bet size.";
  if (units < 2.5) return "Risk about 1.5-2x your normal bet size.";
  return "Rare high-conviction size; keep it within your bankroll limits.";
}

function stakeSizeDetail(units: number | null | undefined): string {
  if (typeof units !== "number" || !Number.isFinite(units) || units <= 0) return "No stake";
  return `${stakeSizeLabel(units)} — ${stakeSizeExplain(units)}`;
}

function confidenceText(tier: "A" | "B" | "C" | null | undefined): string {
  if (tier === "A") return "High confidence";
  if (tier === "B") return "Medium-high confidence";
  if (tier === "C") return "Low confidence";
  return "Unrated confidence";
}

function confidenceFromEdge(edge: number | null | undefined): string {
  if (typeof edge !== "number" || !Number.isFinite(edge)) return "Unrated confidence";
  if (edge >= 0.07) return "High confidence";
  if (edge >= 0.05) return "Medium-high confidence";
  if (edge >= 0.03) return "Medium confidence";
  return "Low confidence";
}

// Map any market+side+line into a clean human label for the candidate
// table / row views. Handles game markets (h2h, totals, AH) AND player
// props (shots, scorer, assist) — the latter were previously falling
// through and producing nonsense like "Shots Yes".
function betLabel(market: string, side: string, line: number | null) {
  const m = (market || "").toLowerCase();
  const s = (side || "").toLowerCase();

  // Game-level
  if (m === "totals") return `${side === "over" ? "Over" : "Under"} ${line ?? ""}`;
  if (m === "asian_handicap") return `AH ${side === "home" ? "Home" : "Away"} ${line != null ? (line >= 0 ? `+${line}` : line) : ""}`;
  if (m === "h2h" && s === "draw") return "Draw";
  if (m === "h2h") return side.charAt(0).toUpperCase() + side.slice(1);
  if (m === "btts") return `BTTS ${s === "yes" ? "Yes" : "No"}`;

  // Player props — never just show "Yes"; describe the actual bet
  const unit =
    m === "shots" ? "shots" :
    m === "shots_on_target" || m === "sot" ? "SoT" :
    m === "passes" ? "passes" :
    m === "tackles" ? "tackles" :
    m === "fouls_committed" || m === "fouls" ? "fouls" :
    null;
  if (unit && line != null) {
    const isHalfLine = Math.abs(line - Math.round(line)) > 0.01;
    return isHalfLine ? `Over ${line} ${unit}` : `${line}+ ${unit}`;
  }
  if (m === "anytime_scorer") return "Anytime goal";
  if (m === "first_scorer" || m === "first_goalscorer") return "First goal";
  if (m === "anytime_assist") return "Anytime assist";
  if (m === "to_score_2_or_more") return "2+ goals";
  if (m === "to_score_3_or_more") return "3+ goals";

  // Fallback — capitalize side but include market for context so it doesn't
  // read as bare "Yes"
  return `${side.charAt(0).toUpperCase() + side.slice(1)} ${m}`;
}

function tierColor(tier: "A" | "B" | "C") {
  if (tier === "A") return "#3ee68a";
  if (tier === "B") return "#f5c062";
  return "#9ca39a";
}

function marketLabel(market: string) {
  if (market === "h2h") return "1X2";
  if (market === "totals") return "O/U";
  if (market === "asian_handicap") return "AH";
  return market;
}

function fmtNum(v: number | null | undefined, digits = 1) {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "—";
}

// Game time / date formatter for the prop + plays cards.
//
// Input: ISO string like "2026-06-01T19:00:00Z" or "2026-06-01 19:00:00+00:00".
// Output: "Sat Jun 1 · 3:00 PM ET" — short weekday, month/day, ET-local time,
// always tagged ET so subscribers in different zones aren't confused by their
// local clock.
function formatGameTime(commenceTime: string | null | undefined): string | null {
  if (!commenceTime) return null;
  try {
    const iso = commenceTime.includes("T")
      ? commenceTime
      : commenceTime.replace(" ", "T");
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return null;
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    // Intl gives "Sat, Jun 1, 3:00 PM" — collapse the commas and append ET
    const raw = fmt.format(d);
    return raw.replace(",", "").replace(",", " ·") + " ET";
  } catch {
    return null;
  }
}

// Translate a raw prop card into the explicit pick the bettor should see.
//
// The model writes model_mean (e.g. 2.34 expected shots) and book_point (e.g.
// 2.5 — the book's line). The pick side is implied by which side of the line
// the model lands on, but the UI never showed that translation — the user
// would see "2.34" with no idea whether to take OVER or UNDER. This helper
// makes the inference explicit.
//
// Markets handled:
//   shots / shots_on_target / passes / tackles → "OVER 2.5 shots" or "UNDER 2.5"
//   anytime_scorer → "Anytime goal" (always a YES bet; model_prob is the
//                    probability)
//   first_scorer → "First goal" (same shape)
//   any unknown market → readable fallback ("Player Goals", etc.)
function formatPropPick(card: PropCard): { headline: string; side: "yes" | "—" } {
  const market = (card.market || "").toLowerCase();
  const line = card.book_point;

  // Yes/No / single-shot markets
  if (market === "anytime_scorer") {
    return { headline: "Anytime goal", side: "yes" };
  }
  if (market === "first_scorer" || market === "first_goalscorer") {
    return { headline: "First goal", side: "yes" };
  }
  // M26 — additional yes/no markets
  if (market === "anytime_assist") {
    return { headline: "Anytime assist", side: "yes" };
  }
  if (market === "to_score_2_or_more") {
    return { headline: "2+ goals", side: "yes" };
  }
  if (market === "to_score_3_or_more") {
    return { headline: "3+ goals", side: "yes" };
  }

  // Count-ladder markets (shots, shots_on_target, etc.). FanDuel et al. sell
  // these as a series of "X+ events YES" props — NOT traditional O/U at
  // 0.5/1.5/2.5 like NBA player points. The backend's _best_tier selector
  // surfaces the tier with the largest model edge; the UI just labels what
  // bet to actually make:  "Saka 2+ shots @ -200"  or  "Ramos 4+ shots @ +250".
  const niceUnit =
    market === "shots" ? "shots" :
    market === "shots_on_target" || market === "sot" ? "shots on target" :
    market === "passes" ? "passes" :
    market === "tackles" ? "tackles" :
    market === "fouls_committed" || market === "fouls" ? "fouls" :
    market === "corners_taken" || market === "corners" ? "corners" :
    market.replace(/_/g, " ");

  // Books quote count markets in two shapes — half-line over/under and
  // whole-number X+. Half-line bets (line ends in .5) read as "Over 2.5
  // shots". Whole-number bets read as "5+ shots". Picking the wrong shape
  // makes the card look broken to anyone who's ever placed a bet.
  if (line != null) {
    const isHalfLine = Math.abs(line - Math.round(line)) > 0.01;
    if (isHalfLine) {
      return { headline: `Over ${line} ${niceUnit}`, side: "yes" };
    }
    return { headline: `${line}+ ${niceUnit}`, side: "yes" };
  }
  return { headline: niceUnit.charAt(0).toUpperCase() + niceUnit.slice(1), side: "—" };
}

// ─── Prose rationale ──────────────────────────────────────────────────────────
//
// Turns the JSON _adj block (xG priors, lineup, defense vulnerability, SoT,
// referee) into plain-English sentences a human bettor can scan.
//
// The full block lives inside candidate.rationale_json as:
//   { source, lambda_h, lambda_a, adjustments: { xg_alpha_h, xg_trace_h, ... } }
//
// Backfill candidates created before M7/M8/M9 deployed will not have these
// fields populated — we return a backfill-specific note so the UI shows the
// caveat instead of pretending there's a rationale to read.

interface RationaleBlock {
  source?: string;
  lambda_h?: number;
  lambda_a?: number;
  adjustments?: {
    raw?: { p_home?: number; p_draw?: number; p_away?: number; over_25?: number; btts?: number };
    shrinkage?: { applied?: boolean; factor_1x2?: number; factor_tot?: number; factor_btts?: number };
    xg_alpha_h?: number; xg_alpha_a?: number;
    xg_delta_h?: number; xg_delta_a?: number;
    xg_trace_h?: { team?: string; matched_dc_name?: string; n_matches?: number;
                   team_xg_for_pg?: number; team_g_for_pg?: number;
                   team_xg_against_pg?: number; team_g_against_pg?: number;
                   reason?: string };
    xg_trace_a?: { team?: string; matched_dc_name?: string; n_matches?: number;
                   team_xg_for_pg?: number; team_g_for_pg?: number;
                   team_xg_against_pg?: number; team_g_against_pg?: number;
                   reason?: string };
    lineup_mult_h?: number; lineup_mult_a?: number;
    lineup_trace_h?: { team?: string; key_attackers_out?: number; reason?: string };
    lineup_trace_a?: { team?: string; key_attackers_out?: number; reason?: string };
    defense_vuln_h?: number; defense_vuln_a?: number;
    defense_trace_h?: { team?: string; key_defenders_out?: number; reason?: string };
    defense_trace_a?: { team?: string; key_defenders_out?: number; reason?: string };
    sot_mult_h?: number; sot_mult_a?: number;
    ref_mult?: number;
  };
  note?: string;
}

function parseRationale(rationaleJson: string | null): RationaleBlock | null {
  if (!rationaleJson) return null;
  try {
    const parsed = JSON.parse(rationaleJson) as RationaleBlock;
    return parsed;
  } catch {
    return null;
  }
}

/** Returns 1–4 short prose lines explaining the model's view of this pick. */
function humanizeRationale(
  rationaleJson: string | null,
  home: string,
  away: string,
  betSide: string,
): string[] {
  const block = parseRationale(rationaleJson);
  if (!block) return [];

  // Backfill rows: created before signal layers existed
  if ((rationaleJson ?? "").includes("backfill")) {
    return ["Backfill pick — generated before the xG / lineup / defense signal layers were live. No driver-level rationale stored."];
  }

  const adj = block.adjustments;
  if (!adj) return [];
  const lines: string[] = [];

  // xG attack signals
  const xgAlphaH = adj.xg_alpha_h ?? 1.0;
  const xgAlphaA = adj.xg_alpha_a ?? 1.0;
  const traceH = adj.xg_trace_h;
  const traceA = adj.xg_trace_a;

  if (xgAlphaH > 1.04 && traceH?.team_xg_for_pg && traceH?.team_g_for_pg) {
    lines.push(
      `${home} is outshooting their goals — ${traceH.team_xg_for_pg.toFixed(2)} xG/match vs ${traceH.team_g_for_pg.toFixed(2)} actual over ${traceH.n_matches ?? "?"} matches. Model regresses attack upward.`,
    );
  } else if (xgAlphaH < 0.96 && traceH?.team_xg_for_pg && traceH?.team_g_for_pg) {
    lines.push(
      `${home} has been finishing above xG (${traceH.team_g_for_pg.toFixed(2)} goals/match on ${traceH.team_xg_for_pg.toFixed(2)} xG). Model regresses attack downward.`,
    );
  }

  if (xgAlphaA > 1.04 && traceA?.team_xg_for_pg && traceA?.team_g_for_pg) {
    lines.push(
      `${away} is outshooting their goals — ${traceA.team_xg_for_pg.toFixed(2)} xG/match vs ${traceA.team_g_for_pg.toFixed(2)} actual over ${traceA.n_matches ?? "?"} matches. Model regresses attack upward.`,
    );
  } else if (xgAlphaA < 0.96 && traceA?.team_xg_for_pg && traceA?.team_g_for_pg) {
    lines.push(
      `${away} has been finishing above xG (${traceA.team_g_for_pg.toFixed(2)} goals/match on ${traceA.team_xg_for_pg.toFixed(2)} xG). Model regresses attack downward.`,
    );
  }

  // xG defense signals
  const xgDeltaH = adj.xg_delta_h ?? 1.0;
  const xgDeltaA = adj.xg_delta_a ?? 1.0;
  if (xgDeltaH > 1.05 && traceH?.team_xg_against_pg && traceH?.team_g_against_pg) {
    lines.push(
      `${home}'s defense has been overperforming xG against (${traceH.team_g_against_pg.toFixed(2)} conceded on ${traceH.team_xg_against_pg.toFixed(2)} expected). Likely to leak more.`,
    );
  }
  if (xgDeltaA > 1.05 && traceA?.team_xg_against_pg && traceA?.team_g_against_pg) {
    lines.push(
      `${away}'s defense has been overperforming xG against (${traceA.team_g_against_pg.toFixed(2)} conceded on ${traceA.team_xg_against_pg.toFixed(2)} expected). Likely to leak more.`,
    );
  }

  // Lineup
  const lineupH = adj.lineup_mult_h ?? 1.0;
  const lineupA = adj.lineup_mult_a ?? 1.0;
  if (lineupH < 0.95 && adj.lineup_trace_h?.key_attackers_out) {
    lines.push(`${home} missing ${adj.lineup_trace_h.key_attackers_out} key attacker${adj.lineup_trace_h.key_attackers_out > 1 ? "s" : ""} — attack downgraded.`);
  }
  if (lineupA < 0.95 && adj.lineup_trace_a?.key_attackers_out) {
    lines.push(`${away} missing ${adj.lineup_trace_a.key_attackers_out} key attacker${adj.lineup_trace_a.key_attackers_out > 1 ? "s" : ""} — attack downgraded.`);
  }

  // Defensive vulnerability (opponent gets boosted lambda against this team)
  const vulnH = adj.defense_vuln_h ?? 1.0;
  const vulnA = adj.defense_vuln_a ?? 1.0;
  if (vulnH > 1.06 && adj.defense_trace_h?.key_defenders_out) {
    lines.push(`${home} missing key defenders — opponent attack boosted.`);
  }
  if (vulnA > 1.06 && adj.defense_trace_a?.key_defenders_out) {
    lines.push(`${away} missing key defenders — opponent attack boosted.`);
  }

  // If nothing fired (all multipliers ≈ 1.0), say so explicitly
  if (lines.length === 0) {
    const allOne = [xgAlphaH, xgAlphaA, xgDeltaH, xgDeltaA, lineupH, lineupA, vulnH, vulnA]
      .every((v) => Math.abs((v ?? 1.0) - 1.0) < 0.02);
    if (allOne) {
      lines.push(`Pick is driven by base Dixon-Coles ratings + shots-on-target form. No xG, lineup, or defensive-availability adjustments fired (data missing or close to baseline).`);
    }
  }

  // Always end with the bet-side framing
  if (betSide === "home") {
    lines.push(`Model favors ${home} more than the market does.`);
  } else if (betSide === "away") {
    lines.push(`Model favors ${away} more than the market does.`);
  } else if (betSide === "draw") {
    lines.push(`Model sees a higher draw probability than the market does.`);
  } else if (betSide === "over" || betSide === "under") {
    lines.push(`Model's expected goals diverges from the market line.`);
  }

  return lines;
}

// ─── Approved Picks dashboard (M24) ─────────────────────────────────────────
//
// All approved picks across all fixtures, with running CLV / W-L / ROI.
// Pulled from /api/ops/approved-picks (no game_id filter so we see every-
// thing). Sits between Match Intelligence and Today's plays as the
// trader's "what's on the ticket right now" view.

interface ApprovedPicksDashboardRow {
  id: number;
  fixture_label: string;
  tournament: string;
  commence_time: string | null;
  market: string;
  side: string;
  bet_label: string;
  stake_units: number;
  opening_price: number;
  opening_book: string;
  edge_pp_at_pick: number;
  closing_price: number | null;
  closing_book: string | null;
  clv_pp: number | null;
  graded_status: string;
  pnl_units: number | null;
}

interface ApprovedPicksDashboardSummary {
  total: number;
  open: number;
  graded: number;
  wins: number;
  losses: number;
  pushes: number;
  win_rate: number | null;
  pnl_units: number;
  staked_units: number;
  roi: number | null;
  avg_clv_pp: number | null;
  clv_sample: number;
}

function ApprovedPicksDashboard() {
  const [rows, setRows] = useState<ApprovedPicksDashboardRow[]>([]);
  const [summary, setSummary] = useState<ApprovedPicksDashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void fetch("/api/ops/approved-picks?limit=50")
      .then((r) => r.json())
      .then((json: { picks?: ApprovedPicksDashboardRow[]; summary?: ApprovedPicksDashboardSummary }) => {
        setRows(json.picks ?? []);
        setSummary(json.summary ?? null);
      })
      .catch(() => { /* silent */ })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <Panel>
        <SectionHead icon={Target} title="Approved picks (all fixtures)" />
        <p className="text-[11px] text-[#4a524a] py-4">Loading…</p>
      </Panel>
    );
  }
  if (rows.length === 0) {
    return (
      <Panel>
        <SectionHead icon={Target} title="Approved picks (all fixtures)" />
        <EmptyState>
          No approved picks yet. Use the Approve button on a Match Intelligence edge above to log one — that's what shows up here.
        </EmptyState>
      </Panel>
    );
  }

  // M30 — Per-fixture exposure check. Picks on the same game are
  // correlated (same xG distribution, same lineups, same ref). We
  // can't bet 5u on PSG ML + 5u on Over 2.5 + 5u on BTTS Yes and
  // pretend they're independent — that's actually a ~12u correlated
  // position. Surface a warning when total stake on a fixture exceeds
  // a sensible cap.
  type FixtureExposure = {
    fixture_label: string;
    n_picks: number;
    total_stake: number;
    max_loss: number;
    max_win: number;  // upper bound; assumes all win
  };
  const exposureByFixture: Record<string, FixtureExposure> = {};
  for (const r of rows) {
    if (r.graded_status !== "open") continue;
    const key = r.fixture_label;
    const decimal = r.opening_price >= 0
      ? r.opening_price / 100 + 1
      : 100 / -r.opening_price + 1;
    const max_win = r.stake_units * (decimal - 1);
    if (!exposureByFixture[key]) {
      exposureByFixture[key] = {
        fixture_label: key,
        n_picks: 0,
        total_stake: 0,
        max_loss: 0,
        max_win: 0,
      };
    }
    exposureByFixture[key].n_picks += 1;
    exposureByFixture[key].total_stake += r.stake_units;
    exposureByFixture[key].max_loss += r.stake_units;   // worst case
    exposureByFixture[key].max_win += max_win;
  }
  const overExposedFixtures = Object.values(exposureByFixture).filter(
    (e) => e.n_picks >= 2 && e.total_stake > 10,  // > 10% of bankroll on one match
  );

  return (
    <Panel>
      <SectionHead
        icon={Target}
        title="Approved picks (all fixtures)"
        right={
          summary && (
            <div className="flex items-center gap-4 text-[10px] text-[#6b7068]">
              <span>{summary.total} total</span>
              <span>{summary.open} open</span>
              <span>{summary.graded} graded</span>
            </div>
          )
        }
      />

      {/* Exposure warning — appears when any fixture has > 10u total across
          multiple correlated picks. */}
      {overExposedFixtures.length > 0 && (
        <div className="mb-4 rounded-lg border border-[#f5c062]/25 bg-[#f5c062]/[0.04] px-4 py-3">
          <p className="text-[10px] uppercase tracking-wider text-[#f5c062] font-bold mb-1.5">
            ⚠ Correlated exposure warning
          </p>
          {overExposedFixtures.map((e) => (
            <p key={e.fixture_label} className="text-[11px] text-[#c4c7c0]">
              <span className="font-semibold">{e.fixture_label}</span>:
              {" "}{e.n_picks} picks · total stake <span className="font-mono text-[#f5c062]">{e.total_stake.toFixed(2)} units</span>
              {" "}· max loss if all fail <span className="font-mono text-[#ef4444]">-{e.max_loss.toFixed(2)} units</span>
              {" "}· max win if all hit <span className="font-mono text-[#3ee68a]">+{e.max_win.toFixed(2)} units</span>
            </p>
          ))}
          <p className="text-[9px] text-[#6b7068] mt-1.5 leading-relaxed">
            Same-fixture picks share xG, lineups, and ref tendency — they're not independent. Consider trimming exposure or only approving the highest-edge market per game.
          </p>
        </div>
      )}

      {/* Summary strip */}
      {summary && (
        <div className="flex gap-3 flex-wrap mb-4">
          <KpiCard
            label="Record"
            value={summary.graded > 0 ? `${summary.wins}–${summary.losses}${summary.pushes ? `–${summary.pushes}P` : ""}` : "—"}
            sub={summary.graded > 0 ? `${fmtPct(summary.win_rate)} win rate` : "no graded yet"}
            color={summary.win_rate !== null && summary.win_rate >= 0.524 ? "#3ee68a" : "#d4d7d0"}
          />
          <KpiCard
            label="P&L"
            value={summary.graded > 0 ? `${summary.pnl_units >= 0 ? "+" : ""}${summary.pnl_units.toFixed(2)} units` : "—"}
            sub={summary.graded > 0 ? `on ${summary.staked_units.toFixed(1)} units staked` : "—"}
            color={summary.pnl_units >= 0 ? "#3ee68a" : "#ef4444"}
          />
          <KpiCard
            label="ROI"
            value={summary.roi !== null ? `${summary.roi >= 0 ? "+" : ""}${(summary.roi * 100).toFixed(1)}%` : "—"}
            color={summary.roi !== null && summary.roi >= 0 ? "#3ee68a" : "#ef4444"}
          />
          <KpiCard
            label="Avg CLV"
            value={summary.avg_clv_pp !== null ? `${summary.avg_clv_pp >= 0 ? "+" : ""}${(summary.avg_clv_pp * 100).toFixed(1)}pp` : "—"}
            sub={summary.avg_clv_pp !== null ? `on ${summary.clv_sample} closed` : "no closes yet"}
            color={summary.avg_clv_pp !== null && summary.avg_clv_pp >= 0 ? "#3ee68a" : "#9ca39a"}
          />
        </div>
      )}

      {/* Pick rows */}
      <div className="rounded-lg border border-[#1a211c] bg-[#0a0d0a] overflow-hidden">
        <div className="grid grid-cols-[1.4fr_1.2fr_64px_88px_84px_84px_80px] gap-2 px-4 py-2.5 border-b border-[#181c18] text-[8px] font-bold uppercase tracking-[0.14em] text-[#2e3328]">
          <span>Fixture</span>
          <span>Pick</span>
          <span className="text-right">Stake</span>
          <span className="text-right">Opening</span>
          <span className="text-right">Close</span>
          <span className="text-right">CLV</span>
          <span className="text-right">P&L</span>
        </div>
        {rows.slice(0, 12).map((r) => {
          const statusColor =
            r.graded_status === "won" ? "#3ee68a" :
            r.graded_status === "lost" ? "#ef4444" :
            r.graded_status === "push" ? "#9ca39a" : "#f5c062";
          return (
            <div key={r.id} className="grid grid-cols-[1.4fr_1.2fr_64px_88px_84px_84px_80px] gap-2 items-center px-4 py-2 border-b border-[#0d100d] last:border-0 hover:bg-[#0f1310] transition-colors text-[10px]">
              <div className="min-w-0">
                <p className="text-[#c4c7c0] truncate">{r.fixture_label}</p>
                <p className="text-[9px] text-[#4a524a]">{r.tournament} · {formatGameTime(r.commence_time) ?? r.commence_time?.slice(0, 10)}</p>
              </div>
              <div className="min-w-0">
                <p className="font-semibold text-white truncate">{r.bet_label}</p>
                <p className="text-[9px] text-[#6b7068] font-mono">
                  edge {r.edge_pp_at_pick >= 0 ? "+" : ""}{(r.edge_pp_at_pick * 100).toFixed(1)}pp
                </p>
              </div>
              <span className="text-right font-bold text-[#3ee68a]">{stakeSizeLabel(r.stake_units)}</span>
              <span className="text-right font-mono text-[#9ca39a]">
                {r.opening_book} {r.opening_price >= 0 ? "+" : ""}{r.opening_price}
              </span>
              <span className="text-right font-mono">
                {r.closing_price !== null ? (
                  <span className="text-[#9ca39a]">
                    {r.closing_book} {r.closing_price >= 0 ? "+" : ""}{r.closing_price}
                  </span>
                ) : <span className="text-[#3a4033]">—</span>}
              </span>
              <span className="text-right font-mono font-bold">
                {r.clv_pp !== null ? (
                  <span style={{ color: r.clv_pp >= 0 ? "#3ee68a" : "#ef4444" }}>
                    {r.clv_pp >= 0 ? "+" : ""}{(r.clv_pp * 100).toFixed(1)}pp
                  </span>
                ) : <span className="text-[#3a4033]">—</span>}
              </span>
              <span className="text-right font-mono font-bold" style={{ color: statusColor }}>
                {r.graded_status === "open" ? "open" :
                 r.pnl_units !== null
                  ? `${r.pnl_units >= 0 ? "+" : ""}${r.pnl_units.toFixed(2)} units`
                  : r.graded_status}
              </span>
            </div>
          );
        })}
      </div>

      {rows.length > 12 && (
        <p className="text-[9px] text-[#3a4033] mt-2 text-center">
          Showing 12 of {rows.length} approved picks
        </p>
      )}

      <p className="text-[10px] text-[#3a4033] mt-3 leading-relaxed">
        CLV is the closing-line value — positive means the market moved TOWARD your pick after you took it (you beat the close).
        That's the strongest signal of long-term edge regardless of short-term variance.
      </p>
    </Panel>
  );
}


// ─── Featured Pick (M33) — the single thing worth your attention ────────────
//
// The Match Intelligence panel below shows EVERY market the model has an
// opinion on, including markets the backtest says lose money. That's useful
// for engine debugging but confusing for "what should I bet right now?"
//
// FeaturedPick is the clean version. It does ONE thing:
//   1. Loads the featured fixture (UCL final today; rolls forward later).
//   2. Walks the model's edges.
//   3. Keeps ONLY edges where MARKET_VERDICTS says the bucket is backtest-
//      validated as a bet.
//   4. Shows the single highest-edge candidate in plain English, with the
//      stake, the model-vs-market math, the backtest receipt, and an
//      Approve button.
//   5. If nothing's validated, says so honestly — no fake "lean" cards
//      from markets we haven't proven.

function FeaturedPickPanel() {
  const [fixture, setFixture] = useState<FeaturedFixture | null>(null);
  const [fixtureResolved, setFixtureResolved] = useState(false);
  const [data, setData] = useState<MatchIntelResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [approved, setApproved] = useState<Record<string, ApprovedPick>>({});
  const [approving, setApproving] = useState<string | null>(null);
  const [approveError, setApproveError] = useState<string | null>(null);

  // No hardcoded fallback fixture. When the live scan finds no upcoming
  // fixture we show an honest empty state instead of resurrecting the
  // long-settled UCL final. `fixtureResolved` distinguishes "still loading"
  // from "loaded, nothing to feature".
  const activeGameId = fixture?.game_id ?? "";

  // 1. Fixture
  useEffect(() => {
    void fetch("/api/ops/featured-fixture")
      .then((r) => r.json())
      .then((json: { ok?: boolean; fixture?: FeaturedFixture }) => {
        setFixture(json.ok && json.fixture ? json.fixture : null);
      })
      .catch(() => setFixture(null))
      .finally(() => setFixtureResolved(true));
  }, []);

  // 2. Match intelligence
  useEffect(() => {
    if (!fixture) return;
    const u = new URLSearchParams({
      home: fixture.home,
      away: fixture.away,
      home_league: fixture.home_league,
      away_league: fixture.away_league,
      tournament: fixture.tournament,
      neutral_venue: fixture.neutral_venue ? "1" : "0",
      competition_stage: fixture.competition_stage,
    });
    if (fixture.commence_time) u.set("commence_time", fixture.commence_time);
    if (fixture.game_id) u.set("game_id", fixture.game_id);
    setLoading(true);
    void fetch(`/api/ops/match-intelligence?${u.toString()}`)
      .then((r) => r.json())
      .then((json: MatchIntelResponse) => setData(json))
      .catch(() => setData({ error: "fetch failed" }))
      .finally(() => setLoading(false));
    void fetch(`/api/ops/approved-picks?game_id=${activeGameId}&limit=20`)
      .then((r) => r.json())
      .then((json: { picks?: Array<Record<string, unknown>> }) => {
        const idx: Record<string, ApprovedPick> = {};
        for (const p of json.picks ?? []) {
          const key = `${p.market}|${p.side}`;
          idx[key] = {
            market: String(p.market),
            side: String(p.side),
            bet_label: String(p.bet_label),
            stake_units: Number(p.stake_units),
            opening_price: Number(p.opening_price),
            opening_book: String(p.opening_book),
            edge_pp_at_pick: Number(p.edge_pp_at_pick),
            closing_price: p.closing_price === null || p.closing_price === undefined ? null : Number(p.closing_price),
            closing_book:  p.closing_book === null || p.closing_book === undefined ? null : String(p.closing_book),
            clv_pp:        p.clv_pp === null || p.clv_pp === undefined ? null : Number(p.clv_pp),
            graded_status: String(p.graded_status ?? "open"),
            pnl_units:     p.pnl_units === null || p.pnl_units === undefined ? null : Number(p.pnl_units),
          };
        }
        setApproved(idx);
      })
      .catch(() => { /* silent */ });
  }, [fixture, activeGameId]);

  async function approve(edge: MatchIntelEdge, betLabel: string) {
    if (!data?.fixture || !fixture) return;
    const key = `${edge.market}|${edge.side}`;
    setApproving(key);
    setApproveError(null);
    try {
      const res = await fetch("/api/ops/approved-picks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          game_id: activeGameId,
          market: edge.market,
          side: edge.side,
          bet_label: betLabel,
          model_prob: edge.model_prob,
          best_price: edge.best_price,
          best_book: edge.best_book,
          fixture_label: `${data.fixture.home} vs ${data.fixture.away} · ${data.fixture.tournament}`,
          tournament: data.fixture.tournament,
          commence_time: data.fixture.commence_time,
          lineup_status: "projected",
        }),
      });
      const json = await res.json();
      if (!json.ok) {
        setApproveError(json.error ?? "approval failed");
      } else {
        // Refresh approved picks
        void fetch(`/api/ops/approved-picks?game_id=${activeGameId}&limit=20`)
          .then((r) => r.json())
          .then((json2: { picks?: Array<Record<string, unknown>> }) => {
            const idx: Record<string, ApprovedPick> = {};
            for (const p of json2.picks ?? []) {
              const k = `${p.market}|${p.side}`;
              idx[k] = {
                market: String(p.market), side: String(p.side),
                bet_label: String(p.bet_label),
                stake_units: Number(p.stake_units),
                opening_price: Number(p.opening_price),
                opening_book: String(p.opening_book),
                edge_pp_at_pick: Number(p.edge_pp_at_pick),
                closing_price: null, closing_book: null, clv_pp: null,
                graded_status: "open", pnl_units: null,
              };
            }
            setApproved(idx);
          });
      }
    } catch (e) {
      setApproveError(e instanceof Error ? e.message : "approval failed");
    } finally {
      setApproving(null);
    }
  }

  // Honest empty state — no upcoming fixture to feature (between slates).
  if (fixtureResolved && !fixture) {
    return (
      <Panel>
        <SectionHead icon={Brain} title="Featured pick" />
        <p className="text-[11px] text-[#6b7068] py-4 leading-relaxed">
          No upcoming fixture to feature right now. The board is between slates —
          the World Cup kicks off June 11.
        </p>
      </Panel>
    );
  }
  if (loading || !data || !data.fixture || !data.model) {
    return (
      <Panel>
        <SectionHead icon={Brain} title="Featured pick" />
        <p className="text-[11px] text-[#4a524a] py-4">Computing…</p>
      </Panel>
    );
  }

  const home = data.fixture.home;
  const away = data.fixture.away;
  const allEdges = data.edges?.edges ?? [];

  // Filter to backtest-validated bets only (the honest cut).
  const isNeutralFixture = data.fixture.neutral_venue === true;
  const validatedEdges = allEdges.filter((e) => {
    const verdict = getVerdict(e.market, e.side);
    if (!verdict || verdict.status !== "bet") return false;
    // Downgrade non-neutral-only verdicts when fixture is neutral
    if (
      isNeutralFixture &&
      (verdict.note ?? "").toLowerCase().includes("non-neutral")
    ) {
      return false;
    }
    // Must be positive edge
    return e.edge_pp > 0;
  });

  // Sort by edge desc, take the top one
  validatedEdges.sort((a, b) => b.edge_pp - a.edge_pp);
  const featured = validatedEdges[0] ?? null;

  // What betLabel to display + approve under?
  const featuredLabel = featured ? (
    featured.market === "1X2" && featured.side === "draw" ? "Draw"
    : featured.market === "1X2" && featured.side === "home" ? `${home} to win`
    : featured.market === "1X2" && featured.side === "away" ? `${away} to win`
    : featured.market === "Totals 2.5" ? `${featured.side === "over" ? "Over" : "Under"} 2.5 goals`
    : featured.market === "BTTS" ? `BTTS ${featured.side}`
    : `${featured.side} ${featured.market}`
  ) : "";

  const featuredVerdict = featured ? getVerdict(featured.market, featured.side) : null;
  const featuredKey = featured ? `${featured.market}|${featured.side}` : "";
  const featuredApproved = featured ? approved[featuredKey] : null;

  // Kelly preview (illustrative — backend recomputes when you approve)
  function kellyPreview(modelProb: number, american: number): number {
    const dec = american >= 0 ? american / 100 + 1 : 100 / -american + 1;
    const edge = modelProb * dec - 1;
    if (edge <= 0) return 0;
    const kellyFull = edge / (dec - 1);
    return Math.min(5.0, kellyFull * 0.25 * 100);
  }

  // Lineup-freshness chip data
  const lf = data.lineup_freshness;
  const lfColor =
    lf?.tier === "green" ? "#3ee68a" :
    lf?.tier === "amber" ? "#f5c062" : "#ef4444";
  const lfLabel =
    lf?.tier === "green" ? "Confirmed XI" :
    lf?.tier === "amber" ? "Projected XI" : "No lineup";

  return (
    <Panel>
      <SectionHead
        icon={Brain}
        title="Featured pick"
        right={
          <div className="flex items-center gap-3 text-[10px]">
            {lf && (
              <span
                className="flex items-center gap-1.5 px-2 py-0.5 rounded-full border"
                style={{ borderColor: lfColor + "33", background: lfColor + "0c", color: lfColor }}
                title={lf.reason}
              >
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: lfColor }} />
                <span className="font-bold tracking-wider">{lfLabel}</span>
              </span>
            )}
            {data.odds_meta?.refreshed_at && (() => {
              const ageMin = Math.max(0, Math.round((Date.now() - new Date(data.odds_meta.refreshed_at).getTime()) / 60_000));
              const c = ageMin < 5 ? "#3ee68a" : ageMin < 30 ? "#f5c062" : "#ef4444";
              return <span className="font-mono" style={{ color: c }}>odds {ageMin}m old</span>;
            })()}
          </div>
        }
      />

      {/* Fixture line */}
      <p className="text-[10px] text-[#6b7068] mb-1">
        {data.fixture.tournament} · {formatGameTime(data.fixture.commence_time) ?? "TBD"}
        {data.fixture.neutral_venue ? " · neutral venue" : ""}
      </p>
      <p className="text-[16px] font-black text-white mb-5">
        {home} <span className="text-[#6b7068] font-normal">vs</span> {away}
      </p>

      {featured ? (
        <>
          {/* The bet */}
          <div className="rounded-xl border border-[#3ee68a]/25 bg-[#3ee68a]/[0.04] p-5 mb-4">
            <p className="text-[10px] uppercase tracking-[0.2em] text-[#3ee68a] mb-1.5 font-bold">
              Bet
            </p>
            <p className="text-[24px] font-black text-white leading-none mb-1.5">
              {featuredLabel}
            </p>
            <p className="text-[12px] text-[#9ca39a] font-mono">
              {featured.best_book} {featured.best_price !== null && (featured.best_price >= 0 ? `+${featured.best_price}` : featured.best_price)}
              {" · "}
              <span className="text-[#3ee68a] font-bold">
                {stakeSizeLabel(kellyPreview(featured.model_prob, featured.best_price ?? 0))}
              </span>
              <span className="text-[#4a524a]"> — {stakeSizeExplain(kellyPreview(featured.model_prob, featured.best_price ?? 0))}</span>
            </p>
          </div>

          {/* Plain-English read — no pp / λ / mono jargon. */}
          <div className="space-y-2 mb-4 text-[13px] leading-relaxed text-[#c4c7c0]">
            <p>
              Our model gives this about{" "}
              <span className="font-bold text-white">
                {Math.round(featured.model_prob * 100)}%
              </span>
              {" "}to hit.
            </p>
            <p>
              The market is pricing it around{" "}
              <span className="text-[#9ca39a]">
                {Math.round(featured.implied_prob * 100)}%
              </span>.
            </p>
            <p>
              That's about a{" "}
              <span className="font-bold text-[#3ee68a]">
                {Math.round(featured.edge_pp * 100)}-point
              </span>{" "}
              edge for our side —{" "}
              <span className="font-semibold text-white">
                {confidenceFromEdge(featured.edge_pp).toLowerCase()}
              </span>.
            </p>
          </div>

          {/* Backtest receipt — the honesty layer */}
          {featuredVerdict && featuredVerdict.status === "bet" && (
            <div className="rounded-lg border border-[#181c18] bg-[#0a0d0a] p-3 mb-4 text-[11px] leading-relaxed">
              <p className="text-[9px] uppercase tracking-wider text-[#4a524a] mb-1.5 font-bold">
                Backtest receipt
              </p>
              <p className="text-[#9ca39a]">
                We tested this market on{" "}
                <span className="text-white font-mono">{featuredVerdict.n}</span> historical Big-5 matches.
                {" "}Flat-betting every tier-A edge returned{" "}
                <span className="text-[#3ee68a] font-bold font-mono">+{((featuredVerdict.roi ?? 0) * 100).toFixed(1)}% ROI</span>
                {" "}vs Pinnacle closing line.
              </p>
              {featuredVerdict.note && (
                <p className="text-[#6b7068] text-[10px] mt-1.5">{featuredVerdict.note}</p>
              )}
            </div>
          )}

          {/* Action */}
          {featuredApproved ? (
            <div className="rounded-lg border border-[#3ee68a]/30 bg-[#3ee68a]/[0.06] px-4 py-3 flex items-center justify-between">
              <div>
                <p className="text-[9px] uppercase tracking-wider text-[#4a524a]">
                  {featuredApproved.graded_status === "won" ? "Won" :
                   featuredApproved.graded_status === "lost" ? "Lost" :
                   featuredApproved.graded_status === "push" ? "Push" : "On your ticket"}
                </p>
                <p className="text-[15px] font-black text-[#3ee68a]">
                  {stakeSizeLabel(featuredApproved.stake_units)}
                  {featuredApproved.pnl_units !== null && (
                    <span className="ml-2 text-[11px] font-mono text-white">
                      ({featuredApproved.pnl_units >= 0 ? "+" : ""}{featuredApproved.pnl_units.toFixed(2)} units)
                    </span>
                  )}
                </p>
              </div>
              {featuredApproved.clv_pp !== null && (
                <div className="text-right">
                  <p className="text-[9px] uppercase tracking-wider text-[#4a524a]" title="Closing line value — did the market move toward our side after we picked?">
                    Line move
                  </p>
                  <p className="text-[13px] font-bold"
                     style={{ color: featuredApproved.clv_pp >= 0 ? "#3ee68a" : "#ef4444" }}>
                    {featuredApproved.clv_pp >= 0 ? "+" : ""}{Math.round(featuredApproved.clv_pp * 100)} points
                  </p>
                </div>
              )}
            </div>
          ) : (
            <button
              onClick={() => approve(featured, featuredLabel)}
              disabled={approving === featuredKey}
              className="w-full rounded-lg border border-[#3ee68a]/40 bg-[#3ee68a]/[0.08] px-4 py-3 text-[13px] font-bold uppercase tracking-wider text-[#3ee68a] hover:bg-[#3ee68a]/[0.15] disabled:opacity-40 transition-colors"
            >
              {approving === featuredKey ? "Approving…" : `Approve · ${stakeSizeLabel(kellyPreview(featured.model_prob, featured.best_price ?? 0))}`}
            </button>
          )}

          {approveError && (
            <p className="mt-2 text-[10px] text-[#ef4444]">Approval error: {approveError}</p>
          )}
        </>
      ) : (
        // No validated bet right now — honest about it.
        <div className="rounded-xl border border-[#1a211c] bg-[#0a0d0a] p-6">
          <p className="text-[14px] font-bold text-[#c4c7c0] mb-2">
            No validated picks right now.
          </p>
          <p className="text-[11px] text-[#9ca39a] leading-relaxed">
            The model has opinions on every market for {home} vs {away}, but none of them currently sit at a backtest-validated edge. The only markets we've proven against Pinnacle close are 1X2 away (non-neutral) and Totals 2.5 — neither is showing a positive edge here.
          </p>
          <p className="text-[10px] text-[#6b7068] leading-relaxed mt-3">
            To see the model's full opinion (including unvalidated markets like BTTS / corners / 1X2 home / draw / shots), open <span className="text-[#9ca39a]">Diagnostics</span> below.
          </p>
        </div>
      )}
    </Panel>
  );
}


// ─── Match Intelligence (per-fixture trading-desk view) ─────────────────────
//
// Product direction (M17): treat soccer picks as a football intelligence +
// trading desk system. For each "feature match" we surface the FULL picture:
// our model's fair probabilities for every market we have signal on
// (1X2, Totals 2.5, BTTS), the best book prices, the edges with confidence
// tiers, and the data drivers (xG window per team, adjustments fired).
//
// This panel sits ABOVE Today's plays because it's the trader's first view:
// "here's what we think this match looks like; here's where the market
// disagrees enough to bet."

interface MatchIntelEdge {
  market: string;
  side: string;
  model_prob: number;
  implied_prob: number;
  edge_pp: number;
  best_book: string | null;
  best_price: number | null;
  tier: "A" | "B" | "C" | "pass";
}

interface MatchIntelResponse {
  fixture?: {
    home: string;
    away: string;
    tournament: string;
    commence_time: string | null;
    game_id: string | null;
    neutral_venue: boolean;
  };
  model?: {
    lambda_h: number;
    lambda_a: number;
    p_home_win: number;
    p_draw: number;
    p_away_win: number;
    p_over_25: number;
    p_under_25: number;
    p_btts_yes: number;
    p_btts_no: number;
    p_home_over_15_raw: number;
    p_away_over_15_raw: number;
  };
  corners?: {
    lambda_total_corners: number;
    home_team_corners: number;
    away_team_corners: number;
    p_over_8_5: number;  p_under_8_5: number;
    p_over_9_5: number;  p_under_9_5: number;
    p_over_10_5: number; p_under_10_5: number;
    p_over_11_5: number; p_under_11_5: number;
  };
  drivers?: {
    home_xg_window?: { team: string; n_matches: number; xg_for_pg: number; xg_against_pg: number; goals_for_pg: number };
    away_xg_window?: { team: string; n_matches: number; xg_for_pg: number; xg_against_pg: number; goals_for_pg: number };
    adjustments?: Record<string, unknown>;
  };
  edges?: { edges: MatchIntelEdge[] };
  odds_meta?: {
    source: string;
    refreshed_at: string | null;
    n_books: number;
  };
  lineup_freshness?: {
    tier: "green" | "amber" | "red";
    reason: string;
    n_players?: number;
    latest_updated?: string | null;
    age_minutes?: number | null;
    minutes_to_kickoff?: number | null;
    has_confirmed?: boolean;
    has_projected?: boolean;
  };
  error?: string;
}


// Per-market verdict from the leakage-free V2 backtest — the single citable
// source is docs/SOCCER_MODEL_BACKTEST_V2.md. Drives the badge on each market
// row AND gates one-click approval: ONLY "bet" (proven) markets are approvable.
// ROI numbers are held-out test-set ROI at the 5pp edge tier.
//   bet          → proven profitable on a clean held-out test
//   experimental → tested, NOT proven (promising-but-noise / thin sample)
//   loses        → tested, loses to the market — not a bet
//   untested     → not yet backtested
type MarketVerdict =
  | { status: "bet"; roi: number; n: number; note?: string }
  | { status: "loses"; roi: number; n: number; note?: string }
  | { status: "experimental"; note?: string }
  | { status: "untested"; note?: string };

const MARKET_VERDICTS: Record<string, MarketVerdict> = {
  "Totals 2.5|over":  { status: "bet",   roi:  0.0883, n: 36, note: "The ONLY proven market. Leakage-free V2 backtest; ROI rises monotonically with edge — the signature of a real edge." },
  "Totals 2.5|under": { status: "loses", roi: -0.0997, n: 37, note: "V2: loses across thresholds." },
  "1X2|home":         { status: "loses", roi: -0.1525, n: 59, note: "V2: model not bettable on the moneyline." },
  "1X2|draw":         { status: "loses", roi: -0.2778, n:  9, note: "V2: worst bucket, tiny sample." },
  "1X2|away":         { status: "loses", roi: -0.2121, n: 19, note: "V2: loses — NOT a bet (corrects a prior stale +12.9% claim)." },
  "BTTS|yes":         { status: "experimental", note: "Tested on Sportmonks closing odds (M48): positive but thin sample — not proven." },
  "BTTS|no":          { status: "experimental", note: "Tested: clears 5pp but loses at 3pp = single-threshold noise, not proven." },
  "Corners 9.5|over": { status: "loses", roi: -0.045, n: 17528, note: "Conclusively not proven (R1): rolling + pressure models both lose to the corners market." },
  "Corners 9.5|under":{ status: "loses", roi: -0.045, n: 17528, note: "Conclusively not proven (R1)." },
};

function getVerdict(market: string, side: string): MarketVerdict | null {
  return MARKET_VERDICTS[`${market}|${side}`] ?? null;
}

// Break-even American odds for a given model probability.
// At break-even the book's implied probability EQUALS our model's
// probability, so the bettor gets exactly 0 edge. This is the line we'd
// need to see at the book to be tempted to bet THIS side.
//
//   model_prob > 0.5 → odds are negative (favorite); -100 * p / (1-p)
//   model_prob < 0.5 → odds are positive (underdog); +100 * (1-p) / p
//
// Caveats: doesn't account for vig — books quote both sides above the
// break-even line in their favor. Treat as the "fair" line; real
// bettable odds need a buffer.
function modelProbToBreakEvenAmerican(p: number): number | null {
  if (p <= 0 || p >= 1) return null;
  if (p >= 0.5) {
    return Math.round(-100 * p / (1 - p));
  }
  return Math.round(100 * (1 - p) / p);
}

function fmtAmericanWithSign(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

interface ApprovedPick {
  market: string;
  side: string;
  bet_label: string;
  stake_units: number;
  opening_price: number;
  opening_book: string;
  edge_pp_at_pick: number;
  closing_price: number | null;
  closing_book: string | null;
  clv_pp: number | null;
  graded_status: string;
  pnl_units: number | null;
}

interface FeaturedFixture {
  home: string;
  away: string;
  commence_time: string | null;
  game_id: string | null;
  sport_key: string;
  tournament: string;
  home_league: string;
  away_league: string;
  neutral_venue: boolean;
  competition_stage: string;
}

function MatchIntelligencePanel() {
  // Auto-pick the next "feature match" from /api/ops/featured-fixture
  // (M28). Falls back to PSG vs Arsenal UCL final if the endpoint fails
  // OR the selected fixture is the UCL final itself.
  const [fixture, setFixture] = useState<FeaturedFixture | null>(null);
  const [fixtureResolved, setFixtureResolved] = useState(false);
  const [data, setData] = useState<MatchIntelResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [approved, setApproved] = useState<Record<string, ApprovedPick>>({});
  const [approving, setApproving] = useState<string | null>(null);
  const [approveError, setApproveError] = useState<string | null>(null);

  // No hardcoded fallback fixture — when the live scan finds nothing we show
  // an honest empty state, never the long-settled UCL final.
  const activeGameId = fixture?.game_id ?? "";

  const reloadApproved = useCallback(() => {
    void fetch(`/api/ops/approved-picks?game_id=${activeGameId}&limit=20`)
      .then((r) => r.json())
      .then((json: { picks?: Array<Record<string, unknown>> }) => {
        const idx: Record<string, ApprovedPick> = {};
        for (const p of json.picks ?? []) {
          const key = `${p.market}|${p.side}`;
          idx[key] = {
            market: String(p.market),
            side: String(p.side),
            bet_label: String(p.bet_label),
            stake_units: Number(p.stake_units),
            opening_price: Number(p.opening_price),
            opening_book: String(p.opening_book),
            edge_pp_at_pick: Number(p.edge_pp_at_pick),
            closing_price: p.closing_price === null || p.closing_price === undefined ? null : Number(p.closing_price),
            closing_book:  p.closing_book === null || p.closing_book === undefined ? null : String(p.closing_book),
            clv_pp:        p.clv_pp === null || p.clv_pp === undefined ? null : Number(p.clv_pp),
            graded_status: String(p.graded_status ?? "open"),
            pnl_units:     p.pnl_units === null || p.pnl_units === undefined ? null : Number(p.pnl_units),
          };
        }
        setApproved(idx);
      })
      .catch(() => { /* silent */ });
  }, [activeGameId]);

  // Step 1: resolve the featured fixture
  useEffect(() => {
    void fetch("/api/ops/featured-fixture")
      .then((r) => r.json())
      .then((json: { ok?: boolean; fixture?: FeaturedFixture }) => {
        setFixture(json.ok && json.fixture ? json.fixture : null);
      })
      .catch(() => setFixture(null))
      .finally(() => setFixtureResolved(true));
  }, []);

  // Step 2: once we have a fixture, load match intelligence + approved picks
  useEffect(() => {
    if (!fixture) return;
    const u = new URLSearchParams({
      home: fixture.home,
      away: fixture.away,
      home_league: fixture.home_league,
      away_league: fixture.away_league,
      tournament: fixture.tournament,
      neutral_venue: fixture.neutral_venue ? "1" : "0",
      competition_stage: fixture.competition_stage,
    });
    if (fixture.commence_time) u.set("commence_time", fixture.commence_time);
    if (fixture.game_id) u.set("game_id", fixture.game_id);
    setLoading(true);
    void fetch(`/api/ops/match-intelligence?${u.toString()}`)
      .then((r) => r.json())
      .then((json: MatchIntelResponse) => setData(json))
      .catch(() => setData({ error: "fetch failed" }))
      .finally(() => setLoading(false));
    reloadApproved();
  }, [fixture, reloadApproved]);

  async function approve(edge: MatchIntelEdge, betLabel: string) {
    if (!data?.fixture) return;
    const key = `${edge.market}|${edge.side}`;
    setApproving(key);
    setApproveError(null);
    try {
      const res = await fetch("/api/ops/approved-picks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          game_id: activeGameId,
          market: edge.market,
          side: edge.side,
          bet_label: betLabel,
          model_prob: edge.model_prob,
          best_price: edge.best_price,
          best_book: edge.best_book,
          fixture_label: `${data.fixture.home} vs ${data.fixture.away} · ${data.fixture.tournament}`,
          tournament: data.fixture.tournament,
          commence_time: data.fixture.commence_time,
          lineup_status: "projected",
        }),
      });
      const json = await res.json();
      if (!json.ok) {
        setApproveError(json.error ?? "approval failed");
      } else {
        reloadApproved();
      }
    } catch (e) {
      setApproveError(e instanceof Error ? e.message : "approval failed");
    } finally {
      setApproving(null);
    }
  }

  // Honest empty state — no upcoming fixture to analyze (between slates).
  if (fixtureResolved && !fixture) {
    return (
      <Panel>
        <SectionHead icon={Brain} title="Match Intelligence" />
        <p className="text-[11px] text-[#6b7068] py-4 leading-relaxed">
          No upcoming fixture to analyze right now. The board is between slates —
          the World Cup kicks off June 11.
        </p>
      </Panel>
    );
  }
  if (loading) {
    return (
      <Panel>
        <SectionHead icon={Brain} title="Match Intelligence" />
        <p className="text-[11px] text-[#4a524a] py-4">Computing model probabilities…</p>
      </Panel>
    );
  }
  if (!data || data.error || !data.model || !data.fixture) {
    return (
      <Panel>
        <SectionHead icon={Brain} title="Match Intelligence" />
        <p className="text-[11px] text-[#ef4444] py-4">
          {data?.error ?? "No intelligence data yet"}
        </p>
      </Panel>
    );
  }

  const m = data.model;
  const home = data.fixture.home;
  const away = data.fixture.away;
  const homeXg = data.drivers?.home_xg_window;
  const awayXg = data.drivers?.away_xg_window;
  const edges = data.edges?.edges ?? [];

  // Build the market grid — one row per market, three columns (our prob,
  // best book + price, edge / tier). Markets shown in trading-desk order.
  const corners = data.corners;
  const marketRows = [
    {
      market: "1X2",
      sides: [
        { label: home,                   prob: m.p_home_win, edge: edges.find(e => e.market === "1X2" && e.side === "home") },
        { label: "Draw",                 prob: m.p_draw,     edge: edges.find(e => e.market === "1X2" && e.side === "draw") },
        { label: away,                   prob: m.p_away_win, edge: edges.find(e => e.market === "1X2" && e.side === "away") },
      ],
    },
    {
      market: "Totals 2.5",
      sides: [
        { label: "Over",  prob: m.p_over_25,  edge: edges.find(e => e.market === "Totals 2.5" && e.side === "over") },
        { label: "Under", prob: m.p_under_25, edge: edges.find(e => e.market === "Totals 2.5" && e.side === "under") },
      ],
    },
    {
      market: "BTTS",
      sides: [
        { label: "Yes", prob: m.p_btts_yes, edge: edges.find(e => e.market === "BTTS" && e.side === "yes") },
        { label: "No",  prob: m.p_btts_no,  edge: edges.find(e => e.market === "BTTS" && e.side === "no") },
      ],
    },
    // Corners (M23). Books typically post 9.5 or 10.5 as the popular line —
    // we show 9.5 here. No edge layer yet because our Odds API pull doesn't
    // include the corners market (M23 follow-up to add fetchers). The row
    // surfaces the model's view alongside the badges so the trader can
    // eyeball it vs whatever line a book offers.
    ...(corners ? [{
      market: "Corners 9.5",
      sides: [
        { label: "Over",  prob: corners.p_over_9_5,  edge: undefined as MatchIntelEdge | undefined },
        { label: "Under", prob: corners.p_under_9_5, edge: undefined as MatchIntelEdge | undefined },
      ],
    }] : []),
  ];

  // Lineup-freshness traffic light. Green = fresh confirmed XI, amber =
  // projected or stale-ish confirmed, red = nothing trustworthy. Drives
  // how much the bettor should weight M7/M8 in the model output.
  const lf = data.lineup_freshness;
  const lfColor =
    lf?.tier === "green" ? "#3ee68a" :
    lf?.tier === "amber" ? "#f5c062" : "#ef4444";
  const lfLabel =
    lf?.tier === "green" ? "Confirmed XI" :
    lf?.tier === "amber" ? "Projected XI" : "No lineup";

  return (
    <Panel>
      <SectionHead
        icon={Brain}
        title="Match Intelligence"
        right={
          <div className="flex items-center gap-3 text-[10px]">
            {lf && (
              <span
                className="flex items-center gap-1.5 px-2 py-0.5 rounded-full border"
                style={{
                  borderColor: lfColor + "33",
                  background: lfColor + "0c",
                  color: lfColor,
                }}
                title={lf.reason}
              >
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: lfColor }} />
                <span className="font-bold tracking-wider">{lfLabel}</span>
                {lf.age_minutes != null && (
                  <span className="text-[#6b7068]">· {lf.age_minutes < 60 ? `${lf.age_minutes}m` : `${Math.round(lf.age_minutes / 60)}h`} ago</span>
                )}
              </span>
            )}
            <span className="text-[#6b7068]">
              {data.fixture.tournament} · {formatGameTime(data.fixture.commence_time) ?? "TBD"}
              {data.fixture.neutral_venue ? " · neutral" : ""}
            </span>
          </div>
        }
      />

      {/* Fixture headline */}
      <div className="mb-4">
        <p className="text-[18px] font-black text-white">
          {home} <span className="text-[#6b7068]">vs</span> {away}
        </p>
        <p className="text-[11px] text-[#9ca39a] mt-1">
          Model: <span className="font-mono text-[#3ee68a]">λ_H {m.lambda_h.toFixed(2)}</span>
          <span className="text-[#3a4033] mx-1.5">·</span>
          <span className="font-mono text-[#3ee68a]">λ_A {m.lambda_a.toFixed(2)}</span>
          <span className="text-[#3a4033] mx-1.5">·</span>
          expected total goals <span className="font-mono text-[#c4c7c0]">{(m.lambda_h + m.lambda_a).toFixed(2)}</span>
        </p>
        {/* Odds freshness — books refresh at different cadences, so we
            surface the most-recent stamp. The trader can see whether the
            edges are 30 seconds stale vs 20 minutes stale before approving. */}
        {data.odds_meta?.refreshed_at && (() => {
          const ageMs = Date.now() - new Date(data.odds_meta.refreshed_at).getTime();
          const ageMin = Math.max(0, Math.round(ageMs / 60_000));
          const color = ageMin < 5 ? "#3ee68a" : ageMin < 30 ? "#f5c062" : "#ef4444";
          return (
            <p className="text-[9px] mt-1 font-mono" style={{ color }}>
              odds refreshed {ageMin < 1 ? "just now" : `${ageMin}m ago`}
              <span className="text-[#4a524a]"> · {data.odds_meta.n_books} books</span>
            </p>
          );
        })()}
      </div>

      {/* Market grid */}
      <div className="space-y-3 mb-5">
        {marketRows.map((row) => (
          <div key={row.market} className="rounded-lg border border-[#1a211c] bg-[#0a0d0a]">
            <div className="flex items-center gap-2 px-4 py-2 border-b border-[#181c18]">
              <p className="text-[10px] font-bold uppercase tracking-wider text-[#9ca39a]">{row.market}</p>
            </div>
            <div className={`grid gap-0 ${row.sides.length === 3 ? "grid-cols-3" : "grid-cols-2"}`}>
              {row.sides.map((s, i) => {
                const tierColor =
                  s.edge?.tier === "A" ? "#3ee68a" :
                  s.edge?.tier === "B" ? "#f5c062" :
                  s.edge?.tier === "C" ? "#9ca39a" : "#3a4033";
                const edgeKey = s.edge ? `${s.edge.market}|${s.edge.side}` : "";
                const isApproved = edgeKey ? !!approved[edgeKey] : false;
                const approvedRow = isApproved ? approved[edgeKey] : null;
                const verdict = s.edge ? getVerdict(s.edge.market, s.edge.side) : null;
                // Only allow approval on backtest-validated markets.
                // Markets that lose in backtest are flagged but un-approvable;
                // untested markets show a yellow warning + still allow but
                // with friction. UCL final is neutral venue, so "1X2 away"
                // bettable only in non-neutral fixtures has its verdict
                // downgraded to "untested" at neutral venue.
                const isNeutralFixture = data.fixture?.neutral_venue === true;
                const verdictApplies = verdict && !(
                  isNeutralFixture && verdict.status === "bet" &&
                  (verdict.note ?? "").toLowerCase().includes("non-neutral")
                );
                // Only PROVEN ("bet") markets are one-click approvable. Experimental
                // / losing / untested markets are shown with an honest badge but
                // cannot be approved as real picks.
                const canApprove = !!(
                  s.edge &&
                  s.edge.best_price !== null &&
                  s.edge.tier !== "pass" &&
                  verdict?.status === "bet"
                );
                // Build the human bet label for the approval row — e.g.
                // "Paris Saint Germain to win" / "Over 2.5 goals" / "BTTS yes"
                const betLabel =
                  row.market === "1X2" ? (s.label === "Draw" ? "Draw" : `${s.label} to win`) :
                  row.market === "Totals 2.5" ? `${s.label === "Over" ? "Over" : "Under"} 2.5 goals` :
                  row.market === "BTTS" ? `BTTS ${s.label}` :
                  `${s.label} ${row.market}`;
                return (
                  <div
                    key={s.label}
                    className={`px-4 py-2.5 ${i < row.sides.length - 1 ? "border-r border-[#181c18]" : ""}`}
                  >
                    <p className="text-[11px] font-semibold text-[#c4c7c0] truncate mb-1">{s.label}</p>
                    <div className="flex items-baseline gap-2">
                      <p className="text-[14px] font-mono font-black text-[#3ee68a]">
                        {fmtPct(s.prob)}
                      </p>
                    </div>
                    {/* Break-even American odds — the line we'd need at the
                        book to make this side bettable. Useful even when no
                        edge exists today: lets the trader set a target. */}
                    {(() => {
                      const be = modelProbToBreakEvenAmerican(s.prob);
                      return be !== null ? (
                        <p className="text-[8px] text-[#4a524a] font-mono mt-0.5">
                          fair @ {fmtAmericanWithSign(be)}
                        </p>
                      ) : null;
                    })()}
                    {s.edge ? (
                      <div className="mt-1.5 text-[9px] space-y-0.5">
                        <p className="text-[#6b7068] font-mono">
                          mkt {fmtPct(s.edge.implied_prob)} · {s.edge.best_book} {fmtOdds(s.edge.best_price)}
                        </p>
                        <p className="font-mono font-bold" style={{ color: tierColor }}>
                          {s.edge.edge_pp >= 0 ? "+" : ""}{(s.edge.edge_pp * 100).toFixed(1)}pp · {s.edge.tier !== "pass" ? `tier ${s.edge.tier}` : "no bet"}
                        </p>
                        {/* Backtest verdict badge — derived from the M21 calibration
                            run. Green = bet (and how much ROI). Red = backtest loses
                            money. Amber = untested market. */}
                        {verdict && (
                          <p className="font-mono text-[9px]" title={verdict.note ?? ""}>
                            {verdict.status === "bet" && verdictApplies && (
                              <span style={{ color: "#3ee68a" }}>
                                ✓ backtest +{((verdict.roi ?? 0) * 100).toFixed(1)}% ROI ({verdict.n}b)
                              </span>
                            )}
                            {verdict.status === "bet" && !verdictApplies && (
                              <span style={{ color: "#f5c062" }}>
                                ⚠ backtested non-neutral only
                              </span>
                            )}
                            {verdict.status === "loses" && (
                              <span style={{ color: "#ef4444" }}>
                                ✗ backtest {((verdict.roi ?? 0) * 100).toFixed(1)}% ROI ({verdict.n}b) · no bet
                              </span>
                            )}
                            {verdict.status === "experimental" && (
                              <span style={{ color: "#f5c062" }}>
                                ⚡ tested · not proven · no bet
                              </span>
                            )}
                            {verdict.status === "untested" && (
                              <span style={{ color: "#f5c062" }}>
                                ⚠ market not yet backtested
                              </span>
                            )}
                          </p>
                        )}
                      </div>
                    ) : (
                      <p className="text-[9px] text-[#3a4033] mt-1.5">no book price</p>
                    )}
                    {/* Approval row — only shows for tier-A/B/C edges */}
                    {canApprove && !isApproved && (
                      <button
                        onClick={() => s.edge && approve(s.edge, betLabel)}
                        disabled={approving === edgeKey}
                        className="mt-2 w-full rounded border border-[#3ee68a]/30 bg-[#3ee68a]/[0.06] px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-[#3ee68a] hover:bg-[#3ee68a]/[0.12] disabled:opacity-40"
                      >
                        {approving === edgeKey ? "Approving…" : "Approve · Kelly stake"}
                      </button>
                    )}
                    {isApproved && approvedRow && (
                      <div className="mt-2 rounded border border-[#3ee68a]/25 bg-[#3ee68a]/[0.04] px-2 py-1.5 space-y-0.5">
                        <p className="text-[8px] uppercase tracking-wider text-[#4a524a]">
                          {approvedRow.graded_status === "won" ? "Won" :
                           approvedRow.graded_status === "lost" ? "Lost" :
                           approvedRow.graded_status === "push" ? "Push" : "Approved"}
                        </p>
                        <p className="text-[12px] font-mono font-black"
                           style={{
                             color: approvedRow.graded_status === "won" ? "#3ee68a"
                                  : approvedRow.graded_status === "lost" ? "#ef4444"
                                  : "#3ee68a",
                           }}>
                          {stakeSizeLabel(approvedRow.stake_units)}
                          {approvedRow.pnl_units !== null && (
                            <span className="ml-1 text-[10px] font-bold">
                              ({approvedRow.pnl_units >= 0 ? "+" : ""}{approvedRow.pnl_units.toFixed(2)} units P&L)
                            </span>
                          )}
                        </p>
                        <p className="text-[8px] text-[#6b7068] font-mono">
                          opened {approvedRow.opening_book} {approvedRow.opening_price >= 0 ? "+" : ""}{approvedRow.opening_price}
                        </p>
                        {approvedRow.closing_price !== null && (
                          <p className="text-[8px] font-mono"
                             style={{ color: (approvedRow.clv_pp ?? 0) >= 0 ? "#3ee68a" : "#ef4444" }}>
                            close {approvedRow.closing_book} {approvedRow.closing_price >= 0 ? "+" : ""}{approvedRow.closing_price}
                            {approvedRow.clv_pp !== null && (
                              <span className="ml-1 font-bold">
                                CLV {approvedRow.clv_pp >= 0 ? "+" : ""}{(approvedRow.clv_pp * 100).toFixed(1)}pp
                              </span>
                            )}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Drivers — what's feeding the model */}
      {(homeXg || awayXg) && (
        <div className="rounded-lg bg-[#080a08] border border-[#151a15] px-4 py-3">
          <p className="text-[10px] uppercase tracking-wider text-[#4a524a] mb-2">Drivers (last 12 matches)</p>
          <div className="grid grid-cols-2 gap-4 text-[10px]">
            {homeXg && (
              <div>
                <p className="font-semibold text-[#c4c7c0] mb-1">{home}</p>
                <p className="font-mono text-[#9ca39a]">xG {homeXg.xg_for_pg.toFixed(2)} <span className="text-[#4a524a]">·</span> xGA {homeXg.xg_against_pg.toFixed(2)}</p>
                <p className="font-mono text-[#6b7068]">Goals {homeXg.goals_for_pg.toFixed(2)}/g over {homeXg.n_matches} matches</p>
              </div>
            )}
            {awayXg && (
              <div>
                <p className="font-semibold text-[#c4c7c0] mb-1">{away}</p>
                <p className="font-mono text-[#9ca39a]">xG {awayXg.xg_for_pg.toFixed(2)} <span className="text-[#4a524a]">·</span> xGA {awayXg.xg_against_pg.toFixed(2)}</p>
                <p className="font-mono text-[#6b7068]">Goals {awayXg.goals_for_pg.toFixed(2)}/g over {awayXg.n_matches} matches</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Approval summary — what's already on the ticket for this fixture */}
      {Object.keys(approved).length > 0 && (
        <div className="mt-3 rounded-lg border border-[#3ee68a]/15 bg-[#3ee68a]/[0.03] px-4 py-3">
          <p className="text-[10px] uppercase tracking-wider text-[#4a524a] mb-1.5">
            Your approved picks for this fixture
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[11px]">
            {Object.values(approved).map((p) => (
              <div key={`${p.market}|${p.side}`} className="flex items-center gap-1.5">
                <span className="text-[#c4c7c0] font-semibold">{p.bet_label}</span>
                <span className="text-[#3ee68a] font-bold">{stakeSizeLabel(p.stake_units)}</span>
                <span className="text-[#6b7068] font-mono text-[10px]">
                  ({p.opening_book} {p.opening_price >= 0 ? "+" : ""}{p.opening_price})
                </span>
              </div>
            ))}
          </div>
          <p className="text-[9px] text-[#3a4033] mt-2">
            Stake labels are plain English: Small = less than normal, Standard = your normal bet, Strong = bigger than normal. The math still uses quarter-Kelly under the hood.
          </p>
        </div>
      )}

      {/* Error banner if the last approval attempt failed */}
      {approveError && (
        <p className="mt-2 text-[10px] text-[#ef4444]">Approval error: {approveError}</p>
      )}

      <p className="text-[10px] text-[#3a4033] mt-3 leading-relaxed">
        Pre-odds model probabilities from Understat xG + M9 prior regression + M7/M8 lineup adjustments (when fresh).
        Confidence tiers: A ≥5pp · B ≥3pp · C ≥1.5pp · below = no bet.
        Stake recommendation is shown in plain English; quarter-Kelly sizing still runs under the hood.
      </p>
    </Panel>
  );
}

// ─── Today's plays (humanized) ────────────────────────────────────────────────
//
// Top-level prose panel. Card per candidate with the model's view in plain
// English. Approve / Watch / Reject buttons inline so reviewing doesn't
// require opening another panel.

function TodayPlaysPanel({
  candidates, onStatus,
}: {
  candidates: SoccerCandidate[];
  onStatus: (id: number, status: string) => void;
}) {
  // Show actionable cards first: candidates with games in the future, sorted
  // by edge. We skip already-graded backfill rows (they're for the track
  // record, not for re-deciding).
  const todayMs = Date.now();
  const actionable = candidates
    .filter((c) => c.status !== "graded" && c.status !== "rejected")
    .filter((c) => {
      if (!c.commence_time) return true;
      const t = new Date(c.commence_time.replace(" ", "T")).getTime();
      return Number.isFinite(t) && t > todayMs - 6 * 3_600_000; // include in-progress
    })
    .sort((a, b) => (b.edge_pp ?? 0) - (a.edge_pp ?? 0))
    .slice(0, 8);

  return (
    <Panel>
      <SectionHead
        icon={Target}
        title="Today's plays"
        right={
          <span className="text-[10px] text-[#6b7068]">
            {actionable.length === 0 ? "no live plays right now" : `${actionable.length} card${actionable.length !== 1 ? "s" : ""}`}
          </span>
        }
      />
      {actionable.length === 0 ? (
        <EmptyState>
          No upcoming plays right now. The model scans every 30 min — new candidates show up here when the edge clears the threshold. Historical graded records appear in Diagnostics until the results view is rebuilt.
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {actionable.map((c) => {
            const prose = humanizeRationale(c.rationale_json, c.home_team, c.away_team, c.bet_side);
            const headlineBet =
              c.market === "h2h" && c.bet_side === "draw" ? `Draw — ${c.home_team} vs ${c.away_team}`
              : c.market === "h2h" && c.bet_side === "home" ? `${c.home_team} to win`
              : c.market === "h2h" && c.bet_side === "away" ? `${c.away_team} to win`
              : c.market === "totals" ? `${c.bet_side === "over" ? "Over" : "Under"} ${c.total_line ?? "?"} goals`
              : `${betLabel(c.market, c.bet_side, c.total_line)}`;
            return (
              <div key={c.id} className="rounded-xl border border-[#1e2a20] bg-[#0a0d0a] p-5">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1.5">
                      <Tag label={c.confidence_tier} color={tierColor(c.confidence_tier)} />
                      <span className="text-[9px] uppercase tracking-widest text-[#4a524a]">{c.tournament}</span>
                      <span className="text-[9px] text-[#4a524a]">·</span>
                      <span className="text-[9px] text-[#6b7068]">{c.game_date}</span>
                    </div>
                    <p className="text-[15px] font-black text-white">{headlineBet}</p>
                    <p className="text-[10px] text-[#6b7068]">{c.away_team} @ {c.home_team}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-[10px] text-[#4a524a] uppercase tracking-wider">Edge</p>
                    <p className="text-[18px] font-mono font-black text-[#3ee68a]">{fmtEdge(c.edge_pp)}</p>
                  </div>
                </div>

                {prose.length > 0 && (
                  <div className="space-y-1.5 mb-3 rounded-lg bg-[#080a08] border border-[#151a15] px-4 py-3">
                    {prose.map((line, idx) => (
                      <p key={idx} className="text-[12px] leading-relaxed text-[#aeb5aa]">
                        {line}
                      </p>
                    ))}
                  </div>
                )}

                <div className="flex items-center justify-between gap-3 text-[10px]">
                  <div className="flex items-center gap-4">
                    <span><span className="text-[#4a524a]">Model</span> <span className="text-[#d4d7d0] font-mono">{fmtPct(c.model_prob)}</span></span>
                    <span><span className="text-[#4a524a]">Market</span> <span className="text-[#9ca39a] font-mono">{fmtPct(c.book_prob)}</span></span>
                    <span><span className="text-[#4a524a]">Best price</span> <span className="text-[#f5c062] font-mono">{c.book} {fmtOdds(c.book_odds)}</span></span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => onStatus(c.id, "watching")}
                      disabled={c.status === "watching"}
                      className="rounded border border-[#1e2220] px-2.5 py-1 text-[9px] font-bold uppercase tracking-wider text-[#6b7068] hover:text-[#c4c7c0] disabled:opacity-35"
                    >
                      Watch
                    </button>
                    <button
                      onClick={() => onStatus(c.id, "approved")}
                      disabled={c.status === "approved"}
                      className="rounded border border-[#3ee68a]/20 bg-[#3ee68a]/5 px-2.5 py-1 text-[9px] font-bold uppercase tracking-wider text-[#3ee68a] hover:bg-[#3ee68a]/10 disabled:opacity-35"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => onStatus(c.id, "rejected")}
                      disabled={c.status === "rejected"}
                      className="rounded border border-[#ef4444]/15 px-2.5 py-1 text-[9px] font-bold uppercase tracking-wider text-[#ef4444] hover:bg-[#ef4444]/5 disabled:opacity-35"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <p className="text-[10px] text-[#3a4033] mt-3 leading-relaxed">
        These are picks the model wants to make. The rationale is generated from the live signal stack (xG priors, lineup availability, defensive vulnerability, shots-on-target). Approve to promote into the subscriber-facing feed.
      </p>
    </Panel>
  );
}

function FootballAnalysisPanel({ cards }: { cards: FootballAnalysisCard[] }) {
  const usable = cards.filter((c) => c.picks.length > 0).slice(0, 6);
  return (
    <Panel>
      <SectionHead
        icon={Activity}
        title="Match intelligence"
        right={<span className="text-[10px] text-[#6b7068]">football variables first</span>}
      />
      {usable.length === 0 ? (
        <EmptyState>No football-variable reads yet. Run the slate once odds and team mappings are available.</EmptyState>
      ) : (
        <div className="space-y-3">
          {usable.map((card) => {
            const primary = card.picks[0];
            const homeFlow = card.variables.home_flow_home_last10 ?? {};
            const awayFlow = card.variables.away_flow_away_last10 ?? {};
            return (
              <div key={card.game_id} className="rounded-xl border border-[#1a211c] bg-[#0b0e0b] p-4">
                <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3 mb-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <Tag label={primary.confidence} color={tierColor(primary.confidence)} />
                      <span className="text-[9px] uppercase tracking-widest text-[#4a524a]">{card.league}</span>
                    </div>
                    <p className="text-[14px] font-black text-white truncate">{primary.pick}</p>
                    <p className="text-[10px] text-[#6b7068] truncate">{card.matchup}</p>
                  </div>
                  <div className="grid grid-cols-3 gap-3 md:min-w-[260px]">
                    <div className="rounded-lg border border-[#151a15] bg-[#080a08] px-3 py-2">
                      <p className="text-[8px] text-[#4a524a] uppercase tracking-wider">Prob</p>
                      <p className="text-[13px] font-mono font-bold text-[#3ee68a]">{fmtPct(primary.model_prob)}</p>
                    </div>
                    <div className="rounded-lg border border-[#151a15] bg-[#080a08] px-3 py-2">
                      <p className="text-[8px] text-[#4a524a] uppercase tracking-wider">xG</p>
                      <p className="text-[13px] font-mono text-[#d4d7d0]">{fmtNum(card.prediction.lambda_home, 2)}–{fmtNum(card.prediction.lambda_away, 2)}</p>
                    </div>
                    <div className="rounded-lg border border-[#151a15] bg-[#080a08] px-3 py-2">
                      <p className="text-[8px] text-[#4a524a] uppercase tracking-wider">Route</p>
                      <p className="text-[11px] font-mono text-[#f5c062] truncate">{primary.route ? `${primary.route.book} ${fmtOdds(primary.route.odds)}` : "no line"}</p>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-[1.15fr_0.85fr] gap-4">
                  <div className="space-y-2">
                    {primary.football_case.map((line, idx) => (
                      <p key={idx} className="text-[11px] leading-relaxed text-[#aeb5aa]">{line}</p>
                    ))}
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-[10px]">
                    <div className="rounded-lg border border-[#151a15] bg-[#080a08] p-3">
                      <p className="text-[#4a524a] uppercase tracking-wider mb-2">Home flow</p>
                      <p className="text-[#c4c7c0] font-mono">SoT {fmtNum(homeFlow.sot_for_pg)} / allowed {fmtNum(homeFlow.sot_against_pg)}</p>
                      <p className="text-[#6b7068] font-mono">Shots {fmtNum(homeFlow.shots_for_pg)} / corners {fmtNum(homeFlow.corners_for_pg)}</p>
                    </div>
                    <div className="rounded-lg border border-[#151a15] bg-[#080a08] p-3">
                      <p className="text-[#4a524a] uppercase tracking-wider mb-2">Away flow</p>
                      <p className="text-[#c4c7c0] font-mono">SoT {fmtNum(awayFlow.sot_for_pg)} / allowed {fmtNum(awayFlow.sot_against_pg)}</p>
                      <p className="text-[#6b7068] font-mono">Shots {fmtNum(awayFlow.shots_for_pg)} / corners {fmtNum(awayFlow.corners_for_pg)}</p>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <p className="text-[10px] text-[#3a4033] mt-3 leading-relaxed">
        This panel is the non-arb layer: form, shot pressure, goal expectancy, H2H, and game-state variables generate the pick before odds routing is considered.
      </p>
    </Panel>
  );
}

function PropCardsPanel({ cards, stats, meta }: { cards: PropCard[]; stats?: WCPayload["propCardStats"]; meta?: JobMeta }) {
  const top = cards.slice(0, 12);
  const byDecision = stats?.by_decision ?? {};
  return (
    <Panel>
      <SectionHead
        icon={Trophy}
        title="Player prop research (untested)"
        right={
          <div className="flex items-center gap-3 text-[10px] text-[#6b7068]">
            <span>{byDecision.pick ?? 0} pick</span>
            <span>{byDecision.lean ?? 0} lean</span>
            <span>{byDecision.watch ?? 0} watch</span>
            <span>{stats?.priced ?? 0} priced</span>
          </div>
        }
      />
      <div className="rounded-lg border border-[#f5c062]/15 bg-[#f5c062]/[0.03] px-3 py-2 mb-3">
        <p className="text-[10px] text-[#f5c062] leading-relaxed">
          <span className="font-bold">Research only.</span> The numbers here come from a Poisson model on each player's historical rate. We have not backtested player-prop picks against closing lines, so the "pick" tag is the model's opinion — not a validated bet.
        </p>
      </div>
      {top.length === 0 ? (
        <EmptyState>No upcoming prop reads. The model runs whenever new soccer odds post.</EmptyState>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {top.map((c) => {
            const pick = formatPropPick(c);
            const gameTime = formatGameTime(c.commence_time);

            // Build a single plain-English read of why the model likes this.
            // For YES/NO markets (anytime, first goal, assist) we have a
            // model probability; for count markets (shots, SoT) we have a
            // projection plus — when the book line is set — the Poisson
            // probability of clearing the line.
            const modelPctText = c.model_prob != null
              ? `Our model has it at ${(c.model_prob * 100).toFixed(0)}%.`
              : c.model_mean != null
                ? `Our model projects ${c.model_mean.toFixed(1)} ${pick.headline.toLowerCase().replace(/^over \d+(\.\d+)? |^\d+\+ /, "")}.`
                : null;
            const marketText = c.implied_prob != null && c.book
              ? `Market is pricing it around ${(c.implied_prob * 100).toFixed(0)}% (${c.book} ${fmtOdds(c.book_odds)}).`
              : null;
            const edgeText = c.edge_pp != null
              ? `That's a ${Math.abs(c.edge_pp * 100).toFixed(0)}-point ${c.edge_pp >= 0 ? "edge" : "gap"} for our side.`
              : null;
            const decisionColor = c.decision === "pick" ? "#3ee68a" : c.decision === "lean" ? "#f5c062" : "#6b7068";

            return (
              <div key={c.id} className="rounded-xl border border-[#1a211c] bg-[#0a0d0a] p-5">
                {/* Header — small status row */}
                <div className="flex items-center justify-between gap-3 mb-3 text-[10px]">
                  <div className="flex items-center gap-2">
                    <span
                      className="font-bold uppercase tracking-[0.18em]"
                      style={{ color: decisionColor }}
                    >
                      {c.decision === "pick" ? "Model pick" : c.decision === "lean" ? "Lean" : c.decision === "watch" ? "Watch" : "Pass"}
                    </span>
                    <span className="text-[#3a4033]">·</span>
                    <span className="text-[#9ca39a]">Tier {c.confidence_tier}</span>
                  </div>
                  {gameTime && <span className="text-[#6b7068]">{gameTime}</span>}
                </div>

                {/* The bet — main headline in plain English */}
                <p className="text-[18px] font-black text-white leading-tight mb-1">
                  {c.player_name} · {pick.headline.toLowerCase()}
                </p>

                {/* Matchup */}
                <p className="text-[11px] text-[#6b7068] mb-4">
                  {c.away_team} at {c.home_team} · {c.tournament}
                </p>

                {/* Plain-English read — no labeled boxes, just prose */}
                <div className="space-y-1 text-[12px] leading-relaxed text-[#c4c7c0] mb-4">
                  {modelPctText && <p>{modelPctText}</p>}
                  {marketText && <p>{marketText}</p>}
                  {edgeText && (
                    <p
                      className="font-semibold"
                      style={{ color: (c.edge_pp ?? 0) >= 0 ? "#3ee68a" : "#ef4444" }}
                    >
                      {edgeText}
                    </p>
                  )}
                  {!modelPctText && !marketText && (
                    <p className="text-[#6b7068]">
                      Not enough live data to read yet.
                    </p>
                  )}
                </div>

                {/* Bottom row — book/price only. Skip the raw stat grid. */}
                {c.book && (
                  <div className="flex items-center justify-between pt-3 border-t border-[#181c18] text-[11px]">
                    <span className="text-[#6b7068]">Best price</span>
                    <span className="font-mono text-[#f5c062] font-bold">
                      {c.book} {fmtOdds(c.book_odds)}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <p className="text-[10px] text-[#3a4033] mt-3 leading-relaxed">
        Last price refresh checked {meta?.marketEventsChecked ?? 0} fixtures and priced {meta?.pricedCards ?? stats?.priced ?? 0} player markets.
      </p>
    </Panel>
  );
}

function ActualPicksPanel({ picks }: { picks: ActualPick[] }) {
  return (
    <Panel>
      <SectionHead
        icon={Target}
        title="Actual ACE picks"
        right={<span className="text-[10px] text-[#6b7068]">{picks.length} pick{picks.length !== 1 ? "s" : ""}</span>}
      />
      {picks.length === 0 ? (
        <EmptyState>No approved picks yet. Approve a candidate below to move it into the actual-picks feed.</EmptyState>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {picks.map((p) => (
            <div key={`${p.id}-${p.source}`} className="rounded-xl border border-[#1e2a20] bg-[#0a0d0a] p-4">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="min-w-0">
                  <p className="text-[13px] font-bold text-white truncate">{p.pick}</p>
                  <p className="text-[10px] text-[#6b7068] truncate">{p.matchup} · {p.tournament} · {p.game_date}</p>
                </div>
                <Tag label={p.source === "approved" ? "PICK" : "SHORTLIST"} color={p.source === "approved" ? "#3ee68a" : "#f5c062"} />
              </div>
              <div className="grid grid-cols-4 gap-2 mb-3">
                <div>
                  <p className="text-[8px] text-[#4a524a] uppercase tracking-wider">Book</p>
                  <p className="text-[11px] font-mono text-[#c4c7c0] truncate">{p.book}</p>
                </div>
                <div>
                  <p className="text-[8px] text-[#4a524a] uppercase tracking-wider">Odds</p>
                  <p className="text-[11px] font-mono text-white">{fmtOdds(p.odds)}</p>
                </div>
                <div>
                  <p className="text-[8px] text-[#4a524a] uppercase tracking-wider">Edge</p>
                  <p className="text-[11px] font-mono font-black text-[#3ee68a]">{fmtEdge(p.edge_pp)}</p>
                </div>
                <div>
                  <p className="text-[8px] text-[#4a524a] uppercase tracking-wider">Stake</p>
                  <p className="text-[11px] font-bold text-[#f5c062]" title={stakeSizeExplain(p.stake_units)}>{stakeSizeLabel(p.stake_units)}</p>
                </div>
              </div>
              <p className="text-[11px] text-[#9ca39a] leading-relaxed">{p.reason}</p>
              <p className="mt-1 text-[10px] text-[#6b7068]">{confidenceText(p.confidence_tier)} · {stakeSizeExplain(p.stake_units)}</p>
            </div>
          ))}
        </div>
      )}
      <p className="text-[10px] text-[#3a4033] mt-3">
        Approved = actual internal pick. Shortlist = not approved yet, shown only so we can review the model's cleanest candidates.
      </p>
    </Panel>
  );
}

function SoccerCandidatesPanel({ candidates, stats, onStatus }: {
  candidates: SoccerCandidate[];
  stats?: WCPayload["candidateStats"];
  onStatus: (id: number, status: string) => void;
}) {
  const top = candidates.slice(0, 16);
  const status = stats?.by_status ?? {};
  return (
    <Panel>
      <SectionHead
        icon={Brain}
        title="Model candidate queue"
        right={
          <div className="flex items-center gap-3 text-[10px] text-[#6b7068]">
            <span>{stats?.total ?? candidates.length} total</span>
            <span>{status.candidate ?? 0} candidate</span>
            <span>{status.approved ?? 0} approved</span>
            <span>{stats?.record?.graded ?? 0} graded</span>
            <span>top {fmtEdge(stats?.top_edge_pp ?? null)}</span>
          </div>
        }
      />
      {top.length === 0 ? (
        <EmptyState>No model candidates yet. Run Model Scan after live Big Five odds are cached/posting.</EmptyState>
      ) : (
        <div className="space-y-2">
          {top.map((c) => (
            <div
              key={`${c.id}-${c.updated_at}`}
              className="grid grid-cols-[64px_1.2fr_84px_74px_74px_72px_72px_80px_150px] gap-3 items-center rounded-lg border border-[#1a1e1a] bg-[#0a0b0a] px-3 py-2.5 hover:border-[#263026] transition-colors"
            >
              <div className="flex items-center gap-2">
                <Tag label={c.confidence_tier} color={tierColor(c.confidence_tier)} />
                <span className="text-[8px] text-[#3a4033] uppercase">{c.status}</span>
              </div>
              <div className="min-w-0">
                <p className="text-[12px] font-semibold text-[#d4d7d0] truncate">{c.away_team} @ {c.home_team}</p>
                <p className="text-[9px] text-[#4a524a] truncate">{c.tournament} · {c.game_date}</p>
              </div>
              <div>
                <p className="text-[9px] text-[#4a524a] uppercase tracking-wider">Market</p>
                <p className="text-[11px] text-[#c4c7c0] font-mono">{marketLabel(c.market)}</p>
              </div>
              <div>
                <p className="text-[9px] text-[#4a524a] uppercase tracking-wider">Bet</p>
                <p className="text-[11px] text-white font-bold font-mono">{betLabel(c.market, c.bet_side, c.total_line)}</p>
              </div>
              <div>
                <p className="text-[9px] text-[#4a524a] uppercase tracking-wider">Model</p>
                <p className="text-[11px] text-[#d4d7d0] font-mono">{fmtPct(c.model_prob)}</p>
              </div>
              <div>
                <p className="text-[9px] text-[#4a524a] uppercase tracking-wider">Market</p>
                <p className="text-[11px] text-[#9ca39a] font-mono">{fmtPct(c.book_prob)}</p>
              </div>
              <div>
                <p className="text-[9px] text-[#4a524a] uppercase tracking-wider">Edge</p>
                <p className="text-[11px] text-[#3ee68a] font-black font-mono">{fmtEdge(c.edge_pp)}</p>
              </div>
              <div>
                <p className="text-[9px] text-[#4a524a] uppercase tracking-wider">Best</p>
                <p className="text-[11px] text-[#c4c7c0] font-mono truncate">{c.book} {fmtOdds(c.book_odds)}</p>
              </div>
              <div className="flex items-center justify-end gap-1.5">
                {c.status === "graded" && (
                  <span className={c.correct === 1 ? "text-[9px] font-bold text-[#3ee68a]" : c.correct === 0 ? "text-[9px] font-bold text-[#ef4444]" : "text-[9px] font-bold text-[#9ca39a]"}>
                    {c.correct === 1 ? "WIN" : c.correct === 0 ? "LOSS" : "VOID"}
                  </span>
                )}
                <button
                  onClick={() => onStatus(c.id, "watching")}
                  disabled={c.status === "watching"}
                  className="rounded border border-[#1e2220] px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-[#6b7068] hover:text-[#c4c7c0] disabled:opacity-35"
                >
                  Watch
                </button>
                <button
                  onClick={() => onStatus(c.id, "approved")}
                  disabled={c.status === "approved"}
                  className="rounded border border-[#3ee68a]/20 bg-[#3ee68a]/5 px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-[#3ee68a] hover:bg-[#3ee68a]/10 disabled:opacity-35"
                >
                  Approve
                </button>
                <button
                  onClick={() => onStatus(c.id, "rejected")}
                  disabled={c.status === "rejected"}
                  className="rounded border border-[#ef4444]/15 px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-[#ef4444] hover:bg-[#ef4444]/5 disabled:opacity-35"
                >
                  Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="text-[10px] text-[#3a4033] mt-3 leading-relaxed">
        Internal only: these are model-found opportunities for review, not subscriber-facing picks. Promotion comes after approval/grading logic.
      </p>
    </Panel>
  );
}

function winRateColor(v: number | null): string {
  if (v === null) return "#6b7068";
  if (v >= 0.524) return "#3ee68a";
  if (v >= 0.48)  return "#f5c062";
  return "#ef4444";
}

// Local SignalRow removed — ActivityStreamPanel (shared/panels) now handles
// the recent-signals table on every tab. The dead-rubber / card-risk flags
// are still in signal.notes; surfacing them in the shared activity stream
// is a small follow-up.

// ─── Main component ───────────────────────────────────────────────────────────

export default function SoccerOpsTab() {
  const [data,    setData]    = useState<WCPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<null | "fetch" | "grade" | "candidates" | "gradeCandidates" | "propCards" | "propMarket" | "gradeProps" | "livePipeline" | "inventory">(null);

  const loadAll = useCallback(async () => {
    try {
      const res  = await fetch("/api/ops/soccer");
      const json = await res.json() as WCPayload;
      setData(json);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void loadAll(); }, [loadAll]);

  async function runJob(job: "fetch" | "grade" | "candidates" | "gradeCandidates" | "propCards" | "propMarket" | "gradeProps" | "livePipeline" | "inventory") {
    setRunning(job);
    try {
      // API expects "fetch_signals" / "grade_results" — translate from
      // the short UI label so older button code keeps working.
      const apiJob = job === "fetch" ? "fetch_signals" : job === "grade" ? "grade_results" : job === "gradeCandidates" ? "grade_candidates" : job === "propCards" ? "prop_cards" : job === "propMarket" ? "prop_market_scan" : job === "gradeProps" ? "grade_prop_cards" : job === "livePipeline" ? "soccer_live_pipeline" : job === "inventory" ? "sportmonks_inventory" : "candidates";
      await fetch("/api/ops/soccer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job: apiJob, maxMarketEvents: 4 }),
      });
    } catch { /* ignore */ }
    finally { await loadAll(); setRunning(null); }
  }

  async function updateCandidateStatus(id: number, status: string) {
    try {
      await fetch("/api/ops/soccer", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
    } catch { /* ignore */ }
    finally { await loadAll(); }
  }

  const WC_START = new Date("2026-06-11");
  const daysOut  = Math.ceil((WC_START.getTime() - Date.now()) / 86_400_000);
  const preEvent = daysOut > 0;

  if (loading) return <LoadingState />;

  const stats   = data?.stats;
  const signals = data?.signals ?? [];
  // ET-local "today" — the panels split actionable vs awaiting by this.
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  const fetchMeta = data?.jobs.fetch;
  const gradeMeta = data?.jobs.grade;

  const errorMessages: string[] = [];
  const candidatesMeta = data?.jobs.candidates;
  const propCardsMeta = data?.jobs.propCards;
  const livePipelineMeta = data?.jobs.livePipeline;
  const inventoryMeta = data?.jobs.sportmonksInventory;
  if (fetchMeta?.lastError) errorMessages.push(`Scan error: ${fetchMeta.lastError.slice(0, 80)}`);
  if (gradeMeta?.lastError) errorMessages.push(`Grade error: ${gradeMeta.lastError.slice(0, 80)}`);
  if (candidatesMeta?.lastError) errorMessages.push(`Model candidate error: ${candidatesMeta.lastError.slice(0, 80)}`);
  if (propCardsMeta?.lastError) errorMessages.push(`Prop cards error: ${propCardsMeta.lastError.slice(0, 80)}`);
  if (livePipelineMeta?.lastError) errorMessages.push(`Live pipeline error: ${livePipelineMeta.lastError.slice(0, 80)}`);
  if (inventoryMeta?.lastError) errorMessages.push(`Sportmonks inventory error: ${inventoryMeta.lastError.slice(0, 80)}`);

  return (
    <div className="flex-1 overflow-y-auto bg-[#0a0b0a]">
      <div className="max-w-[1200px] mx-auto px-6 py-7 space-y-5">

        {/* Header — slim. Only the safe non-destructive action (Refresh) is
            up front. Manual job triggers (scan, grade, prop cards, etc.) live
            inside Diagnostics — the worker already runs them on schedule
            so they're rarely needed by hand. */}
        <OpsPageHeader
          icon={Trophy}
          title="Soccer"
          tag={preEvent ? `WC in ${daysOut}d` : "live"}
          tagColor={preEvent ? "#6b7068" : "#3ee68a"}
          actions={
            <ActionButton
              icon={RefreshCw}
              variant="subtle"
              onClick={loadAll}
            />
          }
        />

        {/* Errors — kept visible at top so problems aren't hidden */}
        <ErrorBanner messages={errorMessages} />

        {/* ══ HEADLINE METRICS ═══════════════════════════════════════════════
            Just the two numbers a human cares about most: track record and
            ROI. Everything else (broken-down by market, by book, by pipeline
            step) lives inside Diagnostics. */}
        {stats && (
          <div className="flex gap-3 flex-wrap">
            <KpiCard
              label="Track record"
              value={stats.graded > 0 ? `${stats.wins}–${stats.losses}` : "—"}
              sub={stats.graded > 0 ? `${stats.graded} graded · ${fmtPct(stats.winRate)} win rate` : "no graded picks yet"}
              color={stats.winRate !== null && stats.winRate >= 0.524 ? "#3ee68a" : "#d4d7d0"}
            />
            <KpiCard
              label="ROI"
              value={fmtRoi(stats.roi)}
              sub="vs market closing prices"
              color={stats.roi !== null ? (stats.roi >= 0 ? "#3ee68a" : "#ef4444") : "#6b7068"}
            />
            <KpiCard
              label="Open plays"
              value={String(stats.open)}
              sub="awaiting kickoff"
              color={stats.open > 0 ? "#f5c062" : "#6b7068"}
            />
          </div>
        )}

        {/* ══ PLAYER AVAILABILITY ═════════════════════════════════════════════ */}
        {data?.injuries && data.injuries.length > 0 && (
          <div className="rounded-xl border border-[#181c18] bg-[#0d0f0d] p-5">
            <SectionHead
              title="Player availability"
              icon={UserX}
              right={
                <div className="flex items-center gap-3 text-[10px]">
                  <span className="text-[#ef4444]">
                    {data.injuries.filter(i => i.status === "out").length} out
                  </span>
                  <span className="text-[#f5c062]">
                    {data.injuries.filter(i => i.status === "suspended").length} suspended
                  </span>
                  <span className="text-[#9ca39a]">
                    {data.injuries.filter(i => i.status === "questionable").length} doubtful
                  </span>
                </div>
              }
            />
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {data.injuries.slice(0, 18).map((inj, i) => {
                const tone = inj.status === "out" ? {
                  bg: "bg-[#ef4444]/[0.06]",
                  border: "border-[#ef4444]/15",
                  text: "text-[#ef8b8b]",
                  label: "OUT",
                } : inj.status === "suspended" ? {
                  bg: "bg-[#f5c062]/[0.06]",
                  border: "border-[#f5c062]/15",
                  text: "text-[#f5c062]",
                  label: "SUSP",
                } : {
                  bg: "bg-[#6b7068]/[0.06]",
                  border: "border-[#6b7068]/15",
                  text: "text-[#9ca39a]",
                  label: "QUES",
                };
                return (
                  <div
                    key={`${inj.team_name}-${inj.player_name}-${i}`}
                    className={`flex items-center gap-2 rounded-lg border ${tone.border} ${tone.bg} px-2.5 py-2 min-w-0`}
                  >
                    <span className={`text-[8px] font-bold tracking-widest ${tone.text} shrink-0`}>
                      {tone.label}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-semibold text-white truncate">{inj.player_name}</p>
                      <p className="text-[9px] text-[#6b7068] truncate">
                        {inj.team_name}{inj.reason ? ` · ${inj.reason}` : ""}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
            {data.injuries.length > 18 && (
              <p className="text-[10px] text-[#4a524a] mt-3 text-center">
                Showing 18 of {data.injuries.length} unavailable players
              </p>
            )}
          </div>
        )}

        {/* ══ PRE-EVENT NOTICE ════════════════════════════════════════════════ */}
        {preEvent && signals.length === 0 && (
          <div className="rounded-xl border border-[#f5c062]/15 bg-[#f5c062]/[0.03] px-5 py-6 text-center space-y-3">
            <Clock className="h-6 w-6 mx-auto" style={{ color: "#f5c062" }} />
            <p className="text-[14px] font-bold text-[#d4d7d0]">Tournament starts in {daysOut} days</p>
            <p className="text-[12px] text-[#4a524a] max-w-md mx-auto leading-relaxed">
              Pinnacle will post World Cup odds 1–2 weeks before kickoff.
              Hit <span className="text-[#3ee68a] font-semibold">Scan</span> once odds appear to start logging divergences.
            </p>
            <div className="flex items-center justify-center gap-6 pt-1 text-[10px] text-[#3a4033]">
              <span className="flex items-center gap-1.5"><Target className="h-3 w-3" /> 3pp edge threshold</span>
              <span className="flex items-center gap-1.5"><TrendingUp className="h-3 w-3" /> Pinnacle de-vig reference</span>
              <span className="flex items-center gap-1.5"><Activity className="h-3 w-3" /> h2h · totals · asian handicap</span>
            </div>
          </div>
        )}

        {/* ══ FEATURED PICK (M33) ════════════════════════════════════════════
            Main operator surface: one validated bet worth attention, or an
            honest empty state. Review queues and rehearsal diagnostics live in
            Diagnostics so the top-level Soccer page does not mix backend
            QA with actual betting workflow. */}
        <FeaturedPickPanel />

        {/* ══ YOUR TICKET (M24) ══════════════════════════════════════════════
            Every approved pick across all fixtures with running CLV, W-L,
            ROI summary. The trading-desk view of your active positions. */}
        <ApprovedPicksDashboard />

        {/* ══ ENGINE INTERNALS — collapsed by default ═══════════════════════
            Everything below is the model's full opinion + raw debugging:
            the unfiltered per-market grid (including markets the backtest
            says don't bet), candidate queues, prop cards, raw signal data.
            Out of the way unless you want to dig in. */}
        <EngineInternals subtitle="review queues, rehearsal diagnostics, raw model output, manual triggers">
          {/* Suggested picks are intentionally internal. They may be ungraded or
              pending review, so they should not sit next to the main ticket. */}
          <SuggestedPicksPanel />

          {/* Friendly fixtures are backend/live-state rehearsal data, not board
              games and not ACE-validated picks. Keep this behind internals. */}
          <FriendliesPanel />

          {/* Match Intelligence — the full per-market grid (was top of page).
              Useful when you want to see model's opinion on every market,
              including the ones the backtest says lose money. */}
          <MatchIntelligencePanel />

          {/* Today's plays — humanized candidate queue across all upcoming
              fixtures. Useful for scanning the slate beyond the featured pick. */}
          <TodayPlaysPanel
            candidates={data?.candidates ?? []}
            onStatus={updateCandidateStatus}
          />

          {/* Approved picks — older raw view. Kept internal because the main
              ApprovedPicksDashboard is the cleaner ticket view. */}
          <ActualPicksPanel picks={data?.actualPicks ?? []} />

          {/* Player-prop research cards (shots / scorer / assist etc.).
              NOTE: these are NOT backtested. They surface positive math edges
              from the Poisson tier search but we haven't proven the
              underlying rates predict future shots accurately. Treat as
              research, not picks. */}
          <PropCardsPanel cards={data?.propCards ?? []} stats={data?.propCardStats} meta={data?.jobs.propCards} />

          {/* Worker / scan / grade status strip */}
          <WorkerStatusStrip
            worker={data?.worker}
            fetch={fetchMeta}
            grade={gradeMeta}
          />

          {/* Manual job triggers — worker runs all these on schedule, so
              these are only useful when I want to force a refresh. */}
          <div className="flex flex-wrap gap-2">
            <ActionButton
              icon={Zap}
              label={running === "fetch" ? "Scanning…" : "Scan odds"}
              variant="primary"
              busy={running === "fetch"}
              disabled={running !== null}
              onClick={() => runJob("fetch")}
            />
            <ActionButton
              icon={Brain}
              label={running === "candidates" ? "Modelling…" : "Run model"}
              busy={running === "candidates"}
              disabled={running !== null}
              onClick={() => runJob("candidates")}
            />
            <ActionButton
              icon={CheckCircle2}
              label={running === "grade" ? "Grading signals…" : "Grade signals"}
              busy={running === "grade"}
              disabled={running !== null}
              onClick={() => runJob("grade")}
            />
            <ActionButton
              icon={CheckCircle2}
              label={running === "gradeCandidates" ? "Grading model…" : "Grade model picks"}
              busy={running === "gradeCandidates"}
              disabled={running !== null}
              onClick={() => runJob("gradeCandidates")}
            />
            <ActionButton
              icon={CheckCircle2}
              label={running === "gradeProps" ? "Grading props…" : "Grade props"}
              busy={running === "gradeProps"}
              disabled={running !== null}
              onClick={() => runJob("gradeProps")}
            />
            <ActionButton
              icon={Activity}
              label={running === "livePipeline" ? "Live…" : "Live pipeline"}
              busy={running === "livePipeline"}
              disabled={running !== null}
              onClick={() => runJob("livePipeline")}
            />
            <ActionButton
              icon={Trophy}
              label={running === "propCards" ? "Props…" : "Build prop cards"}
              busy={running === "propCards"}
              disabled={running !== null}
              onClick={() => runJob("propCards")}
            />
            <ActionButton
              icon={Target}
              label={running === "propMarket" ? "Pricing…" : "Price props"}
              busy={running === "propMarket"}
              disabled={running !== null}
              onClick={() => runJob("propMarket")}
            />
            <ActionButton
              icon={AlertTriangle}
              label={running === "inventory" ? "Inventory…" : "Sportmonks inventory"}
              busy={running === "inventory"}
              disabled={running !== null}
              onClick={() => runJob("inventory")}
            />
          </div>

          {/* Detailed KPIs (per-market, by-book, live pipeline) */}
          {stats && (
            <div className="flex gap-3 flex-wrap">
              <KpiCard label="Signals total" value={String(stats.total)} />
              <KpiCard label="Win rate" value={fmtPct(stats.winRate)} sub="52.4% break-even" color={winRateColor(stats.winRate)} />
              {stats.h2h.graded > 0 && (
                <KpiCard label="1X2 record" value={`${stats.h2h.wins}/${stats.h2h.graded}`} sub={fmtPct(stats.h2h.wins / stats.h2h.graded)} />
              )}
              {stats.totals.graded > 0 && (
                <KpiCard label="Totals record" value={`${stats.totals.wins}/${stats.totals.graded}`} sub={fmtPct(stats.totals.wins / stats.totals.graded)} />
              )}
              {livePipelineMeta && (
                <KpiCard label="Live pipe" value={`${livePipelineMeta.mapped ?? 0}/${livePipelineMeta.synced ?? 0}`} sub={`${livePipelineMeta.cards ?? 0} cards · ${livePipelineMeta.priced ?? 0} priced`} color="#3ee68a" />
              )}
            </div>
          )}

          {/* Football-variable handicap layer */}
          <FootballAnalysisPanel cards={data?.footballAnalysis ?? []} />

          {/* Dense candidate table — full queue including graded backfill */}
          <SoccerCandidatesPanel
            candidates={data?.candidates ?? []}
            stats={data?.candidateStats}
            onStatus={updateCandidateStatus}
          />

          {/* WC market probe — pre-launch tool. ~10 credits per probe. */}
          <MarketProbePanel />

          {/* Player priors browser */}
          <PlayerPriorsPanel />

          {/* Historical signal panels */}
          <TodaySlatePanel signals={signals} today={today} />
          <OpenSignalsPanel signals={signals} today={today} />
          <CLVStatsPanel signals={signals} />
          <ByBookPanel signals={signals} />
          <StaleSignalsPanel signals={signals} today={today} />
          <ActivityStreamPanel signals={signals} />
        </EngineInternals>

      </div>
    </div>
  );
}
