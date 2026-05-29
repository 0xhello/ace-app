/**
 * /api/picks/featured — public subscriber-facing featured pick endpoint.
 *
 * Returns ONE backtest-validated pick for the next big fixture, plus the
 * data the subscriber needs to evaluate it: model probability, market
 * implied probability, edge, best book + price, Kelly stake recommendation,
 * and the backtest receipt that says why we trust this market.
 *
 * Honest about empty state: when no validated edge exists right now,
 * returns { featured: null, message: "no validated picks at the moment" }
 * — never fabricates a "lean" from an unproven market.
 *
 * Public read (no auth), cached 60s edge / 5m stale-while-revalidate. Picks
 * change slowly (book lines move, but our model is the same call) so the
 * cache is fine for subscriber consumption.
 *
 * Underlying implementation: same intelligence_for_match + edge_against_book
 * the ops tab uses, with verdict-filtering applied here so subscribers only
 * see what we've backtested as bettable.
 */
import { NextResponse } from "next/server";
import { spawnSync } from "child_process";
import path from "path";

export const dynamic = "force-dynamic";

// MARKET_VERDICTS hardcoded server-side. Mirrors the SoccerOpsTab map so
// the subscriber view shows the same gating logic as ops. Update both
// places when the calibration backtest verdict for a bucket changes.
const VERDICTS: Record<string, { status: "bet" | "loses" | "untested"; roi?: number; n?: number; note?: string }> = {
  "1X2|home":         { status: "loses", roi: -0.092, n: 138 },
  "1X2|draw":         { status: "loses", roi: -0.357, n:  71 },
  "1X2|away":         { status: "bet",   roi:  0.129, n: 152, note: "non-neutral only" },
  "Totals 2.5|over":  { status: "bet",   roi:  0.091, n: 198 },
  "Totals 2.5|under": { status: "loses", roi: -0.363, n:  38 },
  "BTTS|yes":         { status: "untested" },
  "BTTS|no":          { status: "untested" },
};

function isValidatedAtFixture(market: string, side: string, neutralVenue: boolean): {
  ok: boolean;
  verdict: typeof VERDICTS[string] | null;
} {
  const key = `${market}|${side}`;
  const v = VERDICTS[key];
  if (!v) return { ok: false, verdict: null };
  if (v.status !== "bet") return { ok: false, verdict: v };
  // Downgrade non-neutral-only verdicts when fixture is neutral
  if (neutralVenue && (v.note ?? "").toLowerCase().includes("non-neutral")) {
    return { ok: false, verdict: v };
  }
  return { ok: true, verdict: v };
}

function kellyStake(modelProb: number, american: number): number {
  const dec = american >= 0 ? american / 100 + 1 : 100 / -american + 1;
  const edge = modelProb * dec - 1;
  if (edge <= 0) return 0;
  const kellyFull = edge / (dec - 1);
  return Math.min(5.0, kellyFull * 0.25 * 100);
}

interface FeaturedPickResponse {
  featured: null | {
    fixture: {
      home: string;
      away: string;
      tournament: string;
      kickoff: string | null;
      neutral_venue: boolean;
    };
    bet: {
      label: string;
      market: string;
      side: string;
      best_book: string;
      best_price: number;
      stake_units: number;
    };
    math: {
      model_prob: number;
      implied_prob: number;
      edge_pp: number;
    };
    backtest: {
      roi: number;
      n: number;
      note: string;
    };
  };
  message?: string;
  refreshed_at: string;
}

function fetchFeaturedPick(): FeaturedPickResponse {
  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();

  const script = `
import json, sys
from ml.soccer.match_intelligence import intelligence_for_match, edge_against_book
from ml.soccer.leagues import LEAGUES, fetch_league_odds
from datetime import datetime, timezone, timedelta

# Lightweight featured-fixture pick (mirror of /api/ops/featured-fixture)
PRIORITY = {"UCL": 5, "Premier League": 3, "La Liga": 3, "Bundesliga": 3, "Serie A": 3, "Ligue 1": 3}
LEAGUE_NAME = {sport_key: lg for (sport_key, lg, _) in LEAGUES}

_TEAM_LEAGUE = {
    "arsenal":"Premier League","liverpool":"Premier League","manchester city":"Premier League",
    "man city":"Premier League","manchester united":"Premier League","man united":"Premier League",
    "chelsea":"Premier League","tottenham":"Premier League","newcastle":"Premier League",
    "aston villa":"Premier League","brighton":"Premier League","west ham":"Premier League",
    "real madrid":"La Liga","barcelona":"La Liga","atletico madrid":"La Liga","ath madrid":"La Liga",
    "real sociedad":"La Liga","villarreal":"La Liga","real betis":"La Liga","sevilla":"La Liga",
    "athletic bilbao":"La Liga","ath bilbao":"La Liga","valencia":"La Liga",
    "bayern munich":"Bundesliga","bayer leverkusen":"Bundesliga","leverkusen":"Bundesliga",
    "borussia dortmund":"Bundesliga","dortmund":"Bundesliga","rb leipzig":"Bundesliga",
    "eintracht frankfurt":"Bundesliga","frankfurt":"Bundesliga","stuttgart":"Bundesliga",
    "inter":"Serie A","ac milan":"Serie A","juventus":"Serie A","napoli":"Serie A",
    "as roma":"Serie A","roma":"Serie A","lazio":"Serie A","atalanta":"Serie A","fiorentina":"Serie A",
    "bologna":"Serie A",
    "paris saint germain":"Ligue 1","psg":"Ligue 1","paris sg":"Ligue 1","marseille":"Ligue 1",
    "monaco":"Ligue 1","lille":"Ligue 1","nice":"Ligue 1","lyon":"Ligue 1","rennes":"Ligue 1",
}
def guess_league(name):
    return _TEAM_LEAGUE.get((name or "").lower(), "Premier League")

now = datetime.now(timezone.utc)
horizon = now + timedelta(days=14)
candidates = []
for sport_key, league, _au in LEAGUES:
    try:
        games = fetch_league_odds(sport_key) or []
    except Exception:
        continue
    for g in games:
        ct = g.get("commence_time")
        if not ct: continue
        try:
            kickoff = datetime.fromisoformat(ct.replace("Z", "+00:00"))
        except Exception:
            continue
        if kickoff < now or kickoff > horizon: continue
        candidates.append({"game_id": g.get("id"), "home": g.get("home_team"),
                           "away": g.get("away_team"), "kickoff_unix": kickoff.timestamp(),
                           "commence_time": ct, "sport_key": sport_key, "league": league,
                           "priority": PRIORITY.get(league, 1), "game": g})

candidates.sort(key=lambda c: (-c["priority"], c["kickoff_unix"]))
if not candidates:
    print(json.dumps({"featured": None, "message": "no upcoming fixtures"})); sys.exit(0)

top = candidates[0]
is_ucl = top["sport_key"] == "soccer_uefa_champs_league"
ucl_count = sum(1 for c in candidates if c["sport_key"] == "soccer_uefa_champs_league")
top_kickoff = datetime.fromtimestamp(top["kickoff_unix"], tz=timezone.utc)
is_final_window = (
    (top_kickoff.month == 5 and top_kickoff.day >= 25) or top_kickoff.month == 6
)
stage = ("ucl_final" if (is_ucl and is_final_window and ucl_count == 1)
         else "ucl_knockout" if is_ucl else "league")

home_league = guess_league(top["home"]) if is_ucl else top["league"]
away_league = guess_league(top["away"]) if is_ucl else top["league"]
neutral = is_ucl
tournament = "UCL" if is_ucl else top["league"]

intel = intelligence_for_match(
    home_team=top["home"], away_team=top["away"], tournament=tournament,
    home_league=home_league, away_league=away_league,
    commence_time=top["commence_time"], game_id=top["game_id"],
    neutral_venue=neutral, competition_stage=stage,
)
if not intel or intel.get("error") or not intel.get("model"):
    print(json.dumps({"featured": None, "message": "model couldn't read fixture"})); sys.exit(0)

# Walk bookmakers → build best-price-per-market dict
best = {"h2h": {}, "totals_25": {}, "btts": {}}
for bm in (top["game"].get("bookmakers") or []):
    book = bm.get("key")
    for mkt in (bm.get("markets") or []):
        mk = mkt.get("key")
        for o in (mkt.get("outcomes") or []):
            name = (o.get("name") or "").lower()
            price = o.get("price")
            if price is None: continue
            if mk == "h2h":
                side = ("home" if name == (top["home"] or "").lower()
                       else "away" if name == (top["away"] or "").lower()
                       else "draw" if name == "draw" else None)
                if side is None: continue
                cur = best["h2h"].get(side)
                if cur is None or float(price) > float(cur["price"]):
                    best["h2h"][side] = {"price": price, "book": book}
            elif mk == "totals" and o.get("point") in (2.5, 2):
                if name not in ("over","under"): continue
                cur = best["totals_25"].get(name)
                if cur is None or float(price) > float(cur["price"]):
                    best["totals_25"][name] = {"price": price, "book": book, "point": o.get("point")}
            elif mk == "btts" and name in ("yes","no"):
                cur = best["btts"].get(name)
                if cur is None or float(price) > float(cur["price"]):
                    best["btts"][name] = {"price": price, "book": book}

edges = edge_against_book(intel, best)
all_edges = edges.get("edges", [])

print(json.dumps({
    "fixture": {
        "home": top["home"], "away": top["away"],
        "tournament": tournament,
        "kickoff": top["commence_time"],
        "neutral_venue": neutral,
        "stage": stage,
    },
    "edges": all_edges,
}, default=str))
`;

  const r = spawnSync("python3", ["-c", script], {
    encoding: "utf-8",
    timeout: 15_000,
    cwd: appRoot,
  });

  const now = new Date().toISOString();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return { featured: null, message: "intelligence call failed", refreshed_at: now };
  }
  if ((parsed as { featured?: unknown }).featured === null) {
    return {
      featured: null,
      message: String((parsed as { message?: string }).message ?? "no validated edge"),
      refreshed_at: now,
    };
  }

  type Fixture = { home: string; away: string; tournament: string; kickoff: string | null; neutral_venue: boolean };
  type Edge = { market: string; side: string; model_prob: number; implied_prob: number; edge_pp: number; best_book: string | null; best_price: number | null; tier: string };
  const fixture = parsed.fixture as Fixture | undefined;
  const allEdges = ((parsed.edges as Edge[] | undefined) ?? []);
  if (!fixture) {
    return { featured: null, message: "no fixture", refreshed_at: now };
  }

  // Filter to validated bet-grade edges only
  const validated = allEdges
    .filter((e) => e.edge_pp > 0 && e.best_price !== null && e.best_book !== null)
    .map((e) => ({ edge: e, gate: isValidatedAtFixture(e.market, e.side, fixture.neutral_venue) }))
    .filter((x) => x.gate.ok);

  if (validated.length === 0) {
    return {
      featured: null,
      message: "no backtest-validated picks for the next fixture right now",
      refreshed_at: now,
    };
  }

  // Highest-edge wins
  validated.sort((a, b) => b.edge.edge_pp - a.edge.edge_pp);
  const top = validated[0];
  const e = top.edge;
  const v = top.gate.verdict!;

  // Build the bet label
  const home = fixture.home;
  const away = fixture.away;
  let label = `${e.side} ${e.market}`;
  if (e.market === "1X2" && e.side === "home") label = `${home} to win`;
  else if (e.market === "1X2" && e.side === "draw") label = "Draw";
  else if (e.market === "1X2" && e.side === "away") label = `${away} to win`;
  else if (e.market === "Totals 2.5") label = `${e.side === "over" ? "Over" : "Under"} 2.5 goals`;
  else if (e.market === "BTTS") label = `BTTS ${e.side}`;

  return {
    featured: {
      fixture: {
        home, away,
        tournament: fixture.tournament,
        kickoff: fixture.kickoff,
        neutral_venue: fixture.neutral_venue,
      },
      bet: {
        label,
        market: e.market,
        side: e.side,
        best_book: e.best_book!,
        best_price: e.best_price!,
        stake_units: Number(kellyStake(e.model_prob, e.best_price!).toFixed(2)),
      },
      math: {
        model_prob: Number((e.model_prob).toFixed(4)),
        implied_prob: Number((e.implied_prob).toFixed(4)),
        edge_pp: Number((e.edge_pp).toFixed(4)),
      },
      backtest: {
        roi: v.roi ?? 0,
        n: v.n ?? 0,
        note: v.note ?? "",
      },
    },
    refreshed_at: now,
  };
}

export async function GET() {
  const payload = fetchFeaturedPick();
  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "public, max-age=60, s-maxage=120, stale-while-revalidate=300",
    },
  });
}
