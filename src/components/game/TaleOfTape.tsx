/**
 * TaleOfTape — a compact, at-a-glance head-to-head of the two sides' recent form
 * (last 5). Center-anchored diverging bars per metric, with the stronger side's
 * number highlighted. Pure render off the recent-form summaries we already pull
 * (no extra fetch); complements the raw last-5 results above it. Server component.
 */
import type { RecentFormSummary } from "@/lib/soccer-recent-form";

interface Row { label: string; away: number; home: number; lowerBetter?: boolean }

function rows(a: RecentFormSummary, h: RecentFormSummary): Row[] {
  return [
    { label: "Form points · last 5", away: a.w * 3 + a.d, home: h.w * 3 + h.d },
    { label: "Goals scored", away: a.gf, home: h.gf },
    { label: "Goals conceded", away: a.ga, home: h.ga, lowerBetter: true },
    { label: "Clean sheets", away: a.clean_sheets, home: h.clean_sheets },
  ];
}

function Bar({ row }: { row: Row }) {
  const max = Math.max(row.away, row.home, 1);
  const aw = (row.away / max) * 100;
  const hw = (row.home / max) * 100;
  const awayBetter = row.lowerBetter ? row.away < row.home : row.away > row.home;
  const homeBetter = row.lowerBetter ? row.home < row.away : row.home > row.away;
  const aColor = awayBetter ? "bg-[#3ee68a]" : "bg-[#3a4250]";
  const hColor = homeBetter ? "bg-[#3ee68a]" : "bg-[#3a4250]";
  return (
    <div className="py-2">
      <div className="grid grid-cols-[28px_1fr_28px] items-center gap-3">
        <span className={`text-[12px] font-mono tabular-nums text-right ${awayBetter ? "text-[#5fe39a] font-bold" : "text-[#8a9286]"}`}>{row.away}</span>
        <div className="flex items-center">
          <div className="flex-1 flex justify-end"><div className={`h-1.5 rounded-l-full ${aColor}`} style={{ width: `${aw}%` }} /></div>
          <div className="h-3 w-px bg-[#262c24] shrink-0" />
          <div className="flex-1"><div className={`h-1.5 rounded-r-full ${hColor}`} style={{ width: `${hw}%` }} /></div>
        </div>
        <span className={`text-[12px] font-mono tabular-nums ${homeBetter ? "text-[#5fe39a] font-bold" : "text-[#8a9286]"}`}>{row.home}</span>
      </div>
      <p className="text-center text-[9.5px] uppercase tracking-[0.14em] text-[#5f655c] mt-1">{row.label}</p>
    </div>
  );
}

export default function TaleOfTape({
  awayTeam, homeTeam, awaySummary, homeSummary,
}: { awayTeam: string; homeTeam: string; awaySummary: RecentFormSummary; homeSummary: RecentFormSummary }) {
  return (
    <div className="rounded-2xl border border-[#1b201a] bg-[#0d0f0d] p-5">
      <div className="flex items-center justify-between mb-1 text-[12px] font-semibold">
        <span className="text-[#e7eae4] truncate">{awayTeam}</span>
        <span className="text-[#e7eae4] truncate text-right">{homeTeam}</span>
      </div>
      <div className="divide-y divide-[#141714]">
        {rows(awaySummary, homeSummary).map((r) => <Bar key={r.label} row={r} />)}
      </div>
      <p className="text-[9.5px] text-[#4a524a] mt-2">Last 5 matches · greener side is the stronger number.</p>
    </div>
  );
}
