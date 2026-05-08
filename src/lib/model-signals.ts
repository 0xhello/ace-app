import { spawnSync } from "child_process";

export interface ModelSignal {
  home_team: string;
  away_team: string;
  bet_side: "home" | "away";
  signal_type: string;
  line_at_signal: number | null;
  home_cover_prob: number | null;
  edge_vs_pinnacle: number | null;
  kelly_fraction: number | null;
}

export function fetchModelSignals(): ModelSignal[] {
  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
  const dbPath = `${appRoot}/ml/nba_spread/data/signal_log.db`;

  const script = `
import sqlite3, json
from datetime import datetime
from zoneinfo import ZoneInfo

_TZ_ET = ZoneInfo('America/New_York')
DB = ${JSON.stringify(dbPath)}
et_today = datetime.now(_TZ_ET).strftime('%Y-%m-%d')

try:
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """SELECT s.home_team, s.away_team, s.bet_side,
                  s.line_at_signal, s.signal_type,
                  p.home_cover_prob, p.edge_vs_pinnacle
           FROM signal_log s
           LEFT JOIN predictions p ON p.game_id = s.game_id
           WHERE s.status IN ('open','proxy_captured')
             AND s.game_date = ?
           ORDER BY s.id DESC""",
        (et_today,)
    ).fetchall()

    def kelly(bet_side, hcp):
        if hcp is None: return None
        p = float(hcp) if bet_side == 'home' else 1.0 - float(hcp)
        b = 100.0 / 110.0
        k = (p * (b + 1.0) - 1.0) / b
        return round(max(k, 0.0), 4)

    result = []
    for r in rows:
        raw_edge = r['edge_vs_pinnacle']
        bet_edge = (raw_edge if r['bet_side'] == 'home' else -raw_edge) if raw_edge is not None else None
        result.append({
            'home_team': r['home_team'],
            'away_team': r['away_team'],
            'bet_side': r['bet_side'],
            'signal_type': r['signal_type'],
            'line_at_signal': r['line_at_signal'],
            'home_cover_prob': r['home_cover_prob'],
            'edge_vs_pinnacle': bet_edge,
            'kelly_fraction': kelly(r['bet_side'], r['home_cover_prob']),
        })
    conn.close()
    print(json.dumps(result))
except Exception:
    print(json.dumps([]))
`;

  const res = spawnSync("python3", ["-c", script], {
    encoding: "utf-8",
    timeout: 5_000,
  });

  try {
    return JSON.parse(res.stdout) as ModelSignal[];
  } catch {
    return [];
  }
}
