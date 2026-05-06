import { NextRequest, NextResponse } from "next/server";
import { spawnSync } from "child_process";

export const dynamic = "force-dynamic";

const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
const dbPath = `${appRoot}/ml/nba_spread/data/signal_log.db`;

const GET_QUERY = (db: string) => `
import sqlite3, json

_EMPTY = {'total': 0, 'graded': 0, 'wins': 0, 'losses': 0, 'pnl_units': None}

try:
    conn = sqlite3.connect(${JSON.stringify(db)})
    conn.row_factory = sqlite3.Row

    # execution_log may not exist yet on first startup (worker creates it on first poll)
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    if 'execution_log' not in tables:
        conn.close()
        print(json.dumps({'executions': [], 'summary': {'paper': _EMPTY, 'real': _EMPTY}}))
    else:
        rows = conn.execute(
            '''SELECT e.*, s.home_team, s.away_team, s.game_date, s.signal_type
               FROM execution_log e
               JOIN signal_log s ON s.id = e.signal_id
               ORDER BY e.id DESC LIMIT 100'''
        ).fetchall()
        executions = [dict(r) for r in rows]

        def _summary(mode):
            # graded_at IS NOT NULL covers wins, losses, AND pushes (outcome=NULL but graded)
            rs = conn.execute(
                "SELECT COUNT(*) n, SUM(CASE WHEN graded_at IS NOT NULL THEN 1 ELSE 0 END) graded, "
                "SUM(CASE WHEN outcome=1 THEN 1 ELSE 0 END) wins, "
                "SUM(CASE WHEN outcome=0 THEN 1 ELSE 0 END) losses, "
                "SUM(pnl_units) pnl "
                "FROM execution_log WHERE mode=?", (mode,)
            ).fetchone()
            return {'total': rs['n'], 'graded': rs['graded'] or 0,
                    'wins': rs['wins'] or 0, 'losses': rs['losses'] or 0,
                    'pnl_units': round(rs['pnl'], 4) if rs['pnl'] is not None else None}

        summary = {'paper': _summary('paper'), 'real': _summary('real')}
        conn.close()
        print(json.dumps({'executions': executions, 'summary': summary}))
except Exception as e:
    print(json.dumps({'error': str(e)}))
`;

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
