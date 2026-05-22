/**
 * /api/ops/wc-readiness — at-a-glance "is the soccer pipeline fully wired?"
 *
 * Surfaces the things that go silently wrong:
 *   - Is API_FOOTBALL_KEY set on the container?  (boolean, never the value)
 *   - Is ODDS_API_KEY set?                       (boolean)
 *   - Are squads populated?                      (row counts)
 *   - Are priors populated?
 *   - Are historical_form rows present?
 *   - What was the last players_sync error?
 *
 * One curl/glance answers "why aren't I seeing player-prop picks yet?"
 * instead of digging through three different routes and a SQLite DB.
 *
 * Read-only — safe behind OPS_READ_TOKEN.
 */
import { NextResponse } from "next/server";
import { spawnSync } from "child_process";
import path from "path";

export const dynamic = "force-dynamic";

export async function GET() {
  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
  const dbPath = path.join(appRoot, "ml", "nba_spread", "data", "wc_signal_log.db");

  const script = `
import json, os, sqlite3, sys
from pathlib import Path
db = Path(${JSON.stringify(dbPath)})

api_key = os.getenv("API_FOOTBALL_KEY", "").strip()
via_rapidapi = os.getenv("API_FOOTBALL_VIA_RAPIDAPI", "").lower() in ("1", "true", "yes")

out = {
    "env": {
        "API_FOOTBALL_KEY":            bool(api_key),
        "API_FOOTBALL_VIA_RAPIDAPI":   os.getenv("API_FOOTBALL_VIA_RAPIDAPI", "(unset)"),
        "ODDS_API_KEY":                bool(os.getenv("ODDS_API_KEY", "").strip()),
        "WC_PLAYER_PROPS_ENABLED":      os.getenv("WC_PLAYER_PROPS_ENABLED", "(unset)"),
        "WC_PLAYER_PROPS_CLUB_LEAGUES": os.getenv("WC_PLAYER_PROPS_CLUB_LEAGUES", "(unset)"),
    },
    "counts": {"historical": 0, "squads": 0, "club_players": 0, "priors": 0},
    "jobs": {},
    "api_test": None,
    "ready_for_player_props": False,
    "blockers": [],
}

# Live API-Football test — single call with the prod env to surface the
# actual underlying error (plan restriction / quota / wrong host / etc).
# Costs 1 call. Returns the response so we can see if it's a key issue,
# plan issue, or something else.
if api_key:
    try:
        import httpx
        if via_rapidapi:
            url = "https://api-football-v3.p.rapidapi.com/v3/status"
            headers = {
                "X-RapidAPI-Key":  api_key,
                "X-RapidAPI-Host": "api-football-v3.p.rapidapi.com",
            }
        else:
            url = "https://v3.football.api-sports.io/status"
            headers = {"x-apisports-key": api_key}
        r = httpx.get(url, headers=headers, timeout=8)
        body = {}
        try: body = r.json()
        except Exception: body = {"raw": r.text[:300]}
        test = {
            "status_code": r.status_code,
            "via_rapidapi": via_rapidapi,
            "errors": body.get("errors") if isinstance(body, dict) else None,
            "account": (body.get("response", {}) or {}).get("account") if isinstance(body, dict) else None,
            "requests_today": (body.get("response", {}) or {}).get("requests") if isinstance(body, dict) else None,
            "subscription": (body.get("response", {}) or {}).get("subscription") if isinstance(body, dict) else None,
        }
        # Country-probe — what does /teams?country=X return for a few
        # known WC qualifiers? If hyphenated names ("Czech-Republic")
        # silently return 0 teams while the unhyphenated variant works,
        # that's our bug.
        try:
            country_test: dict = {}
            base_t = "https://api-football-v3.p.rapidapi.com/v3/teams" if via_rapidapi \
                     else "https://v3.football.api-sports.io/teams"
            for sample in ["France", "Czech-Republic", "Czech Republic",
                           "South-Korea", "South Korea", "USA"]:
                rr = httpx.get(base_t, headers=headers,
                               params={"country": sample}, timeout=8)
                jb = {}
                try: jb = rr.json()
                except Exception: pass
                resp_list = (jb.get("response", []) if isinstance(jb, dict) else []) or []
                # Count national teams (filter out clubs)
                national = [t for t in resp_list
                            if isinstance(t, dict)
                            and (t.get("team", {}) or {}).get("national")]
                country_test[sample] = {
                    "http": rr.status_code,
                    "total_teams_returned": len(resp_list),
                    "national_teams": len(national),
                    "errors": jb.get("errors") if isinstance(jb, dict) else None,
                }
            test["country_probe"] = country_test
        except Exception as e:
            test["country_probe_error"] = str(e)[:200]

        out["api_test"] = test
        if r.status_code == 401 or r.status_code == 403:
            out["blockers"].append(
                f"API-Football auth failed ({r.status_code}). Key may be wrong host — "
                f"try setting API_FOOTBALL_VIA_RAPIDAPI=true (or vice versa)."
            )
        elif isinstance(body, dict):
            err = body.get("errors")
            if isinstance(err, dict) and err:
                out["blockers"].append(f"API-Football reported error: {err}")
    except Exception as e:
        out["api_test"] = {"error": str(e)[:200]}
        out["blockers"].append(f"API-Football test call failed: {str(e)[:200]}")

if not db.exists():
    out["blockers"].append("wc_signal_log.db does not exist on this container")
    print(json.dumps(out)); sys.exit(0)

try:
    conn = sqlite3.connect(str(db))
    conn.row_factory = sqlite3.Row

    def count(table):
        try:
            r = conn.execute(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", (table,)
            ).fetchone()
            if not r or r[0] == 0: return 0
            return int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
        except Exception:
            return 0

    out["counts"]["historical"]    = count("wc_historical_form")
    out["counts"]["squads"]        = count("wc_players")
    out["counts"]["club_players"]  = count("club_players")
    out["counts"]["priors"]        = count("wc_player_priors")

    # Job state — the meta key the worker writes when sync_all_players runs
    try:
        for k, v in conn.execute(
            "SELECT key, value FROM meta WHERE key LIKE 'job:players_sync:%'"
        ).fetchall():
            out["jobs"][k.replace("job:players_sync:", "")] = v
    except Exception:
        pass

    # Last bootstrap output — captured stdout/stderr from the worker's
    # bootstrap call. Tells us exactly what sync_all_players printed
    # without grepping Railway logs.
    try:
        for k in ("bootstrap:last_stdout", "bootstrap:last_stderr"):
            r = conn.execute("SELECT value FROM meta WHERE key = ?", (k,)).fetchone()
            if r:
                short_key = k.replace("bootstrap:last_", "")
                out["jobs"][f"bootstrap_{short_key}"] = r[0][-2000:]
    except Exception:
        pass

    conn.close()
except Exception as e:
    out["blockers"].append(f"db read failed: {str(e)[:200]}")

# Synthesize blockers
if not out["env"]["ODDS_API_KEY"]:
    out["blockers"].append("ODDS_API_KEY not set on Railway — needed for any signal scanning")
if not out["env"]["API_FOOTBALL_KEY"]:
    out["blockers"].append(
        "API_FOOTBALL_KEY not set on Railway — needed for squad sync. "
        "Add it under Variables in the Railway dashboard."
    )
if out["counts"]["historical"] == 0:
    out["blockers"].append("Historical StatsBomb data missing — run the historical pull")
if out["counts"]["squads"] == 0 and out["counts"]["club_players"] == 0:
    last_err = out["jobs"].get("last_error", "")
    if last_err:
        out["blockers"].append(f"Squad sync failing: {last_err[:200]}")
    elif out["env"]["API_FOOTBALL_KEY"]:
        out["blockers"].append("Squad sync hasn't run yet — worker will bootstrap on next tick")
if out["counts"]["priors"] == 0 and out["counts"]["squads"] > 0:
    out["blockers"].append("Priors not yet computed — worker will auto-chain on next sync")

out["ready_for_player_props"] = (
    out["env"]["ODDS_API_KEY"]
    and out["counts"]["priors"] > 0
)

print(json.dumps(out))
`;
  const r = spawnSync("python3", ["-c", script], { encoding: "utf-8", timeout: 5_000, cwd: appRoot });
  try {
    return NextResponse.json(JSON.parse(r.stdout));
  } catch {
    return NextResponse.json({
      error: "readiness probe failed",
      stderr: r.stderr?.slice(-500) ?? "",
    }, { status: 500 });
  }
}
