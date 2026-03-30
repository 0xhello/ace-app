import { NextResponse } from "next/server";

const ACE_BACKEND = process.env.ODDS_API_URL || "http://localhost:8000";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const sport = searchParams.get("sport") || "";

  try {
    const url = sport
      ? `${ACE_BACKEND}/games/${sport}`
      : `${ACE_BACKEND}/games`;
    const res = await fetch(url, { next: { revalidate: 60 } });
    if (!res.ok) throw new Error(`Backend error: ${res.status}`);
    const data = await res.json();
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
