import Link from "next/link";
import { Activity, Clock3, CheckCircle2, ChevronRight, Sparkles } from "lucide-react";
import { fetchGames } from "@/lib/games-data";
import { getTrackedBucket, getTrackedSummary } from "@/lib/tracked";
import { getSignalsForGame } from "@/lib/signals";

export const dynamic = "force-dynamic";

function Section({ title, icon: Icon, games }: { title: string; icon: any; games: any[] }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 px-1">
        <Icon className="h-4 w-4 text-[#00ff7f]" />
        <h2 className="text-[13px] font-semibold text-white">{title}</h2>
        <span className="text-[10px] font-mono text-[#3f3f46]">{games.length}</span>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {games.map((game) => {
          const signals = getSignalsForGame(game.id, game.home_team, game.away_team);
          return (
            <Link
              key={game.id}
              href={`/dashboard/tracked/${game.id}`}
              className="rounded-xl border border-[#141417] bg-[#0c0c0e] hover:border-[#1e1e24] transition-colors p-4"
            >
              <div className="flex items-start justify-between gap-3 mb-2">
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold text-white truncate">{game.away_team} @ {game.home_team}</p>
                  <p className="text-[10px] text-[#3f3f46] mt-0.5">{game.sport_title}</p>
                </div>
                <ChevronRight className="h-4 w-4 text-[#27272a] shrink-0" />
              </div>

              <div className="flex items-center gap-3 text-[10px] mb-2">
                <span className="text-[#52525b]">{game.status === "live" ? "LIVE" : "Monitoring"}</span>
                <span className="text-[#27272a]">•</span>
                <span className="text-[#00ff7f] font-mono">{signals.length} signals</span>
              </div>

              <p className="text-[11px] text-[#a1a1aa] leading-relaxed">{getTrackedSummary(game)}</p>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

export default async function TrackedPage() {
  const games = await fetchGames();
  const trackedGames = games.slice(0, 12);

  const active = trackedGames.filter((g) => getTrackedBucket(g) === "active");
  const quiet = trackedGames.filter((g) => getTrackedBucket(g) === "quiet");
  const completed = trackedGames.filter((g) => getTrackedBucket(g) === "completed");

  return (
    <div className="flex-1 overflow-y-auto bg-[#09090b]">
      <div className="max-w-6xl mx-auto px-6 py-6 space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-[20px] font-bold text-white">Tracked</h1>
            <p className="text-[12px] text-[#52525b] mt-1">Monitor active games, quiet spots, and recent completions.</p>
          </div>
          <div className="flex items-center gap-4 text-[11px]">
            <div className="flex items-center gap-1.5 text-[#71717a]"><Activity className="h-3.5 w-3.5 text-[#00ff7f]" /> {active.length} active</div>
            <div className="flex items-center gap-1.5 text-[#71717a]"><Clock3 className="h-3.5 w-3.5 text-[#f59e0b]" /> {quiet.length} quiet</div>
            <div className="flex items-center gap-1.5 text-[#71717a]"><CheckCircle2 className="h-3.5 w-3.5 text-[#3b82f6]" /> {completed.length} completed</div>
          </div>
        </div>

        <Section title="Active games" icon={Activity} games={active} />
        <Section title="Quiet games" icon={Clock3} games={quiet} />
        <Section title="Completed games" icon={CheckCircle2} games={completed} />
      </div>
    </div>
  );
}
