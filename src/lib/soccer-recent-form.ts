/**
 * Recent-form loader — reads the cached `soccer_team_recent_results` table
 * (populated from Sportmonks by ml/soccer/recent_results.py) and returns a map
 * keyed by NORMALIZED team name. Last-N finished results + a compact summary for
 * any soccer team Sportmonks tracks (WC nations included — our club-only
 * soccer_team_form table has none).
 *
 * READ-only and decoupled from the refresh (same contract as soccer-injuries.ts).
 * Returns an empty map on any error — missing form must never break the page.
 */
import { spawnSync } from "child_process";

export interface RecentResult {
  date: string;
  opponent: string;
  venue: "H" | "A";
  gf: number;
  ga: number;
  result: "W" | "D" | "L";
  competition: string | null;
}

export interface RecentFormSummary {
  played: number;
  w: number;
  d: number;
  l: number;
  gf: number;
  ga: number;
  clean_sheets: number;
  form: string;            // newest→oldest letters, e.g. "WWDLW"
  streak: string | null;   // e.g. "W2"
  run: string | null;      // e.g. "5 unbeaten"
}

export interface TeamRecentForm {
  results: RecentResult[];
  summary: RecentFormSummary;
}

export type RecentFormMap = Map<string, TeamRecentForm>;

export function fetchSoccerRecentForm(): RecentFormMap {
  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
  const script = `
import json
try:
    from ml.soccer.recent_results import recent_form_by_team_name
    print(json.dumps(recent_form_by_team_name()))
except Exception:
    print(json.dumps({}))
`;
  try {
    const r = spawnSync("python3", ["-c", script], {
      encoding: "utf-8",
      timeout: 8_000,
      cwd: appRoot,
    });
    const data = JSON.parse(r.stdout || "{}") as Record<string, TeamRecentForm>;
    const map: RecentFormMap = new Map();
    for (const [key, v] of Object.entries(data)) {
      if (v?.results?.length) map.set(key, v);
    }
    return map;
  } catch {
    return new Map();
  }
}

/** Normalize a team name to match the loader's keys (accent-fold + &→and). */
export function normTeamKey(name: string): string {
  const key = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\s+/g, " ")
    .trim();

  // Odds API and Sportmonks disagree on a few national-team display names.
  // Keep this loader alias-only so game-page copy still uses the board name.
  if (key === "united states" || key === "united states of america") return "usa";
  return key;
}
