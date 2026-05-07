import { auth } from "@/auth";
import { NextResponse } from "next/server";
import { updateUserAlert, deleteUserAlert, ensureAuthSchema } from "@/lib/auth-db";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await req.json();

  // Map camelCase fields to DB snake_case
  const updates: Record<string, any> = {};
  if (body.status !== undefined) updates.status = body.status;
  if (body.triggeredAt !== undefined) updates.triggered_at = body.triggeredAt;
  if (body.triggeredOdds !== undefined) updates.triggered_odds = body.triggeredOdds;

  if (!Object.keys(updates).length) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  ensureAuthSchema();
  const userId = parseInt((session.user as any).id, 10);
  const ok = updateUserAlert(id, userId, updates);
  return NextResponse.json({ ok });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  ensureAuthSchema();
  const userId = parseInt((session.user as any).id, 10);
  const ok = deleteUserAlert(id, userId);
  return NextResponse.json({ ok });
}
