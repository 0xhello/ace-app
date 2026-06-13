/**
 * MatchTakes — the "ACE Take" module: grounded analyst reads across the markets
 * a fan actually plays (result, total, BTTS, corners, scorer, shots). Data comes
 * from src/lib/match-takes (Sportmonks predictions + our player baselines), not
 * from a de-vig of the betting line. Purely presentational; honest empty state.
 */
import { Brain } from "lucide-react";
import type { GameTakes, TakeTier } from "@/lib/match-takes";

const TIER_STYLE: Record<TakeTier, { chip: string; dot: string; label: string }> = {
  Strong: { chip: "bg-[#16331f] text-[#5fe39a] ring-[#215a2e]", dot: "bg-[#3ee68a]", label: "Strong" },
  Lean:   { chip: "bg-[#1c2718] text-[#9fd886] ring-[#2c3a22]", dot: "bg-[#9fd886]", label: "Lean" },
  Slight: { chip: "bg-[#16181c] text-[#9aa3b0] ring-[#262c34]", dot: "bg-[#6b7280]", label: "Slight" },
};
const TIER_ORDER: Record<TakeTier, number> = { Strong: 0, Lean: 1, Slight: 2 };

export default function MatchTakes({ takes }: { takes: GameTakes | null }) {
  const list = (takes?.takes ?? []).slice().sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier]);

  return (
    <section className="mt-5 rounded-2xl border border-[#2c4a2f] bg-gradient-to-b from-[#0f1a10] to-[#0c0e0c] p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Brain className="h-3.5 w-3.5 text-[#3ee68a]" strokeWidth={2} />
          <h2 className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-[#5fe39a]">ACE Take</h2>
        </div>
        {list.length > 0 && (
          <span className="text-[10px] font-mono text-[#7a8278]">{list.length} read{list.length === 1 ? "" : "s"}</span>
        )}
      </div>

      {list.length > 0 ? (
        <>
          <div className="divide-y divide-[#16331f]/50">
            {list.map((t, i) => {
              const ts = TIER_STYLE[t.tier];
              return (
                <div key={i} className="flex items-start gap-3 py-2.5">
                  <span className={`shrink-0 mt-0.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 ring-1 text-[9px] font-bold uppercase tracking-wide ${ts.chip}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${ts.dot}`} />{ts.label}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-[10px] uppercase tracking-[0.14em] text-[#5f655c] font-bold">{t.market_label}</span>
                      <span className="text-[14px] font-semibold text-white">{t.selection}</span>
                      {t.model_pct != null && (
                        <span className="text-[11px] font-mono text-[#7f8a78]">{t.model_pct}%</span>
                      )}
                    </div>
                    {t.reasons?.[0] && (
                      <p className="text-[12px] text-[#9ca39a] leading-snug mt-0.5">{t.reasons[0]}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="mt-3 pt-3 border-t border-[#16331f]/60 text-[10px] text-[#5f655c] leading-relaxed">
            Reads from a match model + our player data — our analyst take, graded against results, not a guarantee. Tiers reflect how decisive the read is; coin-flips get no take.
          </p>
        </>
      ) : (
        <div className="flex items-center gap-2.5">
          <Brain className="h-3.5 w-3.5 text-[#565c52] shrink-0" strokeWidth={1.8} />
          <p className="text-[12px] text-[#8a9286]">
            No clear take on this one yet — nothing separates enough from a coin-flip. Reads firm up as lineups and the model settle closer to kickoff.
          </p>
        </div>
      )}
    </section>
  );
}
