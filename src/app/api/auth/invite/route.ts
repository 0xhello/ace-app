import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { ensureAuthSchema, listInviteCodes, createInviteCode } from "@/lib/auth-db";
import crypto from "crypto";

export async function GET() {
  const session = await auth();
  if (!session || (session.user as { role?: string }).role !== "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  ensureAuthSchema();
  const codes = listInviteCodes();
  return NextResponse.json({ codes });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session || (session.user as { role?: string }).role !== "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  ensureAuthSchema();

  const body = await req.json().catch(() => ({}));
  const label = typeof body.label === "string" ? body.label : undefined;
  const code = crypto.randomBytes(6).toString("hex").toUpperCase();

  const ok = createInviteCode(code, label);
  if (!ok) {
    return NextResponse.json({ error: "failed to create code" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, code });
}
