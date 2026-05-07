import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getUserWatchlist } from "@/lib/auth-db";
import { spawnSync } from "child_process";
import { get as cacheGet, set as cacheSet } from "@/lib/server-cache";

export const dynamic = "force-dynamic";

const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
const dbPath = `${appRoot}/ml/nba_spread/data/signal_log.db`;

function buildScoreMap(scores: any[]): Map<string, any> {
  const map = new Map<string, any>();
  for (const s of scores ?? []) map.set(s.id, s);
  return map;
}

function getTeamScore(entry: any, teamName: string): number | null {
  for (const s of entry?.scores ?? []) {
    if (s.name === teamName) {
      const n = parseInt(s.score, 10);
      return isNaN(n) ? null : n;
    }
  }
  return null;
}

async function fetchScores(): Promise<Map<string, any>> {
  const CACHE_KEY = "__nba_scores_live_watch__";
  const TTL = 60_000;

  try {
    const cached = await cacheGet(CACHE_KEY);
    if (cached && Date.now() - cached.fetchedAt < TTL) return buildScoreMap(cached.data);
  } catch {}

  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return new Map();

  try {
    const url = new URL("https://api.the-odds-api.com/v4/sports/basketball_nba/scores");
    url.searchParams.set("apiKey", apiKey);
    url.searchParams.set("daysFrom", "2");

    const res = await fetch(url.toString(), { cache: "no-store", signal: AbortSignal.timeout(6_000) });
    if (!res.ok) return new Map();

    const scores = await res.json();
    await cacheSet(CACHE_KEY, scores);
    return buildScoreMap(scores);
  } catch {
    return new Map();
  }
}

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const userId = parseInt((session.user as any).id, 10);
  let watchedIds: string[] = [];
  try { watchedIds = getUserWatchlist(userId); } catch {}

  // Pending real-money bets
  const result = spawnSync("python3", ["-c", `
import sqlite3, json
conn = sqlite3.connect(${JSON.stringify(dbPath)})
conn.row_factory = sqlite3.Row
try:
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    if "execution_log" not in tables:
        print(json.dumps([]))
    else:
        rows = conn.execute("""
            SELECT s.game_id, s.home_team, s.away_team, s.game_date,
                   e.bet_side, e.signal_line, e.fill_line, e.stake, e.id AS exec_id,
                   p.home_cover_prob, p.edge_vs_pinnacle
            FROM execution_log e
            JOIN signal_log s ON s.id = e.signal_id
            LEFT JOIN predictions p ON p.game_id = s.game_id
            WHERE e.mode = 'real' AND e.graded_at IS NULL
            ORDER BY s.game_date DESC, e.id DESC
        """).fetchall()
        print(json.dumps([dict(r) for r in rows]))
except Exception as ex:
    print(json.dumps([]))
finally:
    conn.close()
`], { encoding: "utf-8", timeout: 8_000 });

  let pendingBets: any[] = [];
  try { pendingBets = JSON.parse(result.stdout) ?? []; } catch {}

  const scoreMap = await fetchScores();
  const watchMap = new Map<string, any>();

  // Pending real bets (highest priority)
  for (const bet of pendingBets) {
    const line = bet.fill_line ?? bet.signal_line;
    const entry = scoreMap.get(bet.game_id);
    const hs = entry ? getTeamScore(entry, bet.home_team) : null;
    const as_ = entry ? getTeamScore(entry, bet.away_team) : null;

    let covering: boolean | null = null;
    if (hs !== null && as_ !== null && line !== null) {
      const margin = (hs - as_) + line;
      if (margin !== 0) covering = bet.bet_side === "home" ? margin > 0 : margin < 0;
    }

    const raw_edge = bet.edge_vs_pinnacle;
    const bet_edge = raw_edge !== null
      ? (bet.bet_side === "home" ? raw_edge : -raw_edge)
      : null;
    const prob_for_side = bet.home_cover_prob !== null
      ? (bet.bet_side === "home" ? bet.home_cover_prob : 1 - bet.home_cover_prob)
      : null;

    watchMap.set(bet.game_id, {
      game_id: bet.game_id,
      home_team: bet.home_team,
      away_team: bet.away_team,
      game_date: bet.game_date,
      bet_side: bet.bet_side,
      line,
      stake: bet.stake,
      exec_id: bet.exec_id,
      prob_for_side,
      edge_vs_pinnacle: bet_edge,
      source: "real_bet",
      live_home_score: hs,
      live_away_score: as_,
      live_completed: entry?.completed ?? false,
      has_scores: hs !== null && as_ !== null,
      live_covering: covering,
    });
  }

  // Watchlist games without a bet
  for (const gameId of watchedIds) {
    if (watchMap.has(gameId)) {
      watchMap.get(gameId)!.source = "bet+watch";
      continue;
    }
    const entry = scoreMap.get(gameId);
    if (!entry) continue; // upcoming game not in scores yet
    const hs = getTeamScore(entry, entry.home_team);
    const as_ = getTeamScore(entry, entry.away_team);
    watchMap.set(gameId, {
      game_id: gameId,
      home_team: entry.home_team,
      away_team: entry.away_team,
      game_date: entry.commence_time?.slice(0, 10) ?? null,
      bet_side: null,
      line: null,
      source: "watchlist",
      live_home_score: hs,
      live_away_score: as_,
      live_completed: entry.completed ?? false,
      has_scores: hs !== null && as_ !== null,
      live_covering: null,
    });
  }

  const games = Array.from(watchMap.values());
  return NextResponse.json({ games, watched_count: watchedIds.length, bet_count: pendingBets.length });
}
