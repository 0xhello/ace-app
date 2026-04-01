import { Game } from "@/types/game";

export async function fetchGames(): Promise<Game[]> {
  const url = `${process.env.ODDS_API_URL || "http://localhost:8000"}/games`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return [];
  const data = await res.json();
  return data.games || [];
}

export async function fetchGameById(gameId: string): Promise<Game | null> {
  const games = await fetchGames();
  return games.find((g) => g.id === gameId) ?? null;
}
