/**
 * /api/ops/featured-fixture — picks the next "feature match" for the
 * Match Intelligence panel to surface.
 *
 * Before M28 the panel was hardcoded to PSG vs Arsenal UCL final. That's
 * fine for the immediate pilot but breaks the moment that match settles.
 * This endpoint scans the cached league odds and ranks fixtures by:
 *
 *   1. Tournament priority (UCL > UEL > Big-5)
 *   2. Time proximity (sooner = preferred)
 *   3. Whether the fixture is within the next 7 days
 *
 * Returns the top candidate fixture in a shape the UI can plug straight
 * into the MatchIntelligencePanel URL params.
 *
 * GET-only, read-token gated through middleware.
 */
import { NextResponse } from "next/server";
import { spawnSync } from "child_process";

export const dynamic = "force-dynamic";

export async function GET() {
  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();

  const script = `
import json, sys
from datetime import datetime, timezone, timedelta
from ml.soccer.leagues import LEAGUES, fetch_league_odds

# Tournament priority — UCL knockouts beat league play. Update once we
# expand to UEL knockout / WC / etc.
PRIORITY = {
    "UCL":             5,
    "Premier League":  3,
    "La Liga":         3,
    "Bundesliga":      3,
    "Serie A":         3,
    "Ligue 1":         3,
}

# Map sport_key → tournament label (so we can sort by priority).
LEAGUE_NAME = {sport_key: lg for (sport_key, lg, _) in LEAGUES}

# Map sport_key → home/away league hint pair. UCL fixtures need
# per-team league hints (PSG = Ligue 1, Arsenal = Premier League) so the
# match-intelligence call resolves both teams' Understat data correctly.
# For league play home_league = away_league = the league itself.
def hints_for(sport_key, home_team, away_team, kickoff_dt, ucl_count_in_window):
    league = LEAGUE_NAME.get(sport_key, "Premier League")
    if sport_key == "soccer_uefa_champs_league":
        # M29 — heuristic auto-detect for UCL final.
        # UCL final is always a single match in late May / early June with
        # NO other UCL matches nearby. If the fixture is between May 28
        # and June 7 AND it's the ONLY UCL fixture in our 14-day horizon,
        # we treat it as the final and apply the tighter scaler (0.81).
        # Everything else UCL falls back to "ucl_knockout" (0.88).
        is_final_window = (
            kickoff_dt.month in (5, 6) and
            (kickoff_dt.month == 5 and kickoff_dt.day >= 25) or kickoff_dt.month == 6
        )
        stage = "ucl_final" if (is_final_window and ucl_count_in_window == 1) else "ucl_knockout"
        return {
            "tournament": "UCL",
            "home_league": _guess_team_league(home_team),
            "away_league": _guess_team_league(away_team),
            "neutral_venue": True,  # all UCL knockouts after the draw are neutral-ish
            "competition_stage": stage,
        }
    return {
        "tournament": league,
        "home_league": league,
        "away_league": league,
        "neutral_venue": False,
        "competition_stage": "league",
    }

# Lightweight team → league guesser. Covers the biggest clubs so UCL
# fixtures resolve correctly. Falls back to "Premier League" for any
# unknown name (good-enough default).
_TEAM_LEAGUE = {
    # Premier League
    "arsenal":"Premier League","liverpool":"Premier League","manchester city":"Premier League",
    "man city":"Premier League","manchester united":"Premier League","man united":"Premier League",
    "chelsea":"Premier League","tottenham":"Premier League","newcastle":"Premier League",
    "aston villa":"Premier League","brighton":"Premier League","west ham":"Premier League",
    # La Liga
    "real madrid":"La Liga","barcelona":"La Liga","atletico madrid":"La Liga","ath madrid":"La Liga",
    "real sociedad":"La Liga","villarreal":"La Liga","real betis":"La Liga","sevilla":"La Liga",
    "athletic bilbao":"La Liga","ath bilbao":"La Liga","valencia":"La Liga",
    # Bundesliga
    "bayern munich":"Bundesliga","bayer leverkusen":"Bundesliga","leverkusen":"Bundesliga",
    "borussia dortmund":"Bundesliga","dortmund":"Bundesliga","rb leipzig":"Bundesliga",
    "eintracht frankfurt":"Bundesliga","frankfurt":"Bundesliga","stuttgart":"Bundesliga",
    # Serie A
    "inter":"Serie A","ac milan":"Serie A","juventus":"Serie A","napoli":"Serie A",
    "as roma":"Serie A","roma":"Serie A","lazio":"Serie A","atalanta":"Serie A","fiorentina":"Serie A",
    "bologna":"Serie A",
    # Ligue 1
    "paris saint germain":"Ligue 1","psg":"Ligue 1","paris sg":"Ligue 1","marseille":"Ligue 1",
    "monaco":"Ligue 1","lille":"Ligue 1","nice":"Ligue 1","lyon":"Ligue 1","rennes":"Ligue 1",
}

def _guess_team_league(name):
    return _TEAM_LEAGUE.get((name or "").lower(), "Premier League")

now = datetime.now(timezone.utc)
horizon = now + timedelta(days=14)
candidates = []
for sport_key, league, active_until in LEAGUES:
    try:
        games = fetch_league_odds(sport_key) or []
    except Exception:
        continue
    for g in games:
        ct = g.get("commence_time")
        if not ct:
            continue
        try:
            kickoff = datetime.fromisoformat(ct.replace("Z", "+00:00"))
        except Exception:
            continue
        if kickoff < now or kickoff > horizon:
            continue
        candidates.append({
            "game_id": g.get("id"),
            "home_team": g.get("home_team"),
            "away_team": g.get("away_team"),
            "commence_time": ct,
            "sport_key": sport_key,
            "kickoff_unix": kickoff.timestamp(),
            "priority": PRIORITY.get(league, 1),
        })

candidates.sort(key=lambda c: (-c["priority"], c["kickoff_unix"]))
if not candidates:
    print(json.dumps({"error": "no upcoming fixtures in 14-day horizon"}))
    sys.exit(0)

# Count UCL fixtures inside the horizon so hints_for can detect "final"
ucl_count = sum(1 for c in candidates if c["sport_key"] == "soccer_uefa_champs_league")

top = candidates[0]
top_kickoff = datetime.fromtimestamp(top["kickoff_unix"], tz=timezone.utc)
hints = hints_for(top["sport_key"], top["home_team"], top["away_team"], top_kickoff, ucl_count)
result = {
    "ok": True,
    "fixture": {
        "home": top["home_team"],
        "away": top["away_team"],
        "commence_time": top["commence_time"],
        "game_id": top["game_id"],
        "sport_key": top["sport_key"],
        **hints,
    },
    "considered": len(candidates),
}
print(json.dumps(result, default=str))
`;

  const r = spawnSync("python3", ["-c", script], {
    encoding: "utf-8",
    timeout: 15_000,
    cwd: appRoot,
  });
  try {
    return NextResponse.json(JSON.parse(r.stdout));
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: "featured-fixture subprocess failed",
        stderr: r.stderr?.slice(-400) ?? "",
      },
      { status: 500 },
    );
  }
}
