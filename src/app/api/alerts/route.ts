import { auth } from "@/auth";
import { NextResponse } from "next/server";
import { getUserAlerts, createUserAlert, ensureAuthSchema } from "@/lib/auth-db";

function toClientAlert(row: any) {
  return {
    id: row.id,
    gameId: row.game_id,
    matchup: row.matchup,
    team: row.team,
    market: row.market,
    side: row.side,
    condition: row.condition,
    threshold: row.threshold,
    book: row.book,
    status: row.status,
    createdAt: row.created_at,
    triggeredAt: row.triggered_at ?? undefined,
    triggeredOdds: row.triggered_odds ?? undefined,
  };
}

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  ensureAuthSchema();
  const userId = parseInt((session.user as any).id, 10);
  const rows = getUserAlerts(userId);
  return NextResponse.json({ alerts: rows.map(toClientAlert) });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { alert } = body;
  if (!alert?.id || !alert?.matchup || !alert?.team) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }

  ensureAuthSchema();
  const userId = parseInt((session.user as any).id, 10);

  const dbAlert = {
    id: alert.id,
    game_id: alert.gameId ?? "",
    matchup: alert.matchup,
    team: alert.team,
    market: alert.market,
    side: alert.side,
    condition: alert.condition,
    threshold: alert.threshold,
    book: alert.book ?? "any",
    status: alert.status ?? "active",
    created_at: alert.createdAt ?? new Date().toISOString(),
  };

  const ok = createUserAlert(userId, dbAlert);
  return NextResponse.json({ ok });
}
