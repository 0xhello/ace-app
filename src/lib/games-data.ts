import { Game } from "@/types/game";
import { fetchAllGames } from "@/lib/odds-api";

export async function fetchGames(): Promise<Game[]> {
  const result = await fetchAllGames();
  return result.games;
}

export async function fetchGameById(gameId: string): Promise<Game | null> {
  const games = await fetchGames();
  return games.find((g) => g.id === gameId) ?? null;
}
