import { auth } from "@/auth";
import { NextResponse } from "next/server";
import { getUserBets, createUserBets, ensureAuthSchema } from "@/lib/auth-db";

function toClientBet(row: any) {
  return {
    id: row.id,
    gameId: row.game_id,
    matchup: row.matchup,
    market: row.market,
    label: row.label,
    odds: row.odds,
    book: row.book,
    stake: row.stake,
    confidenceTier: row.confidence_tier,
    status: row.status,
    placedAt: row.placed_at,
    settledAt: row.settled_at ?? undefined,
  };
}

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  ensureAuthSchema();
  const userId = parseInt((session.user as any).id, 10);
  const rows = getUserBets(userId);
  return NextResponse.json({ bets: rows.map(toClientBet) });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const bets: any[] = body.bets ?? [];
  if (!bets.length) return NextResponse.json({ ok: false }, { status: 400 });

  ensureAuthSchema();
  const userId = parseInt((session.user as any).id, 10);

  // Map camelCase → snake_case for DB
  const dbBets = bets.map((b) => ({
    id: b.id,
    game_id: b.gameId,
    matchup: b.matchup,
    market: b.market,
    label: b.label,
    odds: b.odds,
    book: b.book,
    stake: b.stake,
    confidence_tier: b.confidenceTier,
    placed_at: b.placedAt,
  }));

  const ok = createUserBets(userId, dbBets);
  return NextResponse.json({ ok });
}
