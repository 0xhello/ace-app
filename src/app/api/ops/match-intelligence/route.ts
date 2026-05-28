/**
 * /api/ops/match-intelligence — the trading-desk view per fixture.
 *
 * Bob's direction (May 2026): ACE should treat soccer picks as a football
 * intelligence + trading desk system. We build our own pre-odds opinion
 * for every market we have signal for, THEN compare to the books, surface
 * disagreements as edges, and give a confidence tier per market.
 *
 * Query params:
 *   home   — home team name (Sportmonks / candidate-scanner format)
 *   away   — away team name
 *   home_league — league hint for home team's xG history lookup
 *                  (e.g. "Ligue 1" for PSG). Optional but recommended.
 *   away_league — same for away team (e.g. "Premier League" for Arsenal).
 *   tournament — match's tournament tag ("UCL", "World Cup", "Premier League").
 *   game_id — Odds API game id (optional; used for odds lookup later).
 *   neutral_venue=1 — UCL final etc. (default true for UCL)
 *
 * GET-only so it works with OPS_READ_TOKEN through the middleware.
 *
 * Spawns a Python subprocess that calls intelligence_for_match(), so the
 * fair-probability math, M7/M8/M9 adjustments, and shrinkage all run with
 * the canonical model implementation rather than being re-implemented in TS.
 */
import { NextRequest, NextResponse } from "next/server";
import { spawnSync } from "child_process";
import path from "path";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const home = req.nextUrl.searchParams.get("home")?.trim();
  const away = req.nextUrl.searchParams.get("away")?.trim();
  if (!home || !away) {
    return NextResponse.json(
      { error: "Missing required ?home and ?away params" },
      { status: 400 },
    );
  }
  const homeLeague = req.nextUrl.searchParams.get("home_league")?.trim() || null;
  const awayLeague = req.nextUrl.searchParams.get("away_league")?.trim() || null;
  const tournament = req.nextUrl.searchParams.get("tournament")?.trim() || "UCL";
  const gameId = req.nextUrl.searchParams.get("game_id")?.trim() || null;
  const commenceTime = req.nextUrl.searchParams.get("commence_time")?.trim() || null;
  const neutralVenue = (req.nextUrl.searchParams.get("neutral_venue") ?? "1") !== "0";

  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();

  // Python pulls intelligence from match_intelligence.py + (when game_id is
  // provided) cached odds via fetch_league_odds. For the UCL final we
  // currently surface raw model probabilities; the edge computation lights
  // up the moment odds are reachable.
  const script = `
import json, sys
from ml.soccer.match_intelligence import intelligence_for_match, edge_against_book
from ml.soccer.approved_picks import lineup_freshness

try:
    out = intelligence_for_match(
        home_team=${JSON.stringify(home)},
        away_team=${JSON.stringify(away)},
        tournament=${JSON.stringify(tournament)},
        home_league=${homeLeague ? JSON.stringify(homeLeague) : "None"},
        away_league=${awayLeague ? JSON.stringify(awayLeague) : "None"},
        commence_time=${commenceTime ? JSON.stringify(commenceTime) : "None"},
        game_id=${gameId ? JSON.stringify(gameId) : "None"},
        neutral_venue=${neutralVenue ? "True" : "False"},
    )
    if out is None:
        print(json.dumps({"error": "intelligence_for_match returned None"})); sys.exit(0)

    # Lineup freshness traffic light — tells the trader how much to trust
    # the M7/M8 lineup adjustments in the model output.
    try:
        out["lineup_freshness"] = lineup_freshness(
            ${gameId ? JSON.stringify(gameId) : "''"},
            home_team=${JSON.stringify(home)},
            away_team=${JSON.stringify(away)},
            commence_time=${commenceTime ? JSON.stringify(commenceTime) : "None"},
        )
    except Exception as _lf_e:
        out["lineup_freshness"] = {"tier": "red", "reason": f"lookup error: {str(_lf_e)[:120]}"}

    # Try to pull cached odds + compute edges. Best-effort; failures don't
    # break the model output (the UI shows fair probs even if odds aren't
    # available yet).
    edges = None
    try:
        from ml.soccer.leagues import fetch_league_odds
        sport_key_by_tournament = {
            "UCL": "soccer_uefa_champs_league",
            "Premier League": "soccer_epl",
            "La Liga": "soccer_spain_la_liga",
            "Bundesliga": "soccer_germany_bundesliga",
            "Serie A": "soccer_italy_serie_a",
            "Ligue 1": "soccer_france_ligue_one",
        }
        sport_key = sport_key_by_tournament.get(${JSON.stringify(tournament)})
        if sport_key and ${gameId ? JSON.stringify(gameId) : "None"}:
            games = fetch_league_odds(sport_key) or []
            game = next((g for g in games if g.get("id") == ${gameId ? JSON.stringify(gameId) : "None"}), None)
            if game:
                # Extract best price per market+side across all books.
                best = {"h2h": {}, "totals_25": {}, "btts": {}}
                for bm in game.get("bookmakers") or []:
                    book = bm.get("key")
                    for mkt in bm.get("markets") or []:
                        mk = mkt.get("key")
                        outs = mkt.get("outcomes") or []
                        if mk == "h2h":
                            for o in outs:
                                name = (o.get("name") or "").lower()
                                price = o.get("price")
                                if price is None: continue
                                side = ("home" if name == ${JSON.stringify(home.toLowerCase())}
                                       else "away" if name == ${JSON.stringify(away.toLowerCase())}
                                       else "draw" if name == "draw" else None)
                                if side is None: continue
                                cur = best["h2h"].get(side)
                                if cur is None or float(price) > float(cur["price"]):
                                    best["h2h"][side] = {"price": price, "book": book}
                        elif mk == "totals":
                            for o in outs:
                                if o.get("point") not in (2.5, 2): continue
                                name = (o.get("name") or "").lower()
                                price = o.get("price")
                                if price is None or name not in ("over","under"): continue
                                cur = best["totals_25"].get(name)
                                if cur is None or float(price) > float(cur["price"]):
                                    best["totals_25"][name] = {"price": price, "book": book, "point": o.get("point")}
                        elif mk == "btts":
                            for o in outs:
                                name = (o.get("name") or "").lower()
                                price = o.get("price")
                                if price is None or name not in ("yes","no"): continue
                                cur = best["btts"].get(name)
                                if cur is None or float(price) > float(cur["price"]):
                                    best["btts"][name] = {"price": price, "book": book}
                edges = edge_against_book(out, best)
    except Exception as e:
        edges = {"error": str(e)[:200]}

    if edges is not None:
        out["edges"] = edges
    print(json.dumps(out, ensure_ascii=False))
except Exception as e:
    print(json.dumps({"error": str(e)[:300]})); sys.exit(1)
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
        error: "intelligence subprocess failed",
        stderr: r.stderr?.slice(-500) ?? "",
        stdout_tail: r.stdout?.slice(-300) ?? "",
      },
      { status: 500 },
    );
  }
}
