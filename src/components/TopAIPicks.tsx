"use client";

import { cn, teamAbbr } from "@/lib/utils";
import { Sparkles, Plus, TrendingUp } from "lucide-react";
import { SlipLeg } from "@/components/dashboard/DashboardShell";
import { generateAIPicks } from "@/lib/signals";
import { getTeamLogoUrl } from "@/lib/team-logos";

const TYPE_COLOR: Record<string, { text: string; bg: string }> = {
  TOTAL:  { text: "text-[#3b82f6]",  bg: "bg-[#3b82f6]/10" },
  OVER:   { text: "text-[#3b82f6]",  bg: "bg-[#3b82f6]/10" },
  UNDER:  { text: "text-[#f5c062]",  bg: "bg-[#f5c062]/10" },
  ML:     { text: "text-[#8b5cf6]",  bg: "bg-[#8b5cf6]/10" },
  PROP:   { text: "text-[#f59e0b]",  bg: "bg-[#f59e0b]/10" },
  SPREAD: { text: "text-[#3ee68a]",  bg: "bg-[#3ee68a]/10" },
};

const TIER_COLOR: Record<string, string> = {
  high:   "#3ee68a",
  medium: "#f5c062",
  low:    "#ef8b44",
};

function parseTeams(pick: any) {
  const away = pick.away_team || pick.awayTeam || pick.away || pick.game?.split(" @ ")[0] || "AWAY";
  const home = pick.home_team || pick.homeTeam || pick.home || pick.game?.split(" @ ")[1] || "HOME";
  const sport = pick.sport_title || pick.sportTitle || pick.sport || "";
  return { away, home, sport };
}

function FeedTeamBadge({ team, sport }: { team: string; sport: string }) {
  const logoUrl = getTeamLogoUrl(team, sport);
  const abbr = team.length <= 4 && team === team.toUpperCase() ? team : teamAbbr(team);

  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-[#252b23] bg-[#141714] px-2 py-[3px] text-[9px] font-semibold text-[#a3aca0]">
      {logoUrl ? (
        <img src={logoUrl} alt={team} className="h-3.5 w-3.5 object-contain shrink-0" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
      ) : (
        <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[#1c211c] text-[7px] font-bold text-[#7f867c]">{abbr.slice(0, 3)}</span>
      )}
      <span>{abbr}</span>
    </span>
  );
}

function confidenceRingStyle(pct: number, color: string) {
  return {
    background: `conic-gradient(${color} 0 ${pct}%, rgba(255,255,255,0.08) ${pct}% 100%)`,
  };
}

function displayType(pick: any) {
  const text = `${pick.pick || ""} ${pick.market || ""}`.toLowerCase();
  if (text.includes("under") || /^u\s/.test((pick.pick || "").toLowerCase())) return "UNDER";
  if (text.includes("over") || /^o\s/.test((pick.pick || "").toLowerCase())) return "OVER";
  return pick.type;
}

export default function TopAIPicks({ onAddLeg, picks }: { onAddLeg?: (leg: SlipLeg) => void; picks?: any[] }) {
  const resolvedPicks = picks && picks.length > 0 ? picks : generateAIPicks();

  return (
    <div className="shrink-0 border-b border-[#1b201a] bg-[linear-gradient(180deg,rgba(11,13,11,0.96),rgba(9,10,9,0.98))]">
      <div className="px-5 pt-3 pb-3">
        <div className="ace-panel px-4 py-3.5">
          <div className="flex items-start justify-between gap-3 pb-3 border-b border-[#1e231d]">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <div className="flex items-center justify-center h-6 w-6 rounded-lg bg-[#3ee68a]/10 border border-[#3ee68a]/15">
                  <Sparkles className="h-3 w-3 text-[#3ee68a]" />
                </div>
                <span className="text-[11px] font-bold text-white uppercase tracking-[0.22em]">Signal feed</span>
              </div>
              <p className="mt-2 text-[11px] text-[#8c9389] max-w-[520px] leading-relaxed">
                Real-time edge detection
              </p>
            </div>
            <div className="hidden md:flex items-center gap-2 text-[10px] text-[#7a8278]">
              <span className="text-[#8c9389]">Tap card to add pick</span>
            </div>
          </div>

          <div className="flex gap-3 pt-3 overflow-x-auto scrollbar-hide">
        {resolvedPicks.map((pick) => {
          const resolvedType = displayType(pick);
          const typeStyle = TYPE_COLOR[resolvedType] ?? TYPE_COLOR[pick.type] ?? { text: "text-[#6b7068]", bg: "bg-[#6b7068]/10" };
          const tierColor = TIER_COLOR[pick.confidence?.tier ?? "low"];
          const confPct = pick.confidence?.pct ?? 0;
          const { away, home, sport } = parseTeams(pick);

          return (
            <button
              key={pick.id}
              onClick={() => onAddLeg?.({
                id: pick.id,
                gameId: pick.gameId,
                matchup: pick.game,
                market: pick.market,
                label: pick.pick,
                odds: pick.odds,
              })}
              className="shrink-0 w-[292px] rounded-2xl border border-[#20251f] bg-[linear-gradient(180deg,rgba(18,20,18,0.98),rgba(13,15,13,0.98))] hover:border-[#2f352b] transition-all p-3.5 flex flex-col gap-2.5 group text-left shadow-[0_12px_30px_rgba(0,0,0,0.22)]"
            >
              {/* Row 1: matchup pill + type + confidence */}
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
                  <FeedTeamBadge team={away} sport={sport} />
                  <span className="text-[8px] text-[#465046]">@</span>
                  <FeedTeamBadge team={home} sport={sport} />
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={cn("text-[8px] font-bold uppercase tracking-wider px-1.5 py-[2px] rounded", typeStyle.text, typeStyle.bg)}>
                    {resolvedType}
                  </span>
                  <div className="flex flex-col items-center gap-0.5">
                    <div className="relative h-7 w-7 rounded-full p-[2px]" style={confidenceRingStyle(confPct, tierColor)}>
                      <div className="flex h-full w-full items-center justify-center rounded-full bg-[#101210] text-[9px] font-semibold text-[#f0d08b] font-mono">
                        {confPct}
                      </div>
                    </div>
                    <span className="text-[7px] uppercase tracking-[0.12em] text-[#7f867c]">Conf</span>
                  </div>
                </div>
              </div>

              {/* Row 2: pick title + odds */}
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-[15px] font-extrabold text-white leading-tight tracking-tight truncate">
                  {pick.pick}
                </p>
                <span className={cn("text-[13px] font-mono font-bold shrink-0", pick.odds > 0 ? "text-[#3ee68a]" : "text-[#d4d7d0]")}>
                  {pick.odds > 0 ? `+${pick.odds}` : pick.odds}
                </span>
              </div>

              {/* Row 3: reasoning */}
              <p className="text-[10px] text-[#7f867c] leading-relaxed line-clamp-2 flex-1">
                {pick.reasoning}
              </p>

              {/* Row 4: edge + add button */}
              <div className="flex items-center justify-between pt-2.5 border-t border-[#20251f]">
                <div className="flex items-center gap-1.5">
                  <div className="flex items-center gap-1 bg-[#3ee68a]/[0.06] border border-[#3ee68a]/15 px-2 py-[3px] rounded-md">
                    <TrendingUp className="h-2.5 w-2.5 text-[#3ee68a]" />
                    <span className="text-[9px] font-bold text-[#3ee68a] font-mono">{pick.edge}</span>
                  </div>
                </div>
                <div className="flex items-center gap-1 text-[9px] font-bold text-[#8c9389] uppercase tracking-[0.14em]">
                  <Plus className="h-2.5 w-2.5 text-[#3ee68a]" />
                  Tap card to add pick
                </div>
              </div>
            </button>
          );
        })}
          </div>
        </div>
      </div>
    </div>
  );
}
