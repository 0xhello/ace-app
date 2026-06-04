/**
 * Soccer pre-match research refresh (injuries + recent form) — shared by the
 * ops route and the boot-time scheduler (src/instrumentation.ts).
 *
 * Uses ASYNC child_process.spawn (never spawnSync) so a multi-minute refresh
 * never blocks the Node event loop / request serving. Reads the board's soccer
 * teams from the shared cache; writes the soccer_injuries +
 * soccer_team_recent_results tables. Fully guarded — a failure here must never
 * crash the server or a request.
 */
import { spawn } from "child_process";
import * as serverCache from "@/lib/server-cache";
import { sportTab } from "@/lib/sport-tab";

const CACHE_KEY = "board-games"; // must match src/app/api/board/route.ts
let running = false;

async function boardSoccerTeams(): Promise<string[]> {
  try {
    const cached = await serverCache.get(CACHE_KEY);
    const games: Array<{ sport?: string; sport_title?: string; home_team?: string; away_team?: string }> =
      cached?.data?.games ?? [];
    const set = new Set<string>();
    for (const g of games) {
      if (sportTab(g.sport, g.sport_title) === "SOCCER") {
        if (g.home_team) set.add(g.home_team);
        if (g.away_team) set.add(g.away_team);
      }
    }
    return [...set];
  } catch {
    return [];
  }
}

function runPython(teams: string[], timeoutMs = 180_000): Promise<any> {
  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
  const script = `
import json, sys
from ml.soccer.injuries import refresh_for_teams as refresh_injuries
from ml.soccer.recent_results import refresh_for_teams as refresh_form
names = json.loads(sys.argv[1])
out = {}
try: out["injuries"] = refresh_injuries(names)
except Exception as e: out["injuries"] = {"error": str(e)[:200]}
try: out["form"] = refresh_form(names)
except Exception as e: out["form"] = {"error": str(e)[:200]}
print(json.dumps(out))
`;
  return new Promise((resolve) => {
    let stdout = "", stderr = "";
    const child = spawn("python3", ["-c", script, JSON.stringify(teams)], { cwd: appRoot });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } resolve({ error: "timeout" }); }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => { clearTimeout(timer); resolve({ error: String(e).slice(0, 200) }); });
    child.on("close", () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(stdout)); }
      catch { resolve({ error: "parse failed", stderr: stderr.slice(-300) }); }
    });
  });
}

/** Refresh injuries + recent form for the given teams (or the board's soccer teams). */
export async function refreshSoccerResearch(explicitTeams?: string[]): Promise<any> {
  if (running) return { skipped: "already running" };
  running = true;
  try {
    const teams = (explicitTeams && explicitTeams.length) ? explicitTeams : await boardSoccerTeams();
    if (teams.length === 0) return { ok: true, refreshed: 0, note: "no soccer teams on the board" };
    const result = await runPython(teams);
    return { ok: true, teams: teams.length, ...result };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  } finally {
    running = false;
  }
}
