import { auth } from "@/auth";
import { NextResponse } from "next/server";
import { updateUserBetStatus, ensureAuthSchema } from "@/lib/auth-db";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await req.json();
  const { status } = body;

  if (!["pending", "won", "lost", "void"].includes(status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  ensureAuthSchema();
  const userId = parseInt((session.user as any).id, 10);
  const ok = updateUserBetStatus(id, userId, status);
  return NextResponse.json({ ok });
}
