import { Game } from "@/types/game";
import DashboardShell from "@/components/dashboard/DashboardShell";

async function getGames(): Promise<Game[]> {
  const url = `${process.env.ODDS_API_URL || "http://localhost:8000"}/games`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return [];
  const data = await res.json();
  return data.games || [];
}

export default async function GamesFeed() {
  const games = await getGames();

  if (games.length === 0) {
    return (
      <div className="text-center py-20 text-ace-muted">
        <p className="text-lg font-medium text-white mb-2">No games right now</p>
        <p className="text-sm">Check back when games are scheduled</p>
      </div>
    );
  }

  return <DashboardShell games={games} />;
}
