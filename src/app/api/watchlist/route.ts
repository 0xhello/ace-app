import { auth } from "@/auth";
import { NextResponse } from "next/server";
import { getUserWatchlist, addToWatchlist, ensureAuthSchema } from "@/lib/auth-db";

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  ensureAuthSchema();
  const userId = parseInt((session.user as any).id, 10);
  const gameIds = getUserWatchlist(userId);
  return NextResponse.json({ gameIds });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { gameId } = body;
  if (!gameId) return NextResponse.json({ error: "Missing gameId" }, { status: 400 });

  ensureAuthSchema();
  const userId = parseInt((session.user as any).id, 10);
  const ok = addToWatchlist(userId, gameId);
  return NextResponse.json({ ok });
}
