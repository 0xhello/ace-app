/**
 * Board game → Sportmonks fixture-id map. The live view (score/events/lineups)
 * needs a Sportmonks fixture id; the heavy slate-sync bundle doesn't cover the
 * World Cup window, so we resolve ids cheaply (one discovery call, alias-aware
 * name+date match — see ml/soccer/live_match.resolve_fixture_ids) in the
 * BACKGROUND and store the map in Redis. The game page reads it with a single
 * Redis GET — no python spawn on the render path.
 */
import { spawn } from "child_process";
import * as serverCache from "@/lib/server-cache";
import { sportTab } from "@/lib/sport-tab";

const KEY = "soccer-fixture-ids";

type Pair = { game_id: string; home: string; away: string; commence: string };

function runResolver(pairs: Pair[], timeoutMs = 30_000): Promise<Record<string, number>> {
  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
  const script = `
import json, sys
from ml.soccer.live_match import resolve_fixture_ids
print(json.dumps(resolve_fixture_ids(json.loads(sys.argv[1]))))
`;
  return new Promise((resolve) => {
    let out = "";
    const child = spawn("python3", ["-c", script, JSON.stringify(pairs)], { cwd: appRoot });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* */ } resolve({}); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", () => { clearTimeout(timer); resolve({}); });
    child.on("close", () => { clearTimeout(timer); try { resolve(JSON.parse(out)); } catch { resolve({}); } });
  });
}

/** Resolve fixture ids for the board's soccer games and persist the map. */
export async function refreshFixtureIdMap(): Promise<{ ok: boolean; resolved: number; games: number }> {
  try {
    const entry = await serverCache.get("board-games");
    const games: Array<{ id: string; sport?: string; sport_title?: string; home_team?: string; away_team?: string; commence_time?: string; status?: string }> =
      entry?.data?.games ?? [];
    const pairs: Pair[] = games
      .filter((g) => sportTab(g.sport, g.sport_title) === "SOCCER" && g.status !== "final" && g.home_team && g.away_team)
      .map((g) => ({ game_id: g.id, home: g.home_team!, away: g.away_team!, commence: g.commence_time ?? "" }));
    if (pairs.length === 0) return { ok: true, resolved: 0, games: 0 };
    const map = await runResolver(pairs);
    // merge with any existing map so a transient miss doesn't drop a known id
    const prev = ((await serverCache.get(KEY))?.data as Record<string, number>) ?? {};
    const merged = { ...prev, ...map };
    await serverCache.setPersistent(KEY, merged);
    return { ok: true, resolved: Object.keys(map).length, games: pairs.length };
  } catch (e) {
    return { ok: false, resolved: 0, games: 0 };
  }
}

/** Read the persisted map (Redis GET; {} if not populated yet). */
export async function getFixtureIdMap(): Promise<Record<string, number>> {
  try {
    return ((await serverCache.get(KEY))?.data as Record<string, number>) ?? {};
  } catch {
    return {};
  }
}
