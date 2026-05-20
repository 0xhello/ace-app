/**
 * /api/ops/wc-players — the WC player intelligence endpoint.
 *
 * Aggregates everything we know about WC-relevant players into one
 * payload for the Soccer tab's PlayerPriorsPanel:
 *   - wc_historical_form: StatsBomb + API-Football intl tournament data
 *     (2,924 rows on prod after Chunk 1's historical pull). Goals/minutes
 *     per player per competition.
 *   - wc_players: API-Football squad rosters (empty until the worker's
 *     daily 7:30am ET sync — or a manual run — populates them).
 *   - wc_player_priors: computed goalscorer priors, written by the
 *     priors CLI (anytime_scorer_prob, first_scorer_prob, etc.).
 *
 * Each present table contributes what it can; missing ones don't fail
 * the response. The panel renders whatever's available, with explicit
 * empty/coming-soon states for the rest.
 *
 * Auth: gated by /api/ops/* middleware (admin only).
 */
import { NextResponse } from "next/server";
import { spawnSync } from "child_process";
import path from "path";

export const dynamic = "force-dynamic";

export interface PlayerAggregate {
  player_name: string;
  country: string | null;
  // Career totals across cached tournaments
  total_goals: number;
  total_minutes: number;
  total_matches: number;
  comps_count: number;            // distinct competitions we have data for
  comps: string[];                // e.g. ['WC 2022','Euro 2024','UEFA NL 2024']
  goals_per_90: number | null;    // null when total_minutes < 180
  latest_comp: string | null;     // most recent comp the player appears in
  latest_goals: number;
  latest_minutes: number;
  // Optional joins
  api_player_id: number | null;   // if squad sync has run
  position: string | null;        // from wc_players
  age: number | null;
  shirt_number: number | null;
  team_name: string | null;       // squad's team_name (may differ from country)
  // Computed prior (when wc_player_priors exists)
  anytime_scorer_prob: number | null;
  first_scorer_prob: number | null;
  expected_goals_lambda: number | null;
}

interface Response {
  players: PlayerAggregate[];
  meta: {
    historical_rows: number;
    historical_competitions: string[];
    squads_rows: number;
    priors_rows: number;
    refreshed_at: string;
  };
  error?: string;
}

function readData(dbPath: string): Response {
  // One Python subprocess does all 3 reads + aggregation. SQLite is cheap;
  // doing the aggregate here keeps the TS side a pure render.
  const script = `
import json, os, sqlite3, sys
from collections import defaultdict

db_path = ${JSON.stringify(dbPath)}
out = {
    "players": [],
    "meta": {
        "historical_rows": 0,
        "historical_competitions": [],
        "squads_rows": 0,
        "priors_rows": 0,
    },
}

try:
    if not os.path.exists(db_path):
        out["error"] = "wc_signal_log.db missing"
        print(json.dumps(out))
        sys.exit(0)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    def table_exists(name):
        r = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (name,)
        ).fetchone()
        return r is not None

    # ── Historical aggregates per player ───────────────────────────────
    hist = []
    if table_exists("wc_historical_form"):
        hist = [dict(r) for r in conn.execute(
            "SELECT player_name, competition, country, matches_played, minutes, "
            "       goals, shots, shots_on_target, assists "
            "FROM wc_historical_form"
        ).fetchall()]
        out["meta"]["historical_rows"] = len(hist)
        comps = sorted({r["competition"] for r in hist})
        out["meta"]["historical_competitions"] = comps

    # Order competitions by recency so 'latest_comp' picks the most current
    def comp_year(c):
        import re
        m = re.search(r"(20\\d{2})", c or "")
        return int(m.group(1)) if m else 0

    agg = {}
    for r in hist:
        name = r["player_name"]
        a = agg.setdefault(name, {
            "player_name": name,
            "country": r["country"],
            "total_goals": 0, "total_minutes": 0, "total_matches": 0,
            "comps": [],
            "latest_comp": None, "latest_year": -1,
            "latest_goals": 0, "latest_minutes": 0,
        })
        a["country"] = a["country"] or r["country"]
        a["total_goals"]   += r["goals"]   or 0
        a["total_minutes"] += r["minutes"] or 0
        a["total_matches"] += r["matches_played"] or 0
        a["comps"].append(r["competition"])
        y = comp_year(r["competition"])
        if y > a["latest_year"]:
            a["latest_year"] = y
            a["latest_comp"] = r["competition"]
            a["latest_goals"] = r["goals"] or 0
            a["latest_minutes"] = r["minutes"] or 0

    # ── Squad joins ────────────────────────────────────────────────────
    squads_by_name = {}
    if table_exists("wc_players"):
        rows = [dict(r) for r in conn.execute(
            "SELECT api_player_id, player_name, team_name, position, age, shirt_number "
            "FROM wc_players"
        ).fetchall()]
        out["meta"]["squads_rows"] = len(rows)
        for r in rows:
            squads_by_name[r["player_name"]] = r

    # ── Prior joins (by api_player_id) ─────────────────────────────────
    priors_by_pid = {}
    if table_exists("wc_player_priors"):
        rows = [dict(r) for r in conn.execute(
            "SELECT api_player_id, anytime_scorer_prob, first_scorer_prob, expected_goals_in_match "
            "FROM wc_player_priors WHERE match_game_id IS NULL"
        ).fetchall()]
        out["meta"]["priors_rows"] = len(rows)
        for r in rows:
            priors_by_pid[r["api_player_id"]] = r

    # ── Assemble ───────────────────────────────────────────────────────
    players = []
    for name, a in agg.items():
        squad = squads_by_name.get(name)
        pid   = squad["api_player_id"] if squad else None
        prior = priors_by_pid.get(pid) if pid is not None else None
        gpm = None
        if a["total_minutes"] >= 180:
            gpm = a["total_goals"] / (a["total_minutes"] / 90.0)
        players.append({
            "player_name":     name,
            "country":         a["country"],
            "total_goals":     a["total_goals"],
            "total_minutes":   a["total_minutes"],
            "total_matches":   a["total_matches"],
            "comps_count":     len(a["comps"]),
            "comps":           sorted(a["comps"], key=comp_year, reverse=True),
            "goals_per_90":    round(gpm, 3) if gpm is not None else None,
            "latest_comp":     a["latest_comp"],
            "latest_goals":    a["latest_goals"],
            "latest_minutes":  a["latest_minutes"],
            "api_player_id":   pid,
            "position":        squad["position"]     if squad else None,
            "age":             squad["age"]          if squad else None,
            "shirt_number":    squad["shirt_number"] if squad else None,
            "team_name":       squad["team_name"]    if squad else None,
            "anytime_scorer_prob":    prior["anytime_scorer_prob"]    if prior else None,
            "first_scorer_prob":      prior["first_scorer_prob"]      if prior else None,
            "expected_goals_lambda":  prior["expected_goals_in_match"] if prior else None,
        })

    # Default sort: career goals desc, secondary by goals/90 desc
    players.sort(key=lambda p: (-p["total_goals"], -(p["goals_per_90"] or 0)))
    out["players"] = players
    conn.close()
except Exception as e:
    out["error"] = str(e)

print(json.dumps(out))
`;
  const r = spawnSync("python3", ["-c", script], { encoding: "utf-8", timeout: 8_000 });
  try {
    const parsed = JSON.parse(r.stdout) as Response;
    parsed.meta.refreshed_at = new Date().toISOString();
    return parsed;
  } catch {
    return {
      players: [],
      meta: {
        historical_rows: 0,
        historical_competitions: [],
        squads_rows: 0,
        priors_rows: 0,
        refreshed_at: new Date().toISOString(),
      },
      error: r.stderr?.slice(-300) || "parse_failed",
    };
  }
}

export async function GET() {
  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
  const dbPath = path.join(appRoot, "ml", "nba_spread", "data", "wc_signal_log.db");
  return NextResponse.json(readData(dbPath));
}
