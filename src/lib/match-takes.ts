/**
 * ACE Takes cache — grounded analyst takes per soccer game.
 *
 * The takes themselves come from ml/soccer/match_takes.py (Sportmonks
 * predictions + our player baselines). This module warms them in the BACKGROUND
 * as one batch spawn and stores the result in Redis; the game page reads the
 * cache with a single GET (no python on the render path, same contract as the
 * fixture-id map and prepared-intel cache).
 *
 * Cost control lives in the python layer: each fixture only hits the Sportmonks
 * API when its cached bundle is older than ~2h, so warming every ~10min costs
 * almost nothing in provider credits.
 */
import { spawn } from "child_process";
import * as serverCache from "@/lib/server-cache";
import { getFixtureIdMap } from "@/lib/soccer-fixture-id";
import { sportTab } from "@/lib/sport-tab";
import type { Game } from "@/types/game";

const KEY = "match-takes-v1";        // rule-engine takes (scheduler-warmed)
const KEY_AGENT = "agent-takes-v1";  // analyst-agent takes (override; takes precedence)

export type TakeTier = "Strong" | "Lean" | "Slight" | "Pass";
export interface Take {
  market: string;
  market_label: string;
  selection: string;
  tier: TakeTier;
  model_pct: number | null;
  reasons: string[];
  source: string;
  odds?: string | null;   // optional book price the agent is reading, e.g. "+180 FanDuel"
}
export interface GameTakes {
  fixture_id: number;
  home: string;
  away: string;
  source?: "cache" | "live" | "agent";
  has_predictions: boolean;
  lineups_posted: boolean;
  takes: Take[];
  summary?: string | null;   // the analyst's bottom-line (agent only)
  generatedBy?: string;      // e.g. "ACE Analyst (opus-4.8)"
  error?: string;
}
interface AgentPayload { refreshedAt: string; games: Record<string, GameTakes> }
interface TakesPayload {
  refreshedAt: string;
  games: Record<string, GameTakes>;
}

type Item = { game_id: string; fixture_id: number; home: string; away: string; corner_line: number | null };

function runBatch(items: Item[], timeoutMs = 60_000): Promise<Record<string, GameTakes>> {
  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
  const script = `
import json, sys
from ml.soccer.match_takes import build_takes_batch
print(json.dumps(build_takes_batch(json.loads(sys.argv[1]))))
`;
  return new Promise((resolve) => {
    let out = "";
    const child = spawn("python3", ["-c", script, JSON.stringify(items)], { cwd: appRoot });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* */ } resolve({}); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", () => { clearTimeout(timer); resolve({}); });
    child.on("close", () => { clearTimeout(timer); try { resolve(JSON.parse(out)); } catch { resolve({}); } });
  });
}

let warming = false;
let lastWarmAt = 0;

/** Warm takes for the board's upcoming soccer games and persist the map. */
export async function warmMatchTakes(reason = "manual"): Promise<{ ok: boolean; warmed: number; games: number }> {
  if (warming) return { ok: true, warmed: 0, games: 0 };
  if (Date.now() - lastWarmAt < 60_000) return { ok: true, warmed: 0, games: 0 };
  warming = true;
  try {
    const board = (await serverCache.get("board-games"))?.data as { games?: Game[] } | undefined;
    const games = board?.games ?? [];
    const fxMap = await getFixtureIdMap();
    const items: Item[] = games
      .filter((g) => sportTab(g.sport, g.sport_title) === "SOCCER" && g.status !== "final" && fxMap[g.id] != null)
      .map((g) => ({ game_id: g.id, fixture_id: fxMap[g.id], home: g.home_team, away: g.away_team, corner_line: null }));
    if (!items.length) return { ok: true, warmed: 0, games: 0 };

    const result = await runBatch(items);
    const prev = ((await serverCache.get(KEY))?.data as TakesPayload | undefined)?.games ?? {};
    // Keep a previous non-empty take set if a refresh transiently returns empty.
    const merged: Record<string, GameTakes> = { ...prev };
    for (const [gid, payload] of Object.entries(result)) {
      if (payload && (payload.takes?.length || !merged[gid])) merged[gid] = payload;
    }
    await serverCache.setPersistent(KEY, { refreshedAt: new Date().toISOString(), games: merged } satisfies TakesPayload);
    lastWarmAt = Date.now();
    return { ok: true, warmed: Object.keys(result).length, games: items.length };
  } catch {
    return { ok: false, warmed: 0, games: 0 };
  } finally {
    warming = false;
  }
}

/** Cache-only read for the game page (single Redis GET). The analyst-agent
 * override wins when present (it reasoned over the full grounding); otherwise
 * fall back to the rule-engine take. */
export async function getMatchTakes(gameId: string): Promise<GameTakes | null> {
  try {
    const agent = (await serverCache.get(KEY_AGENT))?.data as AgentPayload | undefined;
    const a = agent?.games?.[gameId];
    if (a && a.takes?.length) return { ...a, source: "agent" };
    const payload = (await serverCache.get(KEY))?.data as TakesPayload | undefined;
    return payload?.games?.[gameId] ?? null;
  } catch {
    return null;
  }
}

/** Write analyst-agent takes for one or more games (override store). Used by the
 * ops route now and by the production agent once a funded key exists. Merges so
 * a partial write never wipes other games. */
export async function writeAgentTakes(games: Record<string, GameTakes>): Promise<{ ok: boolean; wrote: number }> {
  try {
    const prev = ((await serverCache.get(KEY_AGENT))?.data as AgentPayload | undefined)?.games ?? {};
    const merged = { ...prev, ...games };
    await serverCache.setPersistent(KEY_AGENT, { refreshedAt: new Date().toISOString(), games: merged } satisfies AgentPayload);
    return { ok: true, wrote: Object.keys(games).length };
  } catch {
    return { ok: false, wrote: 0 };
  }
}

export async function getAgentTakesPayload(): Promise<AgentPayload | null> {
  try {
    return ((await serverCache.get(KEY_AGENT))?.data as AgentPayload | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function getMatchTakesPayload(): Promise<TakesPayload | null> {
  try {
    return ((await serverCache.get(KEY))?.data as TakesPayload | undefined) ?? null;
  } catch {
    return null;
  }
}
