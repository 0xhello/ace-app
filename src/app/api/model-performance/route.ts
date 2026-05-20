import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

interface CsvRow {
  logged_at: string;
  game_id: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  home_line: string;
  pick_side: string;
  pick_confidence: string;
  is_bet: string;
  result_status: string;
  correct: string;
  home_injury_impact?: string;
  away_injury_impact?: string;
  pinnacle_prob?: string;
  edge_vs_pinnacle?: string;
}

function parseCsv(text: string): CsvRow[] {
  const lines = text.trim().split("\n").filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const vals = line.split(",");
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = (vals[i] ?? "").trim(); });
    return row as unknown as CsvRow;
  });
}

function teamLabel(code: string): string {
  const map: Record<string, string> = {
    atl:"ATL",bos:"BOS",bkn:"BKN",cha:"CHA",chi:"CHI",cle:"CLE",
    dal:"DAL",den:"DEN",det:"DET",gs:"GSW",hou:"HOU",ind:"IND",
    lac:"LAC",lal:"LAL",mem:"MEM",mia:"MIA",mil:"MIL",min:"MIN",
    no:"NOP",ny:"NYK",okc:"OKC",orl:"ORL",phi:"PHI",phx:"PHX",
    por:"POR",sa:"SAS",sac:"SAC",tor:"TOR",utah:"UTA",wsh:"WAS",
  };
  return map[code?.toLowerCase()] ?? code?.toUpperCase() ?? "???";
}

export async function GET() {
  // Authed users see every field on every pick. Anonymous users see
  // graded picks fully (proof of edge — useful as marketing) but get
  // pinnacle_prob / edge_vs_pinnacle stripped on pending picks so the
  // unauthenticated dashboard isn't a free leak of tonight's edge to
  // non-subscribers.
  const session = await auth();
  const isAuthed = !!session?.user;

  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
  const csvPath = path.join(appRoot, "ml", "nba_spread", "data", "model_performance.csv");

  let rows: CsvRow[] = [];
  try {
    const text = await fs.readFile(csvPath, "utf-8");
    rows = parseCsv(text);
  } catch {
    // File doesn't exist yet — return empty state
    return NextResponse.json({ stats: null, picks: [], refreshed_at: new Date().toISOString() });
  }

  // ── Stats: all predictions ──────────────────────────────────
  const graded = rows.filter((r) => r.result_status === "graded");
  const pending = rows.filter((r) => r.result_status === "pending");
  const pushed  = rows.filter((r) => r.result_status === "push");

  const wins   = graded.filter((r) => r.correct === "1").length;
  const losses = graded.length - wins;
  const winRate = graded.length > 0 ? wins / graded.length : null;

  // Flat-bet ROI at -110 vig
  const payout = 100 / 110;
  const units  = graded.length > 0 ? wins * payout + losses * -1 : null;
  const roi    = graded.length > 0 && units !== null ? units / graded.length : null;

  // ── Stats: high-confidence bets only ─────────────────────────
  const betsAll    = rows.filter((r) => r.is_bet === "1");
  const betsGraded = graded.filter((r) => r.is_bet === "1");
  const betsWins   = betsGraded.filter((r) => r.correct === "1").length;
  const betsLosses = betsGraded.length - betsWins;
  const betsWinRate = betsGraded.length > 0 ? betsWins / betsGraded.length : null;
  const betsUnits  = betsGraded.length > 0 ? betsWins * payout + betsLosses * -1 : null;
  const betsRoi    = betsGraded.length > 0 && betsUnits !== null ? betsUnits / betsGraded.length : null;

  // ── Recent picks (last 10, newest first) ─────────────────────
  const recent = [...rows]
    .sort((a, b) => b.logged_at.localeCompare(a.logged_at))
    .slice(0, 10)
    .map((r) => {
      const isGraded = r.result_status === "graded" || r.result_status === "push";
      // Edge/probability fields only leak for graded picks when unauthed —
      // anonymous visitors should never see tonight's actionable edge.
      const exposeEdge = isAuthed || isGraded;
      return {
        game_id:         r.game_id,
        commence_time:   r.commence_time,
        matchup:         `${teamLabel(r.away_team)} @ ${teamLabel(r.home_team)}`,
        home_line:       parseFloat(r.home_line) || 0,
        pick_side:       r.pick_side,
        pick_confidence: parseFloat(r.pick_confidence) || 0,
        is_bet:          r.is_bet === "1",
        result_status:   r.result_status,
        correct:         r.correct === "1" ? true : r.correct === "0" ? false : null,
        home_injury_impact: parseFloat(r.home_injury_impact ?? "0") || 0,
        away_injury_impact: parseFloat(r.away_injury_impact ?? "0") || 0,
        pinnacle_prob:    exposeEdge && r.pinnacle_prob    ? parseFloat(r.pinnacle_prob)    : null,
        edge_vs_pinnacle: exposeEdge && r.edge_vs_pinnacle ? parseFloat(r.edge_vs_pinnacle) : null,
      };
    });

  return NextResponse.json({
    stats: {
      total:          rows.length,
      graded:         graded.length,
      pending:        pending.length,
      pushed:         pushed.length,
      wins,
      losses,
      win_rate:       winRate,
      roi,
      bets_total:     betsAll.length,
      bets_graded:    betsGraded.length,
      bets_wins:      betsWins,
      bets_losses:    betsLosses,
      bets_win_rate:  betsWinRate,
      bets_roi:       betsRoi,
    },
    picks: recent,
    refreshed_at: new Date().toISOString(),
  });
}
