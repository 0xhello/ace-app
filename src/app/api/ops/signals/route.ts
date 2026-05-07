import { NextResponse } from "next/server";
import { spawnSync } from "child_process";

export const dynamic = "force-dynamic";

// Runs as Python in the ace-app root — no PYTHONPATH needed, uses raw sqlite3 only.
const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
const dbPath = `${appRoot}/ml/nba_spread/data/signal_log.db`;

const PYTHON_QUERY = `
import sqlite3, json, statistics
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

_TZ_ET = ZoneInfo('America/New_York')
DB = ${JSON.stringify(dbPath)}
et_today = datetime.now(_TZ_ET).strftime('%Y-%m-%d')
stale_threshold = (datetime.now(_TZ_ET) - timedelta(days=3)).strftime('%Y-%m-%d')

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
            if r['clv_points'] is not None and r['closing_source'] == 'pinnacle']
    fall = [r['clv_points'] for r in graded_rows
            if r['clv_points'] is not None and r['closing_source'] and r['closing_source'] != 'pinnacle']

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

    # Open signals — join predictions for Kelly sizing data
    open_signals = conn.execute(
        """SELECT s.id, s.game_date, s.home_team, s.away_team, s.bet_side,
                  s.line_at_signal, s.status, s.signal_type,
                  p.home_cover_prob, p.edge_vs_pinnacle
           FROM signal_log s
           LEFT JOIN predictions p ON p.game_id = s.game_id
           WHERE s.status IN ("open","proxy_captured")
           ORDER BY s.game_date ASC, s.id DESC"""
    ).fetchall()

    def _kelly(bet_side, home_cover_prob):
        if home_cover_prob is None:
            return None
        p = float(home_cover_prob) if bet_side == 'home' else 1.0 - float(home_cover_prob)
        b = 100.0 / 110.0  # -110 payout
        k = (p * (b + 1.0) - 1.0) / b
        return round(max(k, 0.0), 4)  # never negative

    open_list = []
    for r in open_signals:
        kelly = _kelly(r['bet_side'], r['home_cover_prob'])
        open_list.append({
            'id': r['id'], 'game_date': r['game_date'],
            'home_team': r['home_team'], 'away_team': r['away_team'],
            'bet_side': r['bet_side'], 'line_at_signal': r['line_at_signal'],
            'status': r['status'], 'signal_type': r['signal_type'],
            'home_cover_prob': r['home_cover_prob'],
            'edge_vs_pinnacle': r['edge_vs_pinnacle'],
            'kelly_fraction': kelly,
        })

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

    # Multi-book line tracking (book_lines table)
    et_tomorrow = (datetime.now(_TZ_ET) + timedelta(days=1)).strftime('%Y-%m-%d')
    try:
        bl_total = conn.execute('SELECT COUNT(*) FROM book_lines').fetchone()[0]
        bl_game_days = conn.execute('SELECT COUNT(DISTINCT game_date) FROM book_lines').fetchone()[0]
        div_rows = conn.execute(
            '''WITH latest AS (
                 SELECT game_id, book, home_line, game_date, home_team, away_team, snapshot_label,
                        ROW_NUMBER() OVER (PARTITION BY game_id, book ORDER BY captured_at DESC) AS rn
                 FROM book_lines
               )
               SELECT l.game_date, l.home_team, l.away_team,
                      p.home_line AS pinnacle_line,
                      l.book, l.home_line AS book_line,
                      ROUND(l.home_line - p.home_line, 2) AS divergence,
                      l.snapshot_label
               FROM latest l
               JOIN latest p ON l.game_id = p.game_id AND p.book = "pinnacle" AND p.rn = 1
               WHERE l.game_date IN (?, ?)
                 AND l.book != "pinnacle"
                 AND l.rn = 1
                 AND ABS(l.home_line - p.home_line) >= 0.5
               ORDER BY l.game_date ASC, ABS(l.home_line - p.home_line) DESC''',
            (et_today, et_tomorrow)
        ).fetchall()
        divergences = [{'game_date': r['game_date'], 'home': r['home_team'], 'away': r['away_team'],
                        'pinnacle_line': r['pinnacle_line'], 'book': r['book'],
                        'book_line': r['book_line'], 'divergence': r['divergence'],
                        'snapshot_label': r['snapshot_label']} for r in div_rows]
        book_lines_data = {'total': bl_total, 'game_days': bl_game_days, 'divergences': divergences}
    except Exception:
        book_lines_data = {'total': 0, 'game_days': 0, 'divergences': []}

    # Per-signal-type CLV breakdown.
    # soft_book_divergence is deduplicated by (game_id, bet_side, game_date) so
    # three books moving together count as one market observation, not three.
    type_rows = conn.execute(
        '''WITH deduped_div AS (
               SELECT game_id, bet_side, game_date,
                      AVG(clv_points) AS clv_points
               FROM signal_log
               WHERE status="graded" AND signal_type="soft_book_divergence"
               GROUP BY game_id, bet_side, game_date
           ),
           other AS (
               SELECT signal_type, clv_points
               FROM signal_log
               WHERE status="graded" AND signal_type != "soft_book_divergence"
           )
           SELECT "soft_book_divergence" AS signal_type,
                  COUNT(*) AS n,
                  ROUND(AVG(clv_points), 2) AS avg_clv,
                  ROUND(100.0 * SUM(CASE WHEN clv_points > 0 THEN 1 ELSE 0 END)
                        / NULLIF(COUNT(clv_points), 0), 1) AS pct_pos,
                  COUNT(CASE WHEN clv_points IS NOT NULL THEN 1 END) AS graded
           FROM deduped_div
           UNION ALL
           SELECT signal_type,
                  COUNT(*) AS n,
                  ROUND(AVG(clv_points), 2) AS avg_clv,
                  ROUND(100.0 * SUM(CASE WHEN clv_points > 0 THEN 1 ELSE 0 END)
                        / NULLIF(COUNT(clv_points), 0), 1) AS pct_pos,
                  COUNT(CASE WHEN clv_points IS NOT NULL THEN 1 END) AS graded
           FROM other
           GROUP BY signal_type'''
    ).fetchall()
    by_type = {r['signal_type']: {'n': r['n'], 'avg_clv': r['avg_clv'],
                                   'pct_pos': r['pct_pos'], 'graded': r['graded']}
               for r in type_rows}

    conn.close()
    print(json.dumps({
        'by_status': by_status,
        'total': sum(by_status.values()),
        'clv': {
            'avg': avg_clv, 'median': med_clv, 'pct_positive': pct_pos,
            'n': len(clv_vals), 'wins': wins, 'total_graded': len(graded_rows)
        },
        'pinnacle_close': {'clv': round(sum(same) / len(same), 2) if same else None, 'n': len(same)},
        'non_pinnacle_close': {'clv': round(sum(fall) / len(fall), 2) if fall else None, 'n': len(fall)},
        'today': {'signals': today_sigs, 'snapshots': today_snaps, 'games': today_games},
        'stale': stale,
        'open_signals': open_list,
        'recent_graded': recent_graded,
        'book_lines': book_lines_data,
        'by_type': by_type,
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
