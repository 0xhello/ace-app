/**
 * /api/ops/soccer/sync-game-intel — targeted soccer game → Sportmonks mapping/sync.
 *
 * Proper game-page data route:
 *   - default: status only, reads local cache/mapping and spends no provider credits
 *   - ?map=true: searches Sportmonks for this one fixture and stores mapping
 *   - ?sync=true: fetches this one mapped fixture's lineup/sidelined/event/stat state
 *
 * This intentionally avoids broad slate sync from the game page workflow.
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

async function getGameForOps(gameId: string): Promise<{ game: Game | null; source: string }> {
  try {
    const entry = await serverCache.get(BOARD_KEY);
    const hit = ((entry?.data?.games ?? []) as Game[]).find((g) => g.id === gameId);
    if (hit) return { game: hit, source: "board-cache" };
  } catch { /* ignore */ }

  try {
    const result = await fetchAllGames();
    const hit = (result.games ?? []).find((g) => g.id === gameId) ?? null;
    if (hit) return { game: hit, source: "odds-refresh" };
  } catch { /* ignore */ }

  if (IS_DEV) {
    const hit = getMockGames().find((g) => g.id === gameId) ?? null;
    if (hit) return { game: hit, source: "dev-mock" };
  }

  return { game: null, source: "none" };
}

function pyBool(v: boolean): string {
  return v ? "True" : "False";
}

export async function GET(req: NextRequest) {
  const gameId = req.nextUrl.searchParams.get("game_id")?.trim();
  const shouldMap = req.nextUrl.searchParams.get("map") === "true";
  const shouldSync = req.nextUrl.searchParams.get("sync") === "true";

  if (!gameId) {
    return NextResponse.json({ ok: false, error: "Missing required ?game_id" }, { status: 400 });
  }

  const { game, source: gameSource } = await getGameForOps(gameId);
  if (!game) {
    return NextResponse.json({ ok: false, error: "Game not found", game_id: gameId }, { status: 404 });
  }
  if (!game.sport.startsWith("soccer")) {
    return NextResponse.json({ ok: false, error: "sync-game-intel is soccer-only", game_id: gameId, sport: game.sport }, { status: 400 });
  }

  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
  const script = `
import json, sqlite3, sys
from ml.world_cup.signal_logger import DB_PATH
from ml.soccer.live_state import (
    fixture_mappings,
    find_sportmonks_fixture_for_game,
    upsert_fixture_mapping,
    sync_sportmonks_fixture,
)
from ml.soccer.sportmonks_fixture import get_cached_bundle_by_teams

game = ${JSON.stringify(game)}
should_map = ${pyBool(shouldMap)}
should_sync = ${pyBool(shouldSync)}

def public_mapping(m):
    if not m:
        return None
    return {
        "id": m.get("id"),
        "game_id": m.get("game_id"),
        "sport_key": m.get("sport_key"),
        "provider": m.get("provider"),
        "provider_fixture_id": str(m.get("provider_fixture_id")) if m.get("provider_fixture_id") is not None else None,
        "home_team": m.get("home_team"),
        "away_team": m.get("away_team"),
        "commence_time": m.get("commence_time"),
        "confidence": m.get("confidence"),
        "detected_at": m.get("detected_at"),
        "updated_at": m.get("updated_at"),
    }

out = {
  "ok": True,
  "game_id": game.get("id"),
  "sport": game.get("sport"),
  "home_team": game.get("home_team"),
  "away_team": game.get("away_team"),
  "mode": {"map": should_map, "sync": should_sync},
  "game_source": ${JSON.stringify(gameSource)},
  "mapping": None,
  "mapped_now": False,
  "sync_result": None,
  "bundle": None,
  "feature_snapshot": None,
  "credits_note": "status-only uses local cache; map/sync may call Sportmonks",
}

try:
    maps = fixture_mappings(provider="sportmonks")
    existing = next((m for m in maps if m.get("game_id") == game.get("id")), None)
    if existing:
        out["mapping"] = public_mapping(existing)

    if should_map and not out["mapping"]:
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
            out["mapped_now"] = True
            out["mapping"] = {
                "game_id": game.get("id"),
                "sport_key": game.get("sport"),
                "provider": "sportmonks",
                "provider_fixture_id": str(match["id"]),
                "confidence": "auto_team_time",
                "home_team": game.get("home_team"),
                "away_team": game.get("away_team"),
                "commence_time": game.get("commence_time"),
            }
        else:
            out["mapping_error"] = "no Sportmonks fixture match found"

    fixture_id = (out.get("mapping") or {}).get("provider_fixture_id")
    if should_sync and fixture_id:
        out["sync_result"] = sync_sportmonks_fixture(game["id"], fixture_id)
    elif should_sync and not fixture_id:
        out["sync_error"] = "no fixture mapping; call with map=true first"

    bundle = get_cached_bundle_by_teams(
        game.get("home_team") or "",
        game.get("away_team") or "",
        commence_time_iso=game.get("commence_time"),
        window_hours=72,
    ) or get_cached_bundle_by_teams(
        game.get("away_team") or "",
        game.get("home_team") or "",
        commence_time_iso=game.get("commence_time"),
        window_hours=72,
    )
    if bundle:
        out["bundle"] = {
            "fixture_id": str(bundle.get("fixture_id")),
            "league_name": bundle.get("league_name"),
            "starting_at": bundle.get("starting_at"),
            "home_team_name": bundle.get("home_team_name"),
            "away_team_name": bundle.get("away_team_name"),
            "lineups": len(bundle.get("lineups") or []),
            "predictions": len(bundle.get("predictions") or {}),
            "events": len(bundle.get("events") or []),
            "fetched_at": bundle.get("fetched_at"),
            "settled_at": bundle.get("settled_at"),
        }

    try:
        conn = sqlite3.connect(DB_PATH); conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT * FROM soccer_fixture_feature_snapshot WHERE game_id = ? AND provider = 'sportmonks'",
            (game.get("id"),),
        ).fetchone()
        if row:
            out["feature_snapshot"] = {
                "provider_fixture_id": row["provider_fixture_id"],
                "state_name": row["state_name"],
                "lineup_count": row["lineup_count"],
                "starters_count": row["starters_count"],
                "bench_count": row["bench_count"],
                "sidelined_count": row["sidelined_count"],
                "event_count": row["event_count"],
                "statistic_count": row["statistic_count"],
                "updated_at": row["updated_at"],
            }
        unavailable = conn.execute("""
          SELECT player_name, team, unavailable_reason
            FROM soccer_player_feature_snapshot
           WHERE game_id = ?
             AND provider = 'sportmonks'
             AND (availability = 'out' OR lineup_status = 'out')
           ORDER BY team, player_name
           LIMIT 12
        """, (game.get("id"),)).fetchall()
        if unavailable:
            out["unavailable"] = [
              {"playerName": r["player_name"], "teamName": r["team"], "reason": r["unavailable_reason"]}
              for r in unavailable
            ]
        conn.close()
    except Exception as e:
        out["feature_snapshot_error"] = str(e)[:160]

    print(json.dumps(out, ensure_ascii=False, default=str))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)[:400], "game_id": game.get("id")})); sys.exit(1)
`;

  const result = spawnSync("python3", ["-c", script], {
    cwd: appRoot,
    encoding: "utf-8",
    timeout: shouldSync || shouldMap ? 60_000 : 8_000,
  });

  try {
    const parsed = JSON.parse(result.stdout);
    return NextResponse.json({ ...parsed, exitCode: result.status ?? -1 });
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: "sync-game-intel subprocess failed to return JSON",
        exitCode: result.status ?? -1,
        stderr_tail: (result.stderr ?? "").slice(-600),
        stdout_tail: (result.stdout ?? "").slice(-400),
      },
      { status: 500 },
    );
  }
}
