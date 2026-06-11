"use client";

/**
 * LiveLineups — team sheets from the real Sportmonks lineup feed.
 * Polls the live endpoint (lineups change rarely, so a slow ~60s poll) and
 * renders both teams' starters once the provider posts them. Do not overclaim
 * pre-kickoff: these are provider lineups/team sheets, not app-invented picks.
 */
import { useEffect, useState } from "react";
import { Users } from "lucide-react";

interface LineupPlayer { name: string | null; number: number | null; pos: string | null; team: "home" | "away"; starter: boolean; order: number }
const POLL_MS = 60_000;
const POS_ORDER = ["GK", "DEF", "MID", "FWD"];

function Column({ team, players, align }: { team: string; players: LineupPlayer[]; align: "left" | "right" }) {
  const byPos = POS_ORDER.map((p) => ({ pos: p, men: players.filter((x) => x.pos === p).sort((a, b) => a.order - b.order) }))
    .filter((g) => g.men.length > 0);
  const other = players.filter((x) => !x.pos || !POS_ORDER.includes(x.pos));
  if (other.length) byPos.push({ pos: "—", men: other });
  return (
    <div className="rounded-2xl border border-[#1b201a] bg-[#0d0f0d] p-4">
      <p className={`text-[12.5px] font-semibold text-[#e7eae4] mb-2.5 truncate ${align === "right" ? "text-right" : ""}`}>{team}</p>
      <div className="space-y-2.5">
        {byPos.map((g) => (
          <div key={g.pos}>
            <p className={`text-[9px] uppercase tracking-[0.18em] text-[#5f655c] mb-1 ${align === "right" ? "text-right" : ""}`}>{g.pos}</p>
            <div className="space-y-1">
              {g.men.map((p, i) => (
                <div key={i} className={`flex items-center gap-2 text-[12px] ${align === "right" ? "flex-row-reverse" : ""}`}>
                  <span className="text-[10px] font-mono text-[#6b7068] w-[18px] tabular-nums shrink-0 text-center">{p.number ?? "·"}</span>
                  <span className="text-[#c4c7c0] truncate">{p.name}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function LiveLineups({
  gameId, fixtureId, homeTeam, awayTeam,
}: { gameId: string; fixtureId: string | null; homeTeam: string; awayTeam: string }) {
  const [players, setPlayers] = useState<LineupPlayer[] | null>(null);

  useEffect(() => {
    if (!fixtureId) return;
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch(`/api/game/${gameId}/live?fixtureId=${fixtureId}`, { cache: "no-store" });
        const j = await r.json();
        if (alive) setPlayers(Array.isArray(j.lineups) ? j.lineups : []);
      } catch { /* keep last */ }
    };
    poll();
    const t = setInterval(poll, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [gameId, fixtureId]);

  const homeXI = (players ?? []).filter((p) => p.team === "home" && p.starter);
  const awayXI = (players ?? []).filter((p) => p.team === "away" && p.starter);
  const ready = homeXI.length >= 7 && awayXI.length >= 7;

  return (
    <section className="mt-6">
      <div className="flex items-center gap-2 mb-3">
        <Users className="h-3.5 w-3.5 text-[#3ee68a]" strokeWidth={1.9} />
        <h2 className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-[#aab0a4]">Team sheets</h2>
      </div>
      {ready ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Column team={awayTeam} players={awayXI} align="left" />
          <Column team={homeTeam} players={homeXI} align="right" />
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-[#22271f] bg-[#0b0d0b] px-5 py-4">
          <p className="text-[12.5px] text-[#9ca39a]">Team sheets aren&apos;t posted yet — they typically land about an hour before kickoff. The moment the provider sends them, both lineups appear here.</p>
        </div>
      )}
    </section>
  );
}
