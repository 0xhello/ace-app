/**
 * /api/ops/soccer/sync-board-intel — safe board-level controller for soccer game intel.
 *
 * Default is status-only: reads local DB/cache and spends no provider credits.
 * Use explicit flags for network work:
 *   - ?map=true   maps unmapped games, up to ?limit=N
 *   - ?sync=true  syncs already-mapped games, up to ?limit=N
 */
import { NextRequest, NextResponse } from "next/server";
import { spawnSync } from "child_process";
import * as serverCache from "@/lib/server-cache";
import { fetchAllGames } from "@/lib/odds-api";
import { getMockGames } from "@/lib/mock-games";
import type { Game } from "@/types/game";

export const dynamic = "force-dynamic";

const BOARD_KEY = "board-games";
const IS_DEV = process.env.NODE_ENV !== "production";

async function boardGames(): Promise<{ games: Game[]; source: string }> {
  try {
    const entry = await serverCache.get(BOARD_KEY);
    const games = (entry?.data?.games ?? []) as Game[];
    if (games.length) return { games, source: "board-cache" };
  } catch { /* ignore */ }

  try {
    const result = await fetchAllGames();
    if (result.games?.length) return { games: result.games, source: "odds-refresh" };
  } catch { /* ignore */ }

  if (IS_DEV) return { games: getMockGames(), source: "dev-mock" };
  return { games: [], source: "none" };
}

function pyBool(v: boolean): string {
  return v ? "True" : "False";
}

export async function GET(req: NextRequest) {
  const shouldMap = req.nextUrl.searchParams.get("map") === "true";
  const shouldSync = req.nextUrl.searchParams.get("sync") === "true";
  const limitRaw = Number(req.nextUrl.searchParams.get("limit") ?? "12");
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(24, Math.floor(limitRaw))) : 12;
  const horizonHoursRaw = Number(req.nextUrl.searchParams.get("horizonHours") ?? "240");
  const horizonHours = Number.isFinite(horizonHoursRaw) ? Math.max(1, Math.min(720, Math.floor(horizonHoursRaw))) : 240;

  const { games, source } = await boardGames();
  const now = Date.now();
  const soccerGames = games
    .filter((g) => g.sport.startsWith("soccer"))
    .filter((g) => {
      const t = new Date(g.commence_time).getTime();
      if (!Number.isFinite(t)) return false;
      const hours = (t - now) / 3_600_000;
      return hours >= -6 && hours <= horizonHours;
    })
    .sort((a, b) => new Date(a.commence_time).getTime() - new Date(b.commence_time).getTime())
    .slice(0, limit);

  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
  const script = `
import json, sqlite3, sys
from ml.world_cup.signal_logger import DB_PATH
from ml.soccer.live_state import (
    init_db,
    fixture_mappings,
    find_sportmonks_fixture_for_game,
    upsert_fixture_mapping,
    sync_sportmonks_fixture,
)

games = ${JSON.stringify(soccerGames)}
should_map = ${pyBool(shouldMap)}
should_sync = ${pyBool(shouldSync)}
init_db()

def public_mapping(m):
    if not m:
        return None
    return {
        "game_id": m.get("game_id"),
        "provider_fixture_id": str(m.get("provider_fixture_id")) if m.get("provider_fixture_id") is not None else None,
        "home_team": m.get("home_team"),
        "away_team": m.get("away_team"),
        "commence_time": m.get("commence_time"),
        "confidence": m.get("confidence"),
        "updated_at": m.get("updated_at"),
    }

def snapshot_for(conn, game_id):
    row = conn.execute("SELECT * FROM soccer_fixture_feature_snapshot WHERE game_id = ? AND provider = 'sportmonks'", (game_id,)).fetchone()
    if not row:
        return None
    latest_history = conn.execute("""
      SELECT COUNT(*) AS c, MAX(created_at) AS latest_at
        FROM soccer_fixture_feature_history
       WHERE game_id = ? AND provider = 'sportmonks'
    """, (game_id,)).fetchone()
    return {
        "provider_fixture_id": row["provider_fixture_id"],
        "state_name": row["state_name"],
        "lineup_count": row["lineup_count"],
        "starters_count": row["starters_count"],
        "bench_count": row["bench_count"],
        "sidelined_count": row["sidelined_count"],
        "event_count": row["event_count"],
        "statistic_count": row["statistic_count"],
        "updated_at": row["updated_at"],
        "history_count": latest_history["c"] if latest_history else 0,
        "latest_history_at": latest_history["latest_at"] if latest_history else None,
    }

out = {"ok": True, "mode": {"map": should_map, "sync": should_sync}, "checked": len(games), "mapped_now": 0, "synced": 0, "games": [], "errors": []}
try:
    maps = {m.get("game_id"): public_mapping(m) for m in fixture_mappings(provider="sportmonks")}
    conn = sqlite3.connect(DB_PATH); conn.row_factory = sqlite3.Row
    for game in games:
        item = {
            "game_id": game.get("id"),
            "sport": game.get("sport"),
            "home_team": game.get("home_team"),
            "away_team": game.get("away_team"),
            "commence_time": game.get("commence_time"),
            "mapping": maps.get(game.get("id")),
            "feature_snapshot": snapshot_for(conn, game.get("id")),
            "mapped_now": False,
            "synced": False,
        }
        try:
            if should_map and not item["mapping"]:
                match = find_sportmonks_fixture_for_game(game)
                if match:
                    upsert_fixture_mapping({
                        "game_id": game["id"],
                        "sport_key": game.get("sport"),
                        "provider": "sportmonks",
                        "provider_fixture_id": str(match["id"]),
                        "home_team": game.get("home_team"),
                        "away_team": game.get("away_team"),
                        "commence_time": game.get("commence_time"),
                        "confidence": "auto_team_time",
                        "raw_json": match,
                    })
                    item["mapping"] = {
                        "game_id": game.get("id"),
                        "provider_fixture_id": str(match["id"]),
                        "home_team": game.get("home_team"),
                        "away_team": game.get("away_team"),
                        "commence_time": game.get("commence_time"),
                        "confidence": "auto_team_time",
                    }
                    item["mapped_now"] = True
                    out["mapped_now"] += 1
                else:
                    item["mapping_error"] = "no match"
            fixture_id = (item.get("mapping") or {}).get("provider_fixture_id")
            if should_sync and fixture_id:
                item["sync_result"] = sync_sportmonks_fixture(game["id"], fixture_id)
                item["synced"] = bool(item["sync_result"].get("ok"))
                item["feature_snapshot"] = snapshot_for(conn, game.get("id"))
                out["synced"] += 1 if item["synced"] else 0
            elif should_sync and not fixture_id:
                item["sync_error"] = "no mapping"
        except Exception as e:
            item["error"] = str(e)[:240]
            out["errors"].append({"game_id": game.get("id"), "error": item["error"]})
        out["games"].append(item)
    conn.close()
    print(json.dumps(out, ensure_ascii=False, default=str))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)[:400]})); sys.exit(1)
`;

  const result = spawnSync("python3", ["-c", script], {
    cwd: appRoot,
    encoding: "utf-8",
    timeout: shouldSync || shouldMap ? 180_000 : 20_000,
  });

  try {
    return NextResponse.json({ ...JSON.parse(result.stdout), board_source: source, limit, horizonHours, exitCode: result.status ?? -1 });
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: "sync-board-intel subprocess failed to return JSON",
        board_source: source,
        exitCode: result.status ?? -1,
        stderr_tail: (result.stderr ?? "").slice(-800),
        stdout_tail: (result.stdout ?? "").slice(-800),
      },
      { status: 500 },
    );
  }
}
