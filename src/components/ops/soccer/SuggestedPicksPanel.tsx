"use client";

/**
 * SuggestedPicksPanel — model-surfaced picks with one-click approval.
 *
 * Why this exists
 * ---------------
 * The previous flow required the operator to open dev tools and paste
 * a JS block to publish picks. That works for a one-off, not for a
 * product. It also breaks silently if the admin session expires (the
 * paste returns 401 with no UI feedback).
 *
 * This panel surfaces what the model has selected for the current
 * slate. Each card shows the bet, the price, the model probability,
 * the edge, the thesis, the cap-adjusted suggested stake, and an
 * Approve button. The button POSTs to /api/ops/approved-picks with
 * the admin session cookie already attached (we're inside the dashboard
 * UI), so there's no auth ambiguity.
 *
 * Source: TODAYS_PICKS — currently empty. Soccer picks are paused until a
 * market clears the V2 backtest bar (only Over 2.5 is proven). The old
 * hardcoded UCL-final seed was removed so nothing stale can surface; when
 * the WC model wires in it populates TODAYS_PICKS from live model output.
 *
 * Approved picks are filtered out so the panel doesn't keep showing
 * already-published recommendations.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, AlertCircle, Loader2, ChevronRight } from "lucide-react";

interface SuggestedPick {
  game_id: string;
  market: string;
  side: string;
  bet_label: string;
  model_prob: number;
  best_price: number;
  best_book: string;
  fixture_label: string;
  tournament: string;
  commence_time: string;
  lineup_status: string;
  notes: string;
  rationale: Record<string, unknown> & { primary_thesis: string };
  // Display-only fields
  expected_stake: number;          // what M40.6 will cap it to
  expected_stake_reason: string;   // shown alongside
}

interface ApprovedPickRow {
  id: number;
  bet_label: string;
  game_id: string;
  market: string;
  side: string;
}

// ── Live model fetch (no hardcoded seed) ───────────────────────────────
// Soccer picks are PAUSED until a market clears the V2 backtest bar (only
// Over 2.5 is proven). There is no hardcoded demo seed here: the old UCL
// final seed was removed so nothing stale can ever surface. When the WC
// model wires in, populate TODAYS_PICKS from the live model output.
const TODAYS_PICKS: SuggestedPick[] = [];

function fmtAmerican(p: number): string {
  return p > 0 ? `+${p}` : `${p}`;
}
function impliedProb(american: number): number {
  return american > 0 ? 100 / (american + 100) : -american / (-american + 100);
}

type Status =
  | { kind: "idle" }
  | { kind: "publishing" }
  | { kind: "published"; id: number; stake: number }
  | { kind: "failed"; reason: string };

export default function SuggestedPicksPanel() {
  // Track per-pick status keyed by game_id+market+side (the natural key of
  // soccer_approved_picks)
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const [alreadyApproved, setAlreadyApproved] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [bulkPublishing, setBulkPublishing] = useState(false);

  // Fetch existing approved picks so we can hide ones that are already
  // in soccer_approved_picks.
  const refreshApproved = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/picks/history?limit=50", {
        cache: "no-store",
      });
      const data: { picks?: ApprovedPickRow[] } = await res.json();
      const seen = new Set<string>();
      (data.picks ?? []).forEach((p) => {
        seen.add(`${p.game_id}|${p.market}|${p.side}`);
      });
      setAlreadyApproved(seen);
    } catch {
      // Silent — empty set means we re-offer everything
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshApproved();
  }, [refreshApproved]);

  const pickKey = (p: SuggestedPick) =>
    `${p.game_id}|${p.market}|${p.side}`;

  // Only suggest picks for fixtures that haven't kicked off yet. The seed
  // is currently the UCL final (now in the past), so once that's behind us
  // this panel correctly shows nothing rather than pinning to a dead event.
  // (P1.3 — no stale suggestions. The dynamic WC-fixture source lands with
  // the WC model work; until then future-dated seeds are the only ones shown.)
  const visiblePicks = useMemo(
    () => TODAYS_PICKS.filter((p) => {
      if (alreadyApproved.has(pickKey(p))) return false;
      const ko = new Date(p.commence_time).getTime();
      return Number.isFinite(ko) && ko > Date.now();
    }),
    [alreadyApproved],
  );

  const publishOne = useCallback(async (pick: SuggestedPick) => {
    const key = pickKey(pick);
    setStatuses((prev) => ({ ...prev, [key]: { kind: "publishing" } }));
    try {
      const res = await fetch("/api/ops/approved-picks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pick),
      });
      const out = await res.json();
      if (out.ok && out.pick) {
        setStatuses((prev) => ({
          ...prev,
          [key]: {
            kind: "published",
            id: out.pick.id,
            stake: out.pick.stake_units,
          },
        }));
        await refreshApproved();
      } else {
        setStatuses((prev) => ({
          ...prev,
          [key]: {
            kind: "failed",
            reason:
              out.error ||
              (res.status === 401
                ? "not logged in as admin — refresh + re-login"
                : `${res.status} ${res.statusText}`),
          },
        }));
      }
    } catch (e) {
      setStatuses((prev) => ({
        ...prev,
        [key]: { kind: "failed", reason: String(e).slice(0, 200) },
      }));
    }
  }, [refreshApproved]);

  const publishAll = useCallback(async () => {
    setBulkPublishing(true);
    for (const pick of visiblePicks) {
      await publishOne(pick);
    }
    setBulkPublishing(false);
  }, [visiblePicks, publishOne]);

  if (loading) {
    return (
      <section className="mb-4 rounded-2xl bg-[#0d0f0d] border border-[#181c18] p-5">
        <div className="h-3 w-40 rounded bg-[#1a1e1a] animate-pulse mb-3" />
        <div className="h-16 rounded bg-[#1a1e1a] animate-pulse" />
      </section>
    );
  }

  // No upcoming fixtures to suggest picks for — honest empty state.
  // (During the pre-WC dead zone there are no live games; this is the
  // intended state, not an error. The dynamic WC-fixture source lands
  // with the WC model work.)
  if (visiblePicks.length === 0) {
    return (
      <section className="mb-4 rounded-2xl bg-[#0d0f0d] border border-[#181c18] px-5 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-3.5 w-3.5 text-[#6b7068]" strokeWidth={1.5} />
          <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#9ca39a]">
            No upcoming picks to suggest right now
          </span>
        </div>
        <span className="text-[10px] text-[#6b7068]">
          World Cup kicks off June 11
        </span>
      </section>
    );
  }

  return (
    <section className="mb-4 rounded-2xl bg-[#0d0f0d] border border-[#181c18] overflow-hidden">
      {/* Header */}
      <header className="px-5 md:px-7 pt-5 pb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ChevronRight className="h-3.5 w-3.5 text-[#3ee68a]" strokeWidth={1.5} />
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#e6e9e4]">
            Suggested picks · {visiblePicks.length}
          </h3>
          <span className="text-[10px] text-[#6b7068]">
            from today&apos;s model run
          </span>
        </div>
        <button
          onClick={publishAll}
          disabled={bulkPublishing}
          className="
            text-[10px] font-bold uppercase tracking-[0.18em]
            bg-[#3ee68a] text-[#0a0d0a] hover:bg-[#52f099] active:translate-y-[1px]
            disabled:opacity-50 disabled:cursor-not-allowed
            px-4 py-2 rounded-md transition
          "
        >
          {bulkPublishing ? (
            <span className="flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
              Publishing
            </span>
          ) : (
            `Publish all ${visiblePicks.length}`
          )}
        </button>
      </header>

      {/* Cards */}
      <div className="px-3 md:px-4 pb-4 space-y-2">
        {visiblePicks.map((pick) => {
          const key = pickKey(pick);
          const status = statuses[key] || { kind: "idle" as const };
          const implied = impliedProb(pick.best_price);
          const edge = (pick.model_prob - implied) * 100;
          const thesis = pick.rationale.primary_thesis || "";
          return (
            <div
              key={key}
              className="
                rounded-xl border border-[#181c18] bg-[#0a0d0a]
                px-4 py-3.5
                grid grid-cols-[1fr_auto] gap-3 items-center
                shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]
              "
            >
              {/* Left — pick body */}
              <div className="min-w-0">
                <div className="flex items-baseline gap-2 mb-1">
                  <h4 className="text-[13px] font-bold text-[#e6e9e4] truncate">
                    {pick.bet_label}
                  </h4>
                  <span className="font-mono text-[11px] font-bold text-[#3ee68a]">
                    {fmtAmerican(pick.best_price)}
                  </span>
                  <span className="text-[10px] text-[#6b7068] uppercase tracking-wider">
                    {pick.best_book}
                  </span>
                </div>
                <p className="text-[11px] leading-snug text-[#9ca39a] line-clamp-2 mb-1.5">
                  {thesis}
                </p>
                <div className="flex items-center gap-3 text-[10px] text-[#6b7068]">
                  <span>
                    Model{" "}
                    <span className="font-mono text-[#e6e9e4]">
                      {(pick.model_prob * 100).toFixed(0)}%
                    </span>
                  </span>
                  <span>
                    Market{" "}
                    <span className="font-mono text-[#9ca39a]">
                      {(implied * 100).toFixed(0)}%
                    </span>
                  </span>
                  <span>
                    Edge{" "}
                    <span
                      className={`font-mono font-bold ${
                        edge >= 0 ? "text-[#3ee68a]" : "text-[#ef4444]"
                      }`}
                    >
                      {edge >= 0 ? "+" : ""}
                      {edge.toFixed(1)}pp
                    </span>
                  </span>
                  <span>
                    Suggested stake{" "}
                    <span className="font-mono text-[#e6e9e4]">
                      {pick.expected_stake}u
                    </span>
                  </span>
                </div>
              </div>

              {/* Right — action / status */}
              <div className="flex items-center gap-2">
                {status.kind === "idle" && (
                  <button
                    onClick={() => publishOne(pick)}
                    className="
                      text-[10px] font-bold uppercase tracking-[0.16em]
                      border border-[#3ee68a]/30 text-[#3ee68a] hover:bg-[#3ee68a]/[0.08]
                      px-3 py-1.5 rounded transition active:translate-y-[1px]
                    "
                  >
                    Approve
                  </button>
                )}
                {status.kind === "publishing" && (
                  <span className="text-[10px] text-[#9ca39a] flex items-center gap-1.5">
                    <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
                    Publishing
                  </span>
                )}
                {status.kind === "published" && (
                  <span className="text-[10px] text-[#3ee68a] flex items-center gap-1.5 font-mono">
                    <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                    Published · {status.stake}u
                  </span>
                )}
                {status.kind === "failed" && (
                  <div className="text-right max-w-[220px]">
                    <span className="text-[10px] text-[#ef4444] flex items-center justify-end gap-1.5">
                      <AlertCircle className="h-3.5 w-3.5" strokeWidth={1.5} />
                      Failed
                    </span>
                    <p className="text-[9px] text-[#9ca39a] mt-0.5 truncate">
                      {status.reason}
                    </p>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
