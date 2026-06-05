/**
 * /api/ops/soccer/sync-friendly-intel — data-only international-friendly rehearsal lane.
 *
 * This is NOT a picks route. It discovers Sportmonks Friendly International
 * fixtures, assigns stable ACE rehearsal game IDs, and optionally syncs the
 * same fixture/player live-state tables used by Match Read.
 *
 * Default: discover/map only, limited. Use ?sync=true explicitly to fetch
 * fixture state for the discovered fixtures.
 */
import { NextRequest, NextResponse } from "next/server";
import { spawnSync } from "child_process";

export const dynamic = "force-dynamic";

function pyBool(v: boolean): string {
  return v ? "True" : "False";
}

export async function GET(req: NextRequest) {
  const daysRaw = Number(req.nextUrl.searchParams.get("days") ?? "7");
  const limitRaw = Number(req.nextUrl.searchParams.get("limit") ?? "8");
  const shouldSync = req.nextUrl.searchParams.get("sync") === "true";
  const days = Number.isFinite(daysRaw) ? Math.max(1, Math.min(21, Math.floor(daysRaw))) : 7;
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(24, Math.floor(limitRaw))) : 8;
  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();

  const script = `
import json, sqlite3, sys
from ml.world_cup.signal_logger import DB_PATH
from ml.soccer.friendlies import discover_friendlies
from ml.soccer.live_state import init_db, upsert_fixture_mapping, sync_sportmonks_fixture

days = ${days}
limit = ${limit}
should_sync = ${pyBool(shouldSync)}

def game_id_for(fid):
    return f"friendly_{fid}"

def snapshot_for(conn, game_id):
    row = conn.execute("SELECT * FROM soccer_fixture_feature_snapshot WHERE game_id = ? AND provider = 'sportmonks'", (game_id,)).fetchone()
    if not row:
        return None
    hist = conn.execute("""
      SELECT COUNT(*) AS c, MAX(created_at) AS latest_at
        FROM soccer_fixture_feature_history
       WHERE game_id = ? AND provider = 'sportmonks'
    """, (game_id,)).fetchone()
    unavailable = conn.execute("""
      SELECT player_name, team, unavailable_reason
        FROM soccer_player_feature_snapshot
       WHERE game_id = ?
         AND provider = 'sportmonks'
         AND (availability = 'out' OR lineup_status = 'out')
       ORDER BY team, player_name
       LIMIT 12
    """, (game_id,)).fetchall()
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
        "history_count": hist["c"] if hist else 0,
        "latest_history_at": hist["latest_at"] if hist else None,
        "unavailable": [
            {"playerName": r["player_name"], "teamName": r["team"], "reason": r["unavailable_reason"]}
            for r in unavailable
        ],
    }

try:
    init_db()
    fixtures = discover_friendlies(days=days)[:limit]
    out = {
        "ok": True,
        "mode": {"sync": should_sync},
        "scope": "friendlies_rehearsal_data_only",
        "note": "Friendlies are live rehearsal fixtures only; no ACE-validated picks implied.",
        "days": days,
        "limit": limit,
        "discovered": len(fixtures),
        "mapped": 0,
        "synced": 0,
        "fixtures": [],
        "errors": [],
    }
    conn = sqlite3.connect(DB_PATH); conn.row_factory = sqlite3.Row
    for fx in fixtures:
        fid = fx.get("fixture_id")
        gid = game_id_for(fid)
        item = {
            "game_id": gid,
            "sport": "soccer_international_friendly",
            "sport_title": "International Friendly",
            "provider_fixture_id": str(fid),
            "home_team": fx.get("home"),
            "away_team": fx.get("away"),
            "name": fx.get("name"),
            "commence_time": fx.get("starting_at"),
            "mapped": False,
            "synced": False,
            "feature_snapshot": snapshot_for(conn, gid),
        }
        try:
            upsert_fixture_mapping({
                "game_id": gid,
                "sport_key": "soccer_international_friendly",
                "provider": "sportmonks",
                "provider_fixture_id": str(fid),
                "home_team": fx.get("home"),
                "away_team": fx.get("away"),
                "commence_time": fx.get("starting_at"),
                "confidence": "sportmonks_friendly_fixture",
                "raw_json": fx,
            })
            item["mapped"] = True
            out["mapped"] += 1
            if should_sync:
                item["sync_result"] = sync_sportmonks_fixture(gid, str(fid))
                item["synced"] = bool(item["sync_result"].get("ok"))
                item["feature_snapshot"] = snapshot_for(conn, gid)
                out["synced"] += 1 if item["synced"] else 0
        except Exception as exc:
            item["error"] = str(exc)[:240]
            out["errors"].append({"fixture_id": fid, "error": item["error"]})
        out["fixtures"].append(item)
    conn.close()
    print(json.dumps(out, ensure_ascii=False, default=str))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)[:400]})); sys.exit(1)
`;

  const start = Date.now();
  const result = spawnSync("python3", ["-c", script], {
    cwd: appRoot,
    encoding: "utf-8",
    timeout: shouldSync ? 180_000 : 45_000,
  });
  const durationSec = Math.round((Date.now() - start) / 1000);

  try {
    return NextResponse.json({ ...JSON.parse(result.stdout), durationSec, exitCode: result.status ?? -1 });
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: "sync-friendly-intel subprocess failed to return JSON",
        durationSec,
        exitCode: result.status ?? -1,
        stderr_tail: (result.stderr ?? "").slice(-800),
        stdout_tail: (result.stdout ?? "").slice(-800),
      },
      { status: 500 },
    );
  }
}
