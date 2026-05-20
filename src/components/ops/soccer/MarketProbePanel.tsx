"use client";

/**
 * MarketProbePanel — what's actually on Odds API for WC right now?
 *
 * Pre-launch: Odds API only has `btts` posted on WC. Player goalscorer
 * markets and corners/cards typically open ~2 weeks before kickoff. This
 * panel lets the operator probe the API on demand to see "did the
 * markets open yet?" without burning credits on every dashboard refresh.
 *
 * Two halves:
 *   1. Latest probe result — last seen state of each market
 *   2. "Probe now" button to refresh, plus a credit-cost estimate so
 *      you can decide before clicking
 *
 * GET /api/ops/wc-market-probe   → reads logged history
 * POST /api/ops/wc-market-probe  → triggers a fresh probe (spends credits)
 */
import { useEffect, useState } from "react";
import { Radar, Zap, AlertCircle } from "lucide-react";
import { Panel, SectionHead, ActionButton, EmptyState, Tag } from "@/components/ops/shared/primitives";

interface MarketAvailability {
  market: string;
  games_with_market: number;
  total_outcomes: number;
  bookmakers_offering: string[];
  sample_event: { home: string; away: string } | null;
}

interface ProbeResponse {
  ok: boolean;
  total_games: number;
  credit_cost: number | null;
  credits_remaining: number | null;
  markets: MarketAvailability[];
  probed_at: string;
  error?: string;
}

interface HistoryRow {
  probed_at: string;
  total_games: number;
  credit_cost: number | null;
  credits_remaining: number | null;
  markets: MarketAvailability[];
}

interface HistoryResponse {
  history: HistoryRow[];
  latest: HistoryRow | null;
  error?: string;
}

// Plain-English labels for the cryptic Odds API market keys
const MARKET_LABELS: Record<string, string> = {
  h2h:                          "1X2 / Moneyline",
  spreads:                      "Asian Handicap",
  totals:                       "Goal Over/Under",
  btts:                         "Both Teams To Score",
  alternate_totals_corners:     "Corners O/U",
  alternate_totals_cards:       "Cards O/U",
  player_goal_scorer_anytime:   "Anytime Goalscorer",
  player_goal_scorer_first:     "First Goalscorer",
  player_shots_on_target:       "Shots On Target",
  player_to_be_carded:          "Player To Be Carded",
};

function labelFor(market: string): string {
  return MARKET_LABELS[market] ?? market;
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 60)    return `${m}m ago`;
  if (m < 1440)  return `${Math.floor(m / 60)}h ago`;
  return `${Math.floor(m / 1440)}d ago`;
}

export default function MarketProbePanel() {
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [latestProbe, setLatestProbe] = useState<ProbeResponse | null>(null);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadHistory();
  }, []);

  async function loadHistory() {
    try {
      const r = await fetch("/api/ops/wc-market-probe", { cache: "no-store" });
      setHistory((await r.json()) as HistoryResponse);
    } catch { /* silent */ }
  }

  async function runProbe() {
    setProbing(true);
    setError(null);
    try {
      const r = await fetch("/api/ops/wc-market-probe", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const json = (await r.json()) as ProbeResponse;
      if (!json.ok) {
        setError(json.error ?? "Probe failed");
      } else {
        setLatestProbe(json);
        await loadHistory();  // refresh history with the new entry
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "network error");
    } finally {
      setProbing(false);
    }
  }

  // Display the freshest data: in-memory probe if we just ran one, else
  // the most recent history row.
  const current = latestProbe ?? history?.latest ?? null;
  const lastProbedAt = current?.probed_at ?? null;

  return (
    <Panel>
      <SectionHead
        icon={Radar}
        title="WC market probe"
        right={
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-[#6b7068] uppercase tracking-[0.12em]">
              last probed · {timeAgo(lastProbedAt)}
            </span>
            <ActionButton
              icon={Zap}
              label={probing ? "Probing…" : "Probe now (~10 credits)"}
              variant="primary"
              busy={probing}
              disabled={probing}
              onClick={() => void runProbe()}
            />
          </div>
        }
      />

      <p className="text-[10px] text-[#6b7068] mb-3 leading-relaxed">
        Manually triggered. Each probe spends ~1 credit per market on Odds API.
        Player props typically open 1-2 weeks before kickoff — keep checking as
        June 11 approaches. Lit markets become bet-detection targets.
      </p>

      {error && (
        <div className="mb-3 rounded-lg border border-[#ef4444]/20 bg-[#ef4444]/[0.05] px-3 py-2 flex items-start gap-2">
          <AlertCircle className="h-3 w-3 text-[#ef4444] mt-0.5" />
          <p className="text-[10px] text-[#ef4444]">{error}</p>
        </div>
      )}

      {!current ? (
        <EmptyState>
          No probe data yet. Click &quot;Probe now&quot; to see which WC markets are currently live.
        </EmptyState>
      ) : (
        <>
          {/* Top stats strip */}
          <div className="flex items-center gap-3 mb-3 flex-wrap text-[10px]">
            <span>
              <span className="text-[#6b7068] uppercase tracking-[0.12em]">Games:</span>{" "}
              <span className="text-white font-mono font-bold">{current.total_games}</span>
            </span>
            <span>
              <span className="text-[#6b7068] uppercase tracking-[0.12em]">Probe cost:</span>{" "}
              <span className="text-[#f5c062] font-mono font-bold">{current.credit_cost ?? "—"} credits</span>
            </span>
            <span>
              <span className="text-[#6b7068] uppercase tracking-[0.12em]">Credits remaining:</span>{" "}
              <span className="text-white font-mono">{current.credits_remaining?.toLocaleString() ?? "—"}</span>
            </span>
          </div>

          {/* Per-market table */}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[10px] font-mono">
              <thead className="text-[#6b7068] uppercase tracking-[0.12em] border-b border-[#1e2220]">
                <tr>
                  <th className="py-1.5 px-1 font-semibold">Market</th>
                  <th className="py-1.5 px-1 font-semibold text-right">Games</th>
                  <th className="py-1.5 px-1 font-semibold text-right">Outcomes</th>
                  <th className="py-1.5 px-1 font-semibold">Books</th>
                  <th className="py-1.5 px-1 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#141714]">
                {current.markets.map((m) => {
                  const live = m.games_with_market > 0;
                  return (
                    <tr key={m.market} className="text-[#c4c7c0]">
                      <td className="py-1.5 px-1 text-white">
                        {labelFor(m.market)}
                        <span className="ml-1.5 text-[8px] text-[#4a524a]">{m.market}</span>
                      </td>
                      <td className="py-1.5 px-1 text-right font-bold"
                          style={{ color: live ? "#3ee68a" : "#3a4033" }}>
                        {m.games_with_market}
                      </td>
                      <td className="py-1.5 px-1 text-right text-[#9ca39a]">
                        {m.total_outcomes || "—"}
                      </td>
                      <td className="py-1.5 px-1 text-[#9ca39a] truncate max-w-[180px]">
                        {m.bookmakers_offering.length > 0
                          ? m.bookmakers_offering.join(", ")
                          : <span className="text-[#3a4033]">—</span>}
                      </td>
                      <td className="py-1.5 px-1">
                        {live
                          ? <Tag label="LIVE" color="#3ee68a" />
                          : <Tag label="Not yet" color="#6b7068" />}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mini history strip — when did each market first appear? */}
          {history && history.history.length > 1 && (
            <div className="mt-3 text-[9px] text-[#4a524a]">
              <span className="uppercase tracking-[0.12em]">
                Probe history · {history.history.length} entries · earliest {timeAgo(history.history[history.history.length - 1]?.probed_at)}
              </span>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
