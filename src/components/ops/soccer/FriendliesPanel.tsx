"use client";

/**
 * FriendliesPanel — international-friendly dress-rehearsal candidates (F2).
 *
 * Surfaces this week's WC-team warmup friendlies (Sportmonks-sourced, since
 * the US Odds API doesn't carry them) in the ops Soccer tab, with one-click
 * approve into the same lifecycle as every other pick.
 *
 * HONESTY: these are EXPERIMENTAL / dress-rehearsal candidates — built from
 * Sportmonks' model vs the de-vigged consensus, NOT ACE's validated model
 * (which doesn't cover national teams). The panel labels them loudly so
 * they're never mistaken for proven ACE picks. This is for exercising the
 * live pipeline before the World Cup.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, AlertCircle, Loader2, FlaskConical, RefreshCw } from "lucide-react";

interface FriendlyCandidate {
  fixture_id: number;
  fixture_label: string;
  commence_time: string | null;
  market: string;
  side: string;
  bet_label: string;
  model_prob: number;
  consensus_prob: number;
  best_american: number;
  best_book: string;
  n_books: number;
  edge_pp: number;
}

type Status =
  | { kind: "idle" }
  | { kind: "publishing" }
  | { kind: "published"; stake: number }
  | { kind: "failed"; reason: string };

function fmtAmerican(p: number): string {
  return p > 0 ? `+${p}` : `${p}`;
}
function fmtKickoff(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso.replace(" ", "T") + (iso.includes("Z") ? "" : "Z")).toLocaleString(
      undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
    );
  } catch { return iso.slice(0, 16); }
}

export default function FriendliesPanel() {
  const [candidates, setCandidates] = useState<FriendlyCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, Status>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/ops/soccer/friendlies?days=5", { cache: "no-store" });
      const data = await res.json();
      if (data.ok) {
        setCandidates(data.candidates ?? []);
      } else {
        setErr(data.error || "failed to load friendlies");
      }
    } catch (e) {
      setErr(String(e).slice(0, 160));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const key = (c: FriendlyCandidate) => `${c.fixture_id}|${c.market}|${c.side}`;

  const approve = useCallback(async (c: FriendlyCandidate) => {
    const k = key(c);
    setStatuses((p) => ({ ...p, [k]: { kind: "publishing" } }));
    try {
      const res = await fetch("/api/ops/approved-picks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          game_id: `friendly_${c.fixture_id}_${c.market}_${c.side}`,
          market: c.market,
          side: c.side,
          bet_label: c.bet_label,
          model_prob: c.model_prob,
          best_price: c.best_american,
          best_book: c.best_book,
          fixture_label: c.fixture_label,
          tournament: "International Friendly",
          commence_time: c.commence_time,
          lineup_status: "projected",
          notes: "Dress rehearsal — EXPERIMENTAL, Sportmonks model, friendly (low-signal).",
          rationale: {
            leakage_note: "Friendly: Sportmonks model vs de-vigged consensus. NOT an ACE-validated pick — national teams are uncovered by our model.",
            model: "sportmonks",
            tier: "experimental",
            consensus_prob: c.consensus_prob,
            edge_pp: c.edge_pp,
            n_books: c.n_books,
            backtest_support: "NONE — friendly, no validated model coverage",
          },
        }),
      });
      const out = await res.json();
      if (out.ok && out.pick) {
        setStatuses((p) => ({ ...p, [k]: { kind: "published", stake: out.pick.stake_units } }));
      } else {
        setStatuses((p) => ({
          ...p,
          [k]: { kind: "failed", reason: out.error || (res.status === 401 ? "not admin — re-login" : `${res.status}`) },
        }));
      }
    } catch (e) {
      setStatuses((p) => ({ ...p, [k]: { kind: "failed", reason: String(e).slice(0, 120) } }));
    }
  }, []);

  const top = useMemo(() => candidates.slice(0, 25), [candidates]);

  return (
    <section className="mb-4 rounded-2xl bg-[#0d0f0d] border border-[#181c18] overflow-hidden">
      <header className="px-5 md:px-7 pt-5 pb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <FlaskConical className="h-3.5 w-3.5 text-[#f5c062]" strokeWidth={1.5} />
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#e6e9e4]">
            Friendlies · dress rehearsal
          </h3>
          <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-[#f5c062]/12 text-[#f5c062] border border-[#f5c062]/20">
            Experimental
          </span>
        </div>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="text-[10px] text-[#6b7068] hover:text-[#9ca39a] flex items-center gap-1 disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} strokeWidth={1.5} />
          refresh
        </button>
      </header>

      <p className="px-5 md:px-7 -mt-1 pb-3 text-[11px] leading-relaxed text-[#6b7068]">
        WC-team warmups (Sportmonks). Sportmonks model vs market consensus —{" "}
        <span className="text-[#9ca39a]">not ACE-validated picks</span>. Friendlies are
        low-signal; this is to exercise the live pipeline before the World Cup.
      </p>

      <div className="px-3 md:px-4 pb-4">
        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-12 rounded-xl bg-[#0a0d0a] animate-pulse" />
            ))}
          </div>
        ) : err ? (
          <div className="rounded-xl border border-[#ef4444]/25 bg-[#ef4444]/[0.05] px-4 py-3 text-[11px] text-[#ef8b8b] flex items-center gap-2">
            <AlertCircle className="h-3.5 w-3.5" strokeWidth={1.5} /> {err}
          </div>
        ) : top.length === 0 ? (
          <div className="px-4 py-6 text-center text-[11px] text-[#6b7068]">
            No friendly edges this window.
          </div>
        ) : (
          <div className="space-y-2">
            {top.map((c) => {
              const k = key(c);
              const st = statuses[k] || { kind: "idle" as const };
              return (
                <div
                  key={k}
                  className="rounded-xl border border-[#181c18] bg-[#0a0d0a] px-4 py-3 grid grid-cols-[1fr_auto] gap-3 items-center"
                >
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-2 mb-0.5">
                      <h4 className="text-[12px] font-bold text-[#e6e9e4] truncate">{c.bet_label}</h4>
                      <span className="font-mono text-[11px] font-bold text-[#3ee68a]">{fmtAmerican(c.best_american)}</span>
                      <span className="text-[9px] text-[#6b7068] uppercase tracking-wider truncate">{c.best_book}</span>
                    </div>
                    <div className="text-[10px] text-[#6b7068] truncate">
                      {c.fixture_label.replace(" · Int'l Friendly", "")} · {fmtKickoff(c.commence_time)}
                    </div>
                    <div className="flex items-center gap-3 text-[10px] text-[#6b7068] mt-1">
                      <span>SM <span className="font-mono text-[#e6e9e4]">{(c.model_prob * 100).toFixed(0)}%</span></span>
                      <span>Cons <span className="font-mono text-[#9ca39a]">{(c.consensus_prob * 100).toFixed(0)}%</span></span>
                      <span>Edge <span className="font-mono font-bold text-[#f5c062]">+{c.edge_pp.toFixed(1)}pp</span></span>
                      <span className="text-[#4a524a]">{c.n_books} books</span>
                    </div>
                  </div>
                  <div className="flex items-center">
                    {st.kind === "idle" && (
                      <button
                        onClick={() => void approve(c)}
                        className="text-[10px] font-bold uppercase tracking-[0.16em] border border-[#f5c062]/30 text-[#f5c062] hover:bg-[#f5c062]/[0.08] px-3 py-1.5 rounded transition active:translate-y-[1px]"
                      >
                        Approve
                      </button>
                    )}
                    {st.kind === "publishing" && (
                      <span className="text-[10px] text-[#9ca39a] flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />…</span>
                    )}
                    {st.kind === "published" && (
                      <span className="text-[10px] text-[#3ee68a] flex items-center gap-1.5 font-mono"><CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.5} />{st.stake}u</span>
                    )}
                    {st.kind === "failed" && (
                      <span className="text-[10px] text-[#ef4444] flex items-center gap-1.5" title={st.reason}><AlertCircle className="h-3.5 w-3.5" strokeWidth={1.5} />failed</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
