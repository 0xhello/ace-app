/**
 * WC injury loader — reads wc_injuries from the shared SQLite volume and
 * returns a map keyed by team name (case-insensitive). Used by the dashboard
 * board to surface OUT / SUSPENDED / QUESTIONABLE chips next to WC games,
 * the same way NBA games get ESPN injury alerts.
 *
 * Data is populated by ml/world_cup/context.sync_injuries() on the worker's
 * daily 7am ET context sync.
 */
import { spawnSync } from "child_process";
import path from "path";

export type WCInjuryStatus = "out" | "suspended" | "questionable";

export interface WCInjuryRow {
  team_name: string;
  player_name: string;
  status: WCInjuryStatus;
  reason: string | null;
}

export type WCInjuryMap = Map<string, WCInjuryRow[]>;

function dbPath(): string {
  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
  return path.join(appRoot, "ml", "nba_spread", "data", "wc_signal_log.db");
}

/**
 * Loads the current WC injury feed. Returns a Map<normalizedTeamName, rows[]>
 * where keys are lowercased team names so the consumer can do case-insensitive
 * lookup against Odds API team names.
 *
 * Returns an empty map on any error — the absence of injuries should never
 * break the dashboard.
 */
export async function fetchWCInjuries(): Promise<WCInjuryMap> {
  const dp = dbPath();
  const script = `
import json, os, sqlite3
try:
    if not os.path.exists(${JSON.stringify(dp)}):
        print(json.dumps([]))
    else:
        conn = sqlite3.connect(${JSON.stringify(dp)})
        conn.row_factory = sqlite3.Row
        # Be tolerant if the table doesn't exist yet (first deploy on a volume
        # that predates the migration)
        has_tbl = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='wc_injuries'"
        ).fetchone()
        rows = []
        if has_tbl:
            rows = [dict(r) for r in conn.execute(
                "SELECT team_name, player_name, status, reason FROM wc_injuries"
            ).fetchall()]
        conn.close()
        print(json.dumps(rows))
except Exception:
    print(json.dumps([]))
`;

  const result = spawnSync("python3", ["-c", script], {
    encoding: "utf-8",
    timeout: 4_000,
  });

  let rows: WCInjuryRow[] = [];
  try {
    rows = JSON.parse(result.stdout) as WCInjuryRow[];
  } catch {
    rows = [];
  }

  const map: WCInjuryMap = new Map();
  for (const r of rows) {
    if (!r.team_name || !r.player_name) continue;
    const key = r.team_name.trim().toLowerCase();
    const list = map.get(key) ?? [];
    list.push(r);
    map.set(key, list);
  }

  // Sort each team's list: out > suspended > questionable, then alpha
  const ORDER: WCInjuryStatus[] = ["out", "suspended", "questionable"];
  for (const [k, list] of map.entries()) {
    list.sort((a, b) => {
      const aIdx = ORDER.indexOf(a.status);
      const bIdx = ORDER.indexOf(b.status);
      if (aIdx !== bIdx) return aIdx - bIdx;
      return a.player_name.localeCompare(b.player_name);
    });
    map.set(k, list);
  }

  return map;
}
