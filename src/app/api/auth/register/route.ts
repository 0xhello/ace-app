import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import {
  ensureAuthSchema,
  getUserCount,
  getUserByEmail,
  createUser,
  checkInviteCode,
  redeemInviteCode,
} from "@/lib/auth-db";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body.email !== "string" || typeof body.password !== "string") {
    return NextResponse.json({ error: "email and password required" }, { status: 400 });
  }

  const { email, password, invite_code } = body as {
    email: string;
    password: string;
    invite_code?: string;
  };

  if (password.length < 8) {
    return NextResponse.json({ error: "password must be at least 8 characters" }, { status: 400 });
  }

  ensureAuthSchema();

  const count = getUserCount();
  const isFirstUser = count === 0;

  if (!isFirstUser && !invite_code) {
    return NextResponse.json({ error: "invite code required" }, { status: 403 });
  }

  if (!isFirstUser && invite_code) {
    if (!checkInviteCode(invite_code)) {
      return NextResponse.json({ error: "invalid or already used invite code" }, { status: 403 });
    }
  }

  if (getUserByEmail(email)) {
    return NextResponse.json({ error: "email already registered" }, { status: 409 });
  }

  const role = isFirstUser ? "admin" : "user";
  const hash = await bcrypt.hash(password, 12);
  const ok = createUser(email, hash, role);
  if (!ok) {
    return NextResponse.json({ error: "failed to create user" }, { status: 500 });
  }

  if (!isFirstUser && invite_code) {
    redeemInviteCode(invite_code, email);
  }

  return NextResponse.json({ ok: true, role });
}
