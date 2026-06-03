/**
 * Soccer injury loader — reads the general `soccer_injuries` table (populated
 * from Sportmonks `sidelined` by ml/soccer/injuries.py) and returns a map
 * keyed by NORMALIZED team name so the board can render OUT / SUSPENDED chips
 * next to any soccer game (WC nations + clubs alike).
 *
 * Decoupled from the refresh: this only READS. The refresh
 * (/api/ops/soccer/refresh-injuries) populates the table for the board's
 * current soccer teams. Returns an empty map on any error — missing injuries
 * must never break the board.
 */
import { spawnSync } from "child_process";

export type SoccerInjuryStatus = "out" | "suspended" | "questionable";

export interface SoccerInjuryRow {
  team_name: string;
  player_name: string;
  status: SoccerInjuryStatus;
  reason: string | null;
}

export type SoccerInjuryMap = Map<string, SoccerInjuryRow[]>;

export function fetchSoccerInjuries(): SoccerInjuryMap {
  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
  const script = `
import json
try:
    from ml.soccer.injuries import injuries_by_team_name
    print(json.dumps(injuries_by_team_name()))
except Exception:
    print(json.dumps({}))
`;
  try {
    const r = spawnSync("python3", ["-c", script], {
      encoding: "utf-8",
      timeout: 8_000,
      cwd: appRoot,
    });
    const data = JSON.parse(r.stdout || "{}") as Record<string, Array<{ player_name: string; status: string; reason: string | null }>>;
    const map: SoccerInjuryMap = new Map();
    for (const [key, rows] of Object.entries(data)) {
      map.set(key, rows.map((x) => ({
        team_name: key,
        player_name: x.player_name,
        status: (x.status as SoccerInjuryStatus) ?? "out",
        reason: x.reason ?? null,
      })));
    }
    return map;
  } catch {
    return new Map();
  }
}
