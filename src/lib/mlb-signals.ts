/**
 * MLB signal loader for the user dashboard. Reads open mlb_signals and maps
 * to ModelSignal so the existing generateIntelMap pipeline renders ACE chips
 * on MLB games — same pattern as NBA.
 *
 * v1 surfaces h2h and run_line signals (both team-based). Totals are filtered
 * out for now — the dashboard chip is team-based and doesn't render
 * over/under cleanly yet.
 */
import { spawnSync } from "child_process";
import path from "path";
import type { ModelSignal } from "@/lib/model-signals";

function dbPath(): string {
  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
  return path.join(appRoot, "ml", "nba_spread", "data", "mlb_signal_log.db");
}

export function fetchMLBSignals(): ModelSignal[] {
  const dp = dbPath();
  const script = `
import json, os, sqlite3
try:
    if not os.path.exists(${JSON.stringify(dp)}):
        print(json.dumps([]))
    else:
        conn = sqlite3.connect(${JSON.stringify(dp)})
        conn.row_factory = sqlite3.Row
        has_tbl = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='mlb_signals'"
        ).fetchone()
        rows = []
        if has_tbl:
            rows = [dict(r) for r in conn.execute(
                """SELECT home_team, away_team, market, bet_side,
                          line, edge_pp, kelly_fraction
                   FROM mlb_signals
                   WHERE status = 'open'
                     AND market IN ('h2h','run_line')
                     AND bet_side IN ('home','away')
                   ORDER BY edge_pp DESC"""
            ).fetchall()]
        conn.close()
        print(json.dumps(rows))
except Exception:
    print(json.dumps([]))
`;
  const res = spawnSync("python3", ["-c", script], {
    encoding: "utf-8",
    timeout: 4_000,
  });
  let rows: Array<Record<string, unknown>> = [];
  try {
    rows = JSON.parse(res.stdout) as Array<Record<string, unknown>>;
  } catch {
    return [];
  }

  return rows.map<ModelSignal>(r => {
    const market = String(r.market || "");
    return {
      home_team:        String(r.home_team || ""),
      away_team:        String(r.away_team || ""),
      bet_side:         r.bet_side as "home" | "away",
      signal_type:      market === "run_line" ? "spread_divergence" : "divergence",
      // run_line carries the line; h2h doesn't.
      // Stored convention: line is home spread (negative if home favored).
      // Flip sign for away bets so the chip displays the away-side line.
      line_at_signal:   market === "run_line"
        ? (r.line == null ? null : (r.bet_side === "home" ? (r.line as number) : -(r.line as number)))
        : null,
      home_cover_prob:  null,
      edge_vs_pinnacle: (r.edge_pp as number | null) ?? null,
      kelly_fraction:   (r.kelly_fraction as number | null) ?? null,
    };
  });
}
