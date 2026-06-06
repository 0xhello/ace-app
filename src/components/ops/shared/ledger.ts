export interface TrackedPickRow {
  id: number;
  sport: string;
  origin: string;
  lifecycle: string;
  publish_state?: string;
  game_id?: string;
  game_date?: string | null;
  commence_time?: string | null;
  league?: string | null;
  tournament?: string | null;
  home_team?: string | null;
  away_team?: string | null;
  matchup_label?: string | null;
  market: string;
  side: string;
  line?: number | null;
  selection_label?: string | null;
  book?: string | null;
  odds_american?: number | null;
  implied_prob?: number | null;
  sharp_prob?: number | null;
  model_prob?: number | null;
  edge_pp?: number | null;
  signal_strength?: number | null;
  confidence_tier?: string | null;
  stake_units?: number | null;
  closing_book?: string | null;
  closing_odds_american?: number | null;
  closing_implied_prob?: number | null;
  clv_pp?: number | null;
  clv_points?: number | null;
  home_score?: number | null;
  away_score?: number | null;
  result?: string | null;
  result_detail?: string | null;
  pnl_units?: number | null;
  detected_at?: string | null;
  tracked_at?: string | null;
  graded_at?: string | null;
  source_table?: string;
  source_id?: string;
  source_db?: string;
}

export interface ResultsSummaryRow {
  sport: string;
  graded: number;
  wins: number;
  losses: number;
  pushes: number;
  pnl_units: number | null;
  avg_clv_pp: number | null;
}

export function fmtSport(value: string): string {
  return value.toUpperCase();
}

export function fmtPct(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

export function fmtPp(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const formatted = `${(value * 100).toFixed(1)}pp`;
  return value > 0 ? `+${formatted}` : formatted;
}

export function fmtUnits(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}u`;
}

export function fmtOdds(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return value > 0 ? `+${value}` : `${value}`;
}

export function marketLabel(value: string): string {
  if (value === "h2h") return "Moneyline";
  if (value === "run_line") return "Run line";
  if (value === "totals") return "Total";
  if (value === "totals_2.5") return "Total 2.5";
  if (value === "btts") return "BTTS";
  if (value === "soft_book_divergence") return "Soft book divergence";
  if (value === "steam_move") return "Steam move";
  if (value === "line_movement") return "Line movement";
  return value.replaceAll("_", " ");
}

export function sideLabel(row: Pick<TrackedPickRow, "selection_label" | "market" | "side" | "line">): string {
  if (row.selection_label) return row.selection_label;
  if (row.market === "totals" || row.market === "totals_2.5") {
    return `${row.side.toUpperCase()}${row.line != null ? ` ${row.line}` : ""}`;
  }
  if (row.market === "run_line") {
    const line = row.line == null ? "" : row.line > 0 ? ` +${row.line}` : ` ${row.line}`;
    return `${row.side === "home" ? "Home" : "Away"}${line}`;
  }
  if (row.market === "btts") return row.side === "yes" ? "Yes" : "No";
  if (row.side === "home") return "Home";
  if (row.side === "away") return "Away";
  return row.side.toUpperCase();
}

export function resultColor(result?: string | null): string {
  if (result === "win") return "#3ee68a";
  if (result === "loss") return "#ef4444";
  if (result === "push" || result === "void") return "#9ca39a";
  return "#6b7068";
}

export function resultLabel(result?: string | null): string {
  if (result === "win") return "Win";
  if (result === "loss") return "Loss";
  if (result === "push") return "Push";
  if (result === "void") return "Push";
  return "Open";
}
