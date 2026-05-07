import { auth } from "@/auth";
import { NextResponse } from "next/server";
import { removeFromWatchlist, ensureAuthSchema } from "@/lib/auth-db";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ gameId: string }> }
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { gameId } = await params;
  ensureAuthSchema();
  const userId = parseInt((session.user as any).id, 10);
  const ok = removeFromWatchlist(userId, gameId);
  return NextResponse.json({ ok });
}
