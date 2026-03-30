import GameCard from "@/components/GameCard";
import { Game } from "@/types/game";

async function getGames(): Promise<Game[]> {
  const url = `${process.env.ODDS_API_URL || "http://localhost:8000"}/games`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return [];
  const data = await res.json();
  return data.games || [];
}

export default async function GamesFeed() {
  const games = await getGames();

  const live = games.filter((g) => g.status === "live");
  const upcoming = games.filter((g) => g.status !== "live");

  if (games.length === 0) {
    return (
      <div className="text-center py-20 text-ace-muted">
        <p className="text-lg font-medium text-white mb-2">No games right now</p>
        <p className="text-sm">Check back when games are scheduled</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {live.length > 0 && (
        <section>
          <div className="flex items-center gap-2 mb-3">
            <span className="h-2 w-2 rounded-full bg-ace-red animate-pulse" />
            <h2 className="text-sm font-bold text-ace-red uppercase tracking-wider">Live Now</h2>
            <span className="bg-ace-red/20 text-ace-red text-xs px-2 py-0.5 rounded-full">{live.length}</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {live.map((game) => <GameCard key={game.id} game={game} />)}
          </div>
        </section>
      )}

      {upcoming.length > 0 && (
        <section>
          {live.length > 0 && (
            <h2 className="text-sm font-bold text-ace-muted uppercase tracking-wider mb-3">Upcoming</h2>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {upcoming.map((game) => <GameCard key={game.id} game={game} />)}
          </div>
        </section>
      )}
    </div>
  );
}
