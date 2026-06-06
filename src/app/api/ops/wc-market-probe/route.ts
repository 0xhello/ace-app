/**
 * /api/ops/wc-market-probe — what's actually on the Odds API for the WC?
 *
 * Manually-triggered probe of the FIFA World Cup sport key on Odds API.
 * Each call requests every market we might care about, then reports
 * which ones returned data and how many games carry them.
 *
 * Why manual (not cron):
 *   Each probe spends roughly (markets × 1) credits per region. With ~10
 *   markets, that's 10 credits per probe. Fine occasionally; bad as a
 *   cron tick. The operator clicks "Probe" when they want a status check.
 *
 * Logs each probe to wc_market_probe_log so we can see the timeline of
 * "markets became available on this date" leading into the tournament.
 *
 * Auth: gated by /api/ops/* middleware.
 */
import { NextRequest, NextResponse } from "next/server";
import { spawnSync } from "child_process";
import path from "path";

export const dynamic = "force-dynamic";

const SPORT = "soccer_fifa_world_cup";

// Every market we might want when the tournament opens. Game-level and
// player-prop markets mixed — the Odds API returns whichever it has on
// each market key, so we ask for all and see what sticks.
const PROBE_MARKETS: string[] = [
  // Game-level
  "h2h",                            // 1X2 / moneyline
  "spreads",                        // Asian handicap
  "totals",                         // goal over/under
  "btts",                           // both teams to score
  "alternate_totals_corners",       // corners over/under
  "alternate_totals_cards",         // cards over/under
  // Player props (most likely to open closer to kickoff)
  "player_goal_scorer_anytime",
  "player_goal_scorer_first",
  "player_shots_on_target",
  "player_to_be_carded",
];

interface MarketAvailability {
  market: string;
  games_with_market: number;
  total_outcomes: number;
  bookmakers_offering: string[];
  sample_event: { home: string; away: string } | null;
}

interface ProbeResponse {
  ok: boolean;
  total_games: number;
  credit_cost: number | null;
  credits_remaining: number | null;
  markets: MarketAvailability[];
  probed_at: string;
  error?: string;
}

export async function POST(req: NextRequest) {
  // Optional `?markets=h2h,btts,...` body to probe a subset (cheaper).
  // Default: full probe of all 10 markets above.
  const body = await req.json().catch(() => ({}));
  const markets: string[] = Array.isArray(body?.markets) && body.markets.length > 0
    ? body.markets.filter((m: unknown): m is string => typeof m === "string")
    : PROBE_MARKETS;

  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "ODDS_API_KEY not configured" }, { status: 500 });
  }

  const url = new URL(`https://api.the-odds-api.com/v4/sports/${SPORT}/odds`);
  url.searchParams.set("apiKey", apiKey);
  url.searchParams.set("regions", "us");
  url.searchParams.set("oddsFormat", "american");
  url.searchParams.set("markets", markets.join(","));

  let resp: Response;
  try {
    resp = await fetch(url.toString(), { cache: "no-store", signal: AbortSignal.timeout(15_000) });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: `network: ${msg}` }, { status: 502 });
  }

  if (resp.status === 401) return NextResponse.json({ ok: false, error: "Odds API key invalid" }, { status: 500 });
  if (resp.status === 422) {
    // Off-season sport — common for WC pre-tournament until ~2 weeks out
    return NextResponse.json({
      ok: true,
      total_games: 0,
      credit_cost: 0,
      credits_remaining: parseInt(resp.headers.get("x-requests-remaining") ?? "0", 10) || null,
      markets: markets.map((m) => ({ market: m, games_with_market: 0, total_outcomes: 0, bookmakers_offering: [], sample_event: null })),
      probed_at: new Date().toISOString(),
    } satisfies ProbeResponse);
  }
  if (!resp.ok) {
    return NextResponse.json({ ok: false, error: `HTTP ${resp.status}` }, { status: 502 });
  }

  const games: Array<{ home_team: string; away_team: string; bookmakers: Array<{ key: string; markets: Array<{ key: string; outcomes: unknown[] }> }> }> =
    await resp.json();

  // Build per-market availability map from the response
  const perMarket = new Map<string, MarketAvailability>();
  for (const m of markets) {
    perMarket.set(m, { market: m, games_with_market: 0, total_outcomes: 0, bookmakers_offering: [], sample_event: null });
  }

  for (const g of games) {
    const marketsPresentThisGame = new Set<string>();
    for (const bm of g.bookmakers ?? []) {
      for (const mk of bm.markets ?? []) {
        const entry = perMarket.get(mk.key);
        if (!entry) continue;
        marketsPresentThisGame.add(mk.key);
        entry.total_outcomes += (mk.outcomes ?? []).length;
        if (!entry.bookmakers_offering.includes(bm.key)) entry.bookmakers_offering.push(bm.key);
        if (!entry.sample_event) entry.sample_event = { home: g.home_team, away: g.away_team };
      }
    }
    for (const mk of marketsPresentThisGame) {
      const entry = perMarket.get(mk);
      if (entry) entry.games_with_market += 1;
    }
  }

  const payload: ProbeResponse = {
    ok: true,
    total_games: games.length,
    credit_cost: parseInt(resp.headers.get("x-requests-last") ?? "0", 10) || null,
    credits_remaining: parseInt(resp.headers.get("x-requests-remaining") ?? "0", 10) || null,
    markets: Array.from(perMarket.values()).sort(
      // Live markets first, then alphabetic among empty
      (a, b) => (b.games_with_market - a.games_with_market) || a.market.localeCompare(b.market),
    ),
    probed_at: new Date().toISOString(),
  };

  // Persist to wc_market_probe_log so we can chart "first day market opened"
  // over the lead-up. Fire-and-forget — never break the probe response.
  void persistProbe(payload).catch(() => {});

  return NextResponse.json(payload);
}

// GET reads the latest probe log entries so the panel can render
// without having to re-probe (and re-spend credits) on every refresh.
export async function GET() {
  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
  const dbPath = path.join(appRoot, "ml", "nba_spread", "data", "wc_signal_log.db");

  const script = `
import json, os, sqlite3
db = ${JSON.stringify(dbPath)}
out = {"history": [], "latest": None}
try:
    if os.path.exists(db):
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True); conn.row_factory = sqlite3.Row
        exists = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='wc_market_probe_log'"
        ).fetchone()
        if exists:
            rows = [dict(r) for r in conn.execute(
                "SELECT probed_at, total_games, credit_cost, credits_remaining, markets_json "
                "FROM wc_market_probe_log ORDER BY id DESC LIMIT 20"
            ).fetchall()]
        else:
            rows = []
        conn.close()
        # Decode markets_json into structured form
        for r in rows:
            try:
                r["markets"] = json.loads(r.pop("markets_json"))
            except Exception:
                r["markets"] = []
        out["history"] = rows
        out["latest"] = rows[0] if rows else None
except Exception as e:
    out["error"] = str(e)
print(json.dumps(out))
`;
  const r = spawnSync("python3", ["-c", script], { encoding: "utf-8", timeout: 4_000 });
  try {
    return NextResponse.json(JSON.parse(r.stdout));
  } catch {
    return NextResponse.json({ history: [], latest: null, error: "parse_failed" });
  }
}

async function persistProbe(payload: ProbeResponse): Promise<void> {
  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
  const dbPath = path.join(appRoot, "ml", "nba_spread", "data", "wc_signal_log.db");
  const markets_json = JSON.stringify(payload.markets);

  const script = `
import json, os, sqlite3, sys
db = ${JSON.stringify(dbPath)}
markets_json = ${JSON.stringify(markets_json)}
probed_at = ${JSON.stringify(payload.probed_at)}
total_games = ${payload.total_games}
credit_cost = ${payload.credit_cost ?? "None"}
credits_remaining = ${payload.credits_remaining ?? "None"}
try:
    conn = sqlite3.connect(db)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS wc_market_probe_log (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            probed_at   TEXT NOT NULL,
            total_games INTEGER NOT NULL,
            credit_cost INTEGER,
            credits_remaining INTEGER,
            markets_json TEXT NOT NULL
        )
    """)
    conn.execute(
        "INSERT INTO wc_market_probe_log (probed_at, total_games, credit_cost, credits_remaining, markets_json) VALUES (?, ?, ?, ?, ?)",
        (probed_at, total_games, credit_cost, credits_remaining, markets_json),
    )
    conn.commit()
    conn.close()
    print("ok")
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
`;
  spawnSync("python3", ["-c", script], { encoding: "utf-8", timeout: 4_000 });
}
