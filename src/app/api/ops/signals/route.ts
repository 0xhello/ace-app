import { NextResponse } from "next/server";
import { spawnSync } from "child_process";

export const dynamic = "force-dynamic";

// Runs as Python in the ace-app root — no PYTHONPATH needed, uses raw sqlite3 only.
const PYTHON_QUERY = `
import sqlite3, json, statistics
from datetime import datetime, timezone, timedelta

DB = 'ml/nba_spread/data/signal_log.db'
et_today = (datetime.now(timezone.utc) - timedelta(hours=5)).strftime('%Y-%m-%d')
stale_threshold = (datetime.now(timezone.utc) - timedelta(hours=5) - timedelta(days=3)).strftime('%Y-%m-%d')

try:
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row

    status_rows = conn.execute('SELECT status, COUNT(*) n FROM signal_log GROUP BY status').fetchall()
    by_status = {r['status']: r['n'] for r in status_rows}

    graded_rows = conn.execute(
        'SELECT clv_points, covered, closing_source FROM signal_log WHERE status="graded"'
    ).fetchall()
    clv_vals = [r['clv_points'] for r in graded_rows if r['clv_points'] is not None]
    wins = sum(1 for r in graded_rows if r['covered'] == 1)

    avg_clv = round(sum(clv_vals) / len(clv_vals), 2) if clv_vals else None
    med_clv = round(statistics.median(clv_vals), 2) if len(clv_vals) >= 1 else None
    pct_pos = round(sum(1 for v in clv_vals if v > 0) / len(clv_vals) * 100, 1) if clv_vals else None

    same = [r['clv_points'] for r in graded_rows
            if r['clv_points'] is not None and r['closing_source'] and 'fallback' not in r['closing_source']]
    fall = [r['clv_points'] for r in graded_rows
            if r['clv_points'] is not None and r['closing_source'] and 'fallback' in r['closing_source']]

    today_sigs = conn.execute(
        'SELECT COUNT(*) n FROM signal_log WHERE game_date=?', (et_today,)
    ).fetchone()['n']
    today_snaps = conn.execute(
        'SELECT COUNT(DISTINCT game_id) n FROM line_snapshots WHERE game_date=?', (et_today,)
    ).fetchone()['n']
    game_rows = conn.execute(
        'SELECT DISTINCT home_team, away_team FROM line_snapshots WHERE game_date=?', (et_today,)
    ).fetchall()
    today_games = [{'home': r['home_team'], 'away': r['away_team']} for r in game_rows]

    stale_rows = conn.execute(
        'SELECT id, game_date, home_team, away_team FROM signal_log WHERE status="open" AND game_date <= ?',
        (stale_threshold,)
    ).fetchall()
    stale = [{'id': r['id'], 'game_date': r['game_date'],
              'home_team': r['home_team'], 'away_team': r['away_team']} for r in stale_rows]

    # Open signals broken down by stage
    open_signals = conn.execute(
        'SELECT id, game_date, home_team, away_team, bet_side, line_at_signal, status FROM signal_log WHERE status IN ("open","proxy_captured")'
    ).fetchall()
    open_list = [{'id': r['id'], 'game_date': r['game_date'], 'home_team': r['home_team'],
                  'away_team': r['away_team'], 'bet_side': r['bet_side'],
                  'line_at_signal': r['line_at_signal'], 'status': r['status']} for r in open_signals]

    # Recent graded signals for history table
    recent_rows = conn.execute(
        '''SELECT id, game_date, home_team, away_team, bet_side,
                  line_at_signal, clv_points, covered, closing_source
           FROM signal_log WHERE status="graded"
           ORDER BY id DESC LIMIT 10'''
    ).fetchall()
    recent_graded = [{'id': r['id'], 'game_date': r['game_date'],
                      'home': r['home_team'], 'away': r['away_team'],
                      'side': r['bet_side'], 'line': r['line_at_signal'],
                      'clv': r['clv_points'], 'win': r['covered'],
                      'src': r['closing_source']} for r in recent_rows]

    conn.close()
    print(json.dumps({
        'by_status': by_status,
        'total': sum(by_status.values()),
        'clv': {
            'avg': avg_clv, 'median': med_clv, 'pct_positive': pct_pos,
            'n': len(clv_vals), 'wins': wins, 'total_graded': len(graded_rows)
        },
        'same_book': {'clv': round(sum(same) / len(same), 2) if same else None, 'n': len(same)},
        'fallback':  {'clv': round(sum(fall) / len(fall), 2) if fall else None, 'n': len(fall)},
        'today': {'signals': today_sigs, 'snapshots': today_snaps, 'games': today_games},
        'stale': stale,
        'open_signals': open_list,
        'recent_graded': recent_graded,
        'et_today': et_today,
    }))
except Exception as e:
    print(json.dumps({'error': str(e)}))
`;

export async function GET() {
  const result = spawnSync("python3", ["-c", PYTHON_QUERY], {
    cwd: process.cwd(),
    encoding: "utf-8",
    timeout: 10_000,
  });

  if (result.error) {
    return NextResponse.json({ error: result.error.message });
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    return NextResponse.json({ error: "Failed to parse signal query output", raw: result.stdout.slice(0, 500) });
  }

  if (data.error) {
    return NextResponse.json({ error: data.error });
  }

  // Compute edge status (mirrors Python compute_edge_status logic)
  const clv = data.clv as { n: number; avg: number | null; pct_positive: number | null };
  let edgeStatus = "accumulating";
  if (clv.n >= 30 && clv.avg !== null) {
    if (clv.avg < 0) {
      edgeStatus = "bad";
    } else {
      const suffix = clv.pct_positive !== null && clv.pct_positive <= 50 ? "?" : "";
      if (clv.avg < 0.5)      edgeStatus = `inconclusive${suffix}`;
      else if (clv.avg < 1.0) edgeStatus = `promising${suffix}`;
      else                     edgeStatus = `strong${suffix}`;
    }
  }

  return NextResponse.json({ ...data, edgeStatus, needFor30: Math.max(0, 30 - clv.n) });
}
