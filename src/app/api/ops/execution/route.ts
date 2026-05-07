import { NextRequest, NextResponse } from "next/server";
import { spawnSync } from "child_process";
import { get as cacheGet, set as cacheSet } from "@/lib/server-cache";

export const dynamic = "force-dynamic";

const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
const dbPath = `${appRoot}/ml/nba_spread/data/signal_log.db`;

// Paper trading config — flat stakes, $100/unit, $10k starting bankroll
const PAPER_UNIT_VALUE  = 100;   // $ per unit
const PAPER_START_UNITS = 100;   // starting bankroll in units

const GET_QUERY = (db: string) => `
import sqlite3, json

PAPER_START = ${PAPER_START_UNITS}
UNIT_VALUE  = ${PAPER_UNIT_VALUE}

_EMPTY_BASE = {'total': 0, 'graded': 0, 'pending': 0, 'wins': 0, 'losses': 0, 'pushes': 0,
               'pnl_units': None, 'total_staked_units': 0.0,
               'start_units': PAPER_START, 'current_units': None,
               'roi_pct': None, 'unit_value': UNIT_VALUE}

try:
    conn = sqlite3.connect(${JSON.stringify(db)})
    conn.row_factory = sqlite3.Row

    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    if 'execution_log' not in tables:
        conn.close()
        print(json.dumps({'executions': [], 'summary': {'paper': _EMPTY_BASE, 'real': _EMPTY_BASE}}))
    else:
        rows = conn.execute(
            """SELECT e.*, s.home_team, s.away_team, s.game_date, s.signal_type, s.game_id,
                      p.home_cover_prob, p.edge_vs_pinnacle
               FROM execution_log e
               JOIN signal_log s ON s.id = e.signal_id
               LEFT JOIN predictions p ON p.game_id = s.game_id
               ORDER BY s.game_date DESC, e.id DESC LIMIT 100"""
        ).fetchall()
        executions = [dict(r) for r in rows]

        def _summary(mode):
            rs = conn.execute(
                "SELECT COUNT(*) n, "
                "SUM(CASE WHEN graded_at IS NOT NULL THEN 1 ELSE 0 END) graded, "
                "SUM(CASE WHEN graded_at IS NULL THEN 1 ELSE 0 END) pending, "
                "SUM(CASE WHEN outcome=1 THEN 1 ELSE 0 END) wins, "
                "SUM(CASE WHEN outcome=0 THEN 1 ELSE 0 END) losses, "
                "SUM(CASE WHEN graded_at IS NOT NULL AND outcome IS NULL THEN 1 ELSE 0 END) pushes, "
                "SUM(pnl_units) pnl, SUM(stake) total_staked "
                "FROM execution_log WHERE mode=?", (mode,)
            ).fetchone()
            pnl          = round(rs['pnl'], 4) if rs['pnl'] is not None else None
            total_staked = round(rs['total_staked'] or 0.0, 4)
            if mode == 'paper':
                current = round(PAPER_START + (pnl or 0.0), 4)
                roi     = round((pnl or 0.0) / total_staked * 100, 2) if total_staked > 0 else None
                return {
                    'total': rs['n'], 'graded': rs['graded'] or 0,
                    'pending': rs['pending'] or 0,
                    'wins': rs['wins'] or 0, 'losses': rs['losses'] or 0,
                    'pushes': rs['pushes'] or 0,
                    'pnl_units': pnl, 'total_staked_units': total_staked,
                    'start_units': PAPER_START, 'current_units': current,
                    'roi_pct': roi, 'unit_value': UNIT_VALUE,
                }
            real_roi = round((pnl or 0.0) / total_staked * 100, 2) if total_staked > 0 else None
            return {
                'total': rs['n'], 'graded': rs['graded'] or 0,
                'pending': rs['pending'] or 0,
                'wins': rs['wins'] or 0, 'losses': rs['losses'] or 0,
                'pushes': rs['pushes'] or 0,
                'pnl_units': pnl, 'total_staked_units': total_staked,
                'start_units': None, 'current_units': None,
                'roi_pct': real_roi, 'unit_value': UNIT_VALUE,
            }

        summary = {'paper': _summary('paper'), 'real': _summary('real')}
        conn.close()
        print(json.dumps({'executions': executions, 'summary': summary}))
except Exception as e:
    print(json.dumps({'error': str(e)}))
`;

// ── Live score enrichment ──────────────────────────────────────────────────────

const SCORES_CACHE_KEY = "__nba_scores_exec__";
const SCORES_TTL_MS = 5 * 60_000;

async function getLiveScores(): Promise<Map<string, any>> {
  try {
    const cached = await cacheGet(SCORES_CACHE_KEY);
    if (cached && Date.now() - cached.fetchedAt < SCORES_TTL_MS) {
      return buildScoreMap(cached.data);
    }

    const apiKey = process.env.ODDS_API_KEY;
    if (!apiKey) return new Map();

    const url = new URL("https://api.the-odds-api.com/v4/sports/basketball_nba/scores");
    url.searchParams.set("apiKey", apiKey);
    url.searchParams.set("daysFrom", "1");

    const res = await fetch(url.toString(), {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return new Map();

    const scores = await res.json();
    await cacheSet(SCORES_CACHE_KEY, scores);
    return buildScoreMap(scores);
  } catch {
    return new Map();
  }
}

function buildScoreMap(scores: any[]): Map<string, any> {
  const map = new Map<string, any>();
  for (const s of scores ?? []) {
    map.set(`${s.home_team}|${s.away_team}`, s);
  }
  return map;
}

function getTeamScore(entry: any, teamName: string): number | null {
  for (const s of entry.scores ?? []) {
    if (s.name === teamName) {
      const n = parseInt(s.score, 10);
      return isNaN(n) ? null : n;
    }
  }
  return null;
}

function computeLiveCovering(
  homeScore: number,
  awayScore: number,
  signalLine: number,
  betSide: string
): boolean | null {
  const margin = (homeScore - awayScore) + signalLine;
  if (margin === 0) return null; // push
  const homeCovered = margin > 0;
  return betSide === "home" ? homeCovered : !homeCovered;
}

// ── Route handlers ─────────────────────────────────────────────────────────────

export async function GET() {
  const result = spawnSync("python3", ["-c", GET_QUERY(dbPath)], {
    encoding: "utf-8",
    timeout: 8_000,
  });

  if (result.error) return NextResponse.json({ error: result.error.message });

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    return NextResponse.json({ error: "parse error", raw: result.stdout.slice(0, 300) });
  }

  if (data.error) return NextResponse.json(data);

  // Enrich open bets with live scores — only if there are ungraded bets
  const executions = (data.executions as any[]) ?? [];
  const hasOpen = executions.some((e) => e.outcome === null && !e.graded_at);

  if (hasOpen) {
    const scoreMap = await getLiveScores();
    for (const e of executions) {
      if (e.outcome !== null || e.graded_at) continue;
      const entry = scoreMap.get(`${e.home_team}|${e.away_team}`);
      if (!entry?.scores?.length) continue;

      const hs = getTeamScore(entry, e.home_team);
      const as_ = getTeamScore(entry, e.away_team);
      if (hs === null || as_ === null) continue;

      e.live_home_score = hs;
      e.live_away_score = as_;
      e.live_completed = entry.completed ?? false;
      e.live_covering = computeLiveCovering(hs, as_, e.signal_line, e.bet_side);
    }
  }

  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body.signal_id !== "number") {
    return NextResponse.json({ error: "signal_id required" }, { status: 400 });
  }

  const signalId = body.signal_id;
  const fillLine = typeof body.fill_line === "number" ? body.fill_line : null;
  const stake = typeof body.stake === "number" ? body.stake : 1.0;
  const notes = typeof body.notes === "string" ? body.notes : "manual";

  const script = `
import sqlite3, json, sys
db = ${JSON.stringify(dbPath)}
signal_id = ${signalId}
fill_line = ${fillLine === null ? "None" : fillLine}
stake = ${stake}
notes = ${JSON.stringify(notes)}
try:
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    sig = conn.execute(
        "SELECT line_at_signal, bet_side, execution_source FROM signal_log WHERE id=?", (signal_id,)
    ).fetchone()
    if not sig:
        print(json.dumps({'error': 'signal not found'}))
        sys.exit(0)
    conn.execute(
        "INSERT INTO execution_log (signal_id, mode, book, signal_line, fill_line, bet_side, stake, notes) "
        "VALUES (?, 'real', ?, ?, ?, ?, ?, ?)",
        (signal_id, sig['execution_source'] or '', sig['line_at_signal'],
         fill_line, sig['bet_side'], stake, notes)
    )
    conn.commit()
    exec_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.close()
    print(json.dumps({'ok': True, 'exec_id': exec_id}))
except Exception as e:
    print(json.dumps({'error': str(e)}))
`;

  const result = spawnSync("python3", ["-c", script], {
    encoding: "utf-8",
    timeout: 8_000,
  });

  if (result.error) return NextResponse.json({ error: result.error.message }, { status: 500 });

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    return NextResponse.json({ error: "parse error" }, { status: 500 });
  }

  if (data.error) return NextResponse.json(data, { status: 400 });
  return NextResponse.json(data);
}
