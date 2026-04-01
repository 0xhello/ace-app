import { Game } from "@/types/game";
import DashboardShell from "@/components/dashboard/DashboardShell";
import { fetchBoardIntel, fetchTopPicks } from "@/lib/intel-data";

async function getGames(): Promise<Game[]> {
  const url = `${process.env.ODDS_API_URL || "http://localhost:8000"}/games`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return [];
  const data = await res.json();
  return data.games || [];
}

export default async function GamesFeed() {
  const [games, boardIntel, topPicks] = await Promise.all([
    getGames(),
    fetchBoardIntel(100),
    fetchTopPicks(4),
  ]);

  if (games.length === 0) {
    return (
      <div className="text-center py-20 text-ace-muted">
        <p className="text-lg font-medium text-white mb-2">No games right now</p>
        <p className="text-sm">Check back when games are scheduled</p>
      </div>
    );
  }

  const intelMap = Object.fromEntries((boardIntel.items || []).map((item: any) => [item.game_id, item]));

  return <DashboardShell games={games} intelMap={intelMap} boardUpdatedAt={boardIntel.updated_at} topPicks={topPicks.items || []} />;
}
