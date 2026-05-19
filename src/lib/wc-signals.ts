/**
 * WC signal loader for the user dashboard. Reads open soccer_signals from
 * wc_signal_log.db and maps to the ModelSignal shape so the existing
 * generateIntelMap pipeline can pick them up and render ACE chips on
 * WC games — same chip pattern as NBA.
 *
 * Only home/away h2h signals are surfaced for v1. Draws and totals are
 * filtered out (the GameRow chip is team-based and doesn't have a
 * draw/over/under render path yet).
 */
import { spawnSync } from "child_process";
import path from "path";
import type { ModelSignal } from "@/lib/model-signals";

function dbPath(): string {
  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
  return path.join(appRoot, "ml", "nba_spread", "data", "wc_signal_log.db");
}

export function fetchWCSignals(): ModelSignal[] {
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
            "SELECT name FROM sqlite_master WHERE type='table' AND name='soccer_signals'"
        ).fetchone()
        rows = []
        if has_tbl:
            rows = [dict(r) for r in conn.execute(
                """SELECT home_team, away_team, market, bet_side,
                          total_line, edge_pp, kelly_fraction
                   FROM soccer_signals
                   WHERE status = 'open'
                     AND market = 'h2h'
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

  return rows.map<ModelSignal>(r => ({
    home_team:        String(r.home_team || ""),
    away_team:        String(r.away_team || ""),
    bet_side:         r.bet_side as "home" | "away",
    signal_type:      "divergence",
    line_at_signal:   null,            // h2h is moneyline — no line
    home_cover_prob:  null,            // not applicable to h2h divergence
    edge_vs_pinnacle: (r.edge_pp as number | null) ?? null,
    kelly_fraction:   (r.kelly_fraction as number | null) ?? null,
  }));
}
