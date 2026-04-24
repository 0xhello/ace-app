import { NextResponse } from "next/server";
import { fetchAllGames, fetchOddsForSport } from "@/lib/odds-api";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const sport = searchParams.get("sport");

  try {
    if (sport) {
      const raw = await fetchOddsForSport(sport);
      return NextResponse.json({ games: raw });
    }
    const result = await fetchAllGames();
    return NextResponse.json({ games: result.games, errors: result.errors });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
