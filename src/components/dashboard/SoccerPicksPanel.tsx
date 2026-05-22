"use client";

/**
 * SoccerPicksPanel — the subscriber-facing soccer picks surface on the
 * dashboard. Renders open picks across all soccer markets (h2h, totals,
 * asian_handicap, player_goal_scorer_anytime) with the per-pick AI
 * explainer expand. Also shows the overall graded record at the top so
 * subscribers can verify the model is performing, not just talking.
 *
 * Data:
 *   - List + record: GET /api/picks/soccer (mild edge cache)
 *   - Explainer:     GET /api/picks/explain?signal_id=N (on-demand)
 *
 * Visual language matches the rest of the dashboard (#0a0b0a base,
 * #3ee68a accent, #f5c062 amber for tier B, #6b7068 muted for tier C).
 */
import { useEffect, useState, useCallback } from "react";
import { ChevronDown, ChevronUp, Sparkles, RefreshCw } from "lucide-react";
import type { BookOffer, SoccerPick, SoccerPicksPayload } from "@/lib/soccer-picks";
import { cn } from "@/lib/utils";

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatAmerican(odds: number | null): string {
  if (odds == null) return "—";
  return odds > 0 ? `+${odds}` : `${odds}`;
}

function formatEdge(edge: number | null): string {
  if (edge == null) return "—";
  const pct = edge * 100;
  return (pct >= 0 ? "+" : "") + pct.toFixed(1) + "pp";
}

function tierColor(t: SoccerPick["confidence_tier"]): string {
  if (t === "A") return "#3ee68a";
  if (t === "B") return "#f5c062";
  return "#6b7068";
}

function leagueTagFromTournament(t: string | null): { label: string; color: string } {
  const tl = (t ?? "").toLowerCase();
  if (tl.includes("premier"))     return { label: "EPL",       color: "#7c3aed" };
  if (tl.includes("la liga"))     return { label: "LA LIGA",   color: "#f59e0b" };
  if (tl.includes("bundesliga"))  return { label: "BUNDESLIGA", color: "#ef4444" };
  if (tl.includes("serie a"))     return { label: "SERIE A",   color: "#3b82f6" };
  if (tl.includes("ligue 1"))     return { label: "LIGUE 1",   color: "#06b6d4" };
  if (tl.includes("champions") || tl.includes("ucl")) return { label: "UCL", color: "#a855f7" };
  if (tl.includes("world cup") || tl.includes("fifa")) return { label: "WC 2026", color: "#3ee68a" };
  return { label: "SOCCER", color: "#6b7068" };
}

function describeBet(p: SoccerPick): string {
  const m = p.market;
  if (m === "h2h") {
    if (p.bet_side === "home") return `${p.home_team} ML`;
    if (p.bet_side === "away") return `${p.away_team} ML`;
    if (p.bet_side === "draw") return "Draw";
    return `${p.bet_side}`;
  }
  if (m === "totals") {
    const dir = p.bet_side === "over" ? "Over" : "Under";
    return p.total_line != null ? `${dir} ${p.total_line} goals` : dir;
  }
  if (m === "asian_handicap") {
    const team = p.bet_side === "home" ? p.home_team : p.away_team;
    const line = p.total_line != null
      ? (p.total_line > 0 ? `+${p.total_line}` : `${p.total_line}`)
      : "";
    return `${team} ${line}`.trim();
  }
  if (m === "player_goal_scorer_anytime") {
    return p.player_name ? `${p.player_name} — anytime scorer` : "Anytime scorer";
  }
  return `${m} · ${p.bet_side}`;
}

// ── Components ───────────────────────────────────────────────────────────────

interface Explanation {
  headline: string;
  why: string;
  caveat: string;
}

function BookName({ book }: { book: string }) {
  // Quick title-case for display: "betrivers" → "BetRivers", "draftkings" → "DraftKings".
  // Used for the best-price strip; doesn't need to be exhaustive — falls back to
  // capitalize-first when we don't have a known mapping.
  const NICE: Record<string, string> = {
    fanduel:       "FanDuel",
    draftkings:    "DraftKings",
    betmgm:        "BetMGM",
    betrivers:     "BetRivers",
    williamhill_us:"Caesars",
    pointsbet_us:  "PointsBet",
    pinnacle:      "Pinnacle",
  };
  return <>{NICE[book] ?? book.charAt(0).toUpperCase() + book.slice(1)}</>;
}

function BestPriceStrip({ pick }: { pick: SoccerPick }) {
  // Surfaces the actual price landscape — the differentiator subscribers
  // care about. Falls back to the triggering soft book if we don't have
  // multi-book offers captured yet (older signals).
  const offers = pick.book_offers ?? [];
  if (!offers.length) {
    if (!pick.book || pick.book_odds == null) return null;
    return (
      <span className="text-[10px] text-[#9ca39a]">
        <BookName book={pick.book} />{" "}
        <span className="text-[#d4d7d0] font-mono ml-0.5">{formatAmerican(pick.book_odds)}</span>
      </span>
    );
  }
  // Filter Pinnacle from the alts shown to subscribers — they can't bet there
  // (US-restricted) so it's just noise. Pinnacle's role is the sharp anchor
  // upstream, not a retail price.
  const showable = offers.filter((o) => o.book !== "pinnacle");
  if (showable.length === 0) return null;
  const top = showable[0];
  const others = showable.slice(1, 4); // up to 3 alternatives
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[10px]">
      <span className="text-[#3a4033] uppercase tracking-widest text-[8px] font-bold">
        Best price
      </span>
      <span className="font-bold text-[#3ee68a]">
        <BookName book={top.book} />{" "}
        <span className="font-mono">{formatAmerican(top.odds)}</span>
      </span>
      {others.length > 0 && (
        <>
          <span className="text-[#3a4033]">·</span>
          <span className="text-[#6b7068]">
            also{" "}
            {others.map((o, i) => (
              <span key={o.book}>
                <BookName book={o.book} />{" "}
                <span className="font-mono text-[#9ca39a]">{formatAmerican(o.odds)}</span>
                {i < others.length - 1 ? <span className="text-[#3a4033]">, </span> : null}
              </span>
            ))}
          </span>
        </>
      )}
    </div>
  );
}

function PickCard({ pick }: { pick: SoccerPick }) {
  const [expanded, setExpanded] = useState(false);
  const [explain, setExplain] = useState<Explanation | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const league = leagueTagFromTournament(pick.tournament);
  const tColor = tierColor(pick.confidence_tier);

  const onToggle = useCallback(async () => {
    if (!expanded && !explain && !loading) {
      setLoading(true);
      setErr(null);
      try {
        const r = await fetch(`/api/picks/explain?signal_id=${pick.signal_id}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as Explanation;
        setExplain(data);
      } catch (e: unknown) {
        setErr(e instanceof Error ? e.message : "load failed");
      } finally {
        setLoading(false);
      }
    }
    setExpanded((s) => !s);
  }, [expanded, explain, loading, pick.signal_id]);

  return (
    <div className="rounded-xl border border-[#22251f] bg-[#0d0f0d] overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full text-left px-4 py-3 hover:bg-[#101310] transition-colors"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {/* Top row: league tag + tier + date */}
            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
              <span
                className="text-[8px] font-bold uppercase tracking-[0.14em] border rounded px-1.5 py-[1px]"
                style={{ color: league.color, borderColor: `${league.color}35` }}
              >
                {league.label}
              </span>
              {pick.confidence_tier && (
                <span
                  className="text-[8px] font-bold uppercase tracking-[0.12em] rounded px-1.5 py-[1px]"
                  style={{ color: tColor, background: `${tColor}1a` }}
                >
                  Tier {pick.confidence_tier}
                </span>
              )}
              <span className="text-[9px] text-[#4a524a] font-mono">{pick.game_date}</span>
            </div>

            {/* Matchup */}
            <p className="text-[12px] text-[#c4c7c0] truncate">
              {pick.away_team} <span className="text-[#3a4033]">@</span> {pick.home_team}
            </p>

            {/* Bet line */}
            <p className="text-[13px] font-bold text-white mt-1">{describeBet(pick)}</p>

            {/* Best price across books — what subscribers actually need
                to know: where to bet, and the alternatives. */}
            <div className="mt-1.5">
              <BestPriceStrip pick={pick} />
            </div>

            {/* Edge chip — the model's read */}
            {pick.edge_pp != null && (
              <div className="mt-1 text-[10px]">
                <span className="font-mono font-bold" style={{ color: tColor }}>
                  {formatEdge(pick.edge_pp)} model edge
                </span>
                {pick.pinnacle_prob != null && (
                  <span className="text-[#4a524a] ml-2">
                    pin {(pick.pinnacle_prob * 100).toFixed(1)}%
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="shrink-0 flex items-center gap-1 text-[#6b7068] hover:text-[#3ee68a] transition-colors">
            <Sparkles className="h-3 w-3" />
            <span className="text-[9px] uppercase tracking-widest font-bold">Why</span>
            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </div>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-[#181c18] bg-[#080a08] px-4 py-3 space-y-2.5">
          {loading && (
            <div className="flex items-center gap-2 text-[#6b7068]">
              <RefreshCw className="h-3 w-3 animate-spin" />
              <span className="text-[11px]">Loading explanation…</span>
            </div>
          )}
          {err && !loading && (
            <p className="text-[11px] text-[#ef4444]">Couldn&apos;t load explanation ({err})</p>
          )}
          {explain && !loading && !err && (
            <>
              <p className="text-[11px] font-bold text-[#3ee68a] leading-snug">
                {explain.headline}
              </p>
              <p className="text-[11px] text-[#c4c7c0] leading-relaxed">
                {explain.why}
              </p>
              {explain.caveat && (
                <p className="text-[10px] text-[#9ca39a] italic leading-snug border-l-2 border-[#22251f] pl-2.5">
                  {explain.caveat}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function RecordStrip({ record }: { record: SoccerPicksPayload["record"] }) {
  const { graded, wins, losses, win_rate, roi, avg_clv } = record;
  if (graded === 0) {
    return (
      <p className="text-[10px] text-[#6b7068]">
        No graded soccer picks yet — first results land as weekend matches settle.
      </p>
    );
  }
  return (
    <div className="flex items-center gap-4 flex-wrap text-[10px] text-[#9ca39a]">
      <span>
        <span className="text-[#6b7068] uppercase tracking-widest text-[8px] font-bold mr-1.5">Record</span>
        <span className="font-mono text-white">{wins}–{losses}</span>
      </span>
      {win_rate != null && (
        <span>
          <span className="text-[#6b7068] uppercase tracking-widest text-[8px] font-bold mr-1.5">Win%</span>
          <span className="font-mono text-white">{(win_rate * 100).toFixed(1)}%</span>
        </span>
      )}
      {roi != null && (
        <span>
          <span className="text-[#6b7068] uppercase tracking-widest text-[8px] font-bold mr-1.5">ROI</span>
          <span
            className="font-mono font-bold"
            style={{ color: roi >= 0 ? "#3ee68a" : "#ef4444" }}
          >
            {roi >= 0 ? "+" : ""}{(roi * 100).toFixed(1)}%
          </span>
        </span>
      )}
      {avg_clv != null && (
        <span>
          <span className="text-[#6b7068] uppercase tracking-widest text-[8px] font-bold mr-1.5">Avg CLV</span>
          <span className="font-mono text-white">{(avg_clv * 100).toFixed(2)}pp</span>
        </span>
      )}
      <span className="text-[#4a524a]">· n={graded}</span>
    </div>
  );
}

export default function SoccerPicksPanel() {
  const [data, setData] = useState<SoccerPicksPayload | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/picks/soccer");
        if (r.ok) {
          const d = (await r.json()) as SoccerPicksPayload;
          if (!cancelled) setData(d);
        }
      } catch {
        /* swallow — empty state renders */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Hide the panel entirely if there's nothing to show. The WCBanner above
  // already handles the "soccer is coming" narrative for empty-state.
  if (!loading && data && data.open.length === 0 && data.record.graded === 0) {
    return null;
  }

  return (
    <section className="border-b border-[#1b201a] bg-[#0a0c0a] px-5 py-4">
      <div className="mx-auto max-w-[1200px]">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <span className="text-[16px] leading-none">⚽</span>
            <span className="text-[11px] font-bold text-[#3ee68a] uppercase tracking-[0.18em]">
              Soccer picks
            </span>
            {data && (
              <span className="text-[9px] text-[#4a524a] font-mono ml-1">
                {data.open.length} open
              </span>
            )}
          </div>
          {data && <RecordStrip record={data.record} />}
        </div>

        {loading && (
          <div className="flex items-center gap-2 text-[#6b7068] py-3">
            <RefreshCw className="h-3 w-3 animate-spin" />
            <span className="text-[11px]">Loading soccer picks…</span>
          </div>
        )}

        {data && data.open.length > 0 && (
          <div className={cn(
            "grid gap-2.5",
            "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
          )}>
            {data.open.map((p) => (
              <PickCard key={p.signal_id} pick={p} />
            ))}
          </div>
        )}

        {data && data.open.length === 0 && data.record.graded > 0 && (
          <p className="text-[11px] text-[#6b7068] py-3">
            No open picks right now — full graded record above.
          </p>
        )}
      </div>
    </section>
  );
}
