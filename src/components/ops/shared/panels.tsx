"use client";

/**
 * Shared ops panels — derived views over the canonical OpsSignal shape.
 *
 * MLB and Soccer (and eventually any per-sport tab) emit the same shape
 * of signal data. The panels here compute derived views (today's slate,
 * actionable vs awaiting, CLV stats, by-book breakdown, stale signals)
 * client-side so we don't burden the API routes with N more derivations.
 *
 * Adding a new per-sport tab means: pass your signals[] into <PanelX/>.
 * Adding a new panel means: write one function here and import it
 * everywhere — no per-tab duplication.
 */
import { Clock, Activity, BookMarked, AlertTriangle, Target, BarChart2 } from "lucide-react";
import { Panel, SectionHead, KpiCard, StatusPill, EmptyState, Tag } from "./primitives";

// Common subset between MLBSignal and SoccerSignal. Fields that some sport
// tabs don't bother typing locally (commence_time, kelly_fraction, etc.)
// are marked optional so per-sport interfaces can satisfy this without
// having to mirror every column. The panels only read what's reliably
// present and handle nulls/undefined cleanly.
export interface OpsSignal {
  id: number;
  game_id?: string;
  game_date: string;                  // 'YYYY-MM-DD'
  commence_time?: string | null;       // ISO; not all sport types carry it
  home_team: string;
  away_team: string;
  market: string;                      // 'h2h' | 'run_line' | 'totals' | 'asian_handicap'
  bet_side: string;                    // 'home'|'away'|'over'|'under'
  line?: number | null;                // MLB run-line / totals
  total_line?: number | null;          // Soccer totals
  book: string;
  book_odds: number | null;
  edge_pp: number | null;
  status: string;                      // 'open' | 'graded' | 'void'
  correct: number | null;
  detected_at?: string;
  confidence_tier?: "A" | "B" | "C" | null;
  kelly_fraction?: number | null;
  closing_pinnacle_prob?: number | null;
  clv_pp?: number | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtPct(v: number | null) {
  return v !== null && !Number.isNaN(v) ? `${(v * 100).toFixed(1)}%` : "—";
}
function fmtPp(v: number | null) {
  if (v === null || Number.isNaN(v)) return "—";
  const s = (v * 100).toFixed(1);
  return v > 0 ? `+${s}pp` : `${s}pp`;
}
function fmtUnits(v: number | null) {
  if (v === null || Number.isNaN(v)) return "—";
  const s = v.toFixed(2);
  return v > 0 ? `+${s}u` : `${s}u`;
}
function fmtOdds(v: number | null) {
  if (v === null) return "—";
  return v >= 0 ? `+${v}` : `${v}`;
}
function signalLine(s: OpsSignal): number | null {
  return s.line ?? s.total_line ?? null;
}
function betLabel(s: OpsSignal): string {
  const line = signalLine(s);
  if (s.market === "totals") return `${s.bet_side.toUpperCase()}${line != null ? ` ${line}` : ""}`;
  if (s.market === "run_line" || s.market === "asian_handicap") {
    const sign = line != null ? (line >= 0 ? `+${line}` : `${line}`) : "";
    return `${s.bet_side === "home" ? "Home" : "Away"} ${sign}`.trim();
  }
  return s.bet_side === "home" ? "Home" : "Away";
}
function marketLabel(m: string): string {
  if (m === "h2h") return "1X2/ML";
  if (m === "run_line") return "RL";
  if (m === "asian_handicap") return "AH";
  if (m === "totals") return "TOT";
  return m;
}

// ─── Today's slate ────────────────────────────────────────────────────────────
// Distinct games we have at least one open signal on today.

interface SlateGame {
  game_id: string;
  matchup: string;
  signalCount: number;
  topEdge: number | null;  // largest edge_pp on this game
}

export function TodaySlatePanel({
  signals,
  today,
}: { signals: OpsSignal[]; today: string }) {
  const todayOpen = signals.filter((s) => s.status === "open" && s.game_date === today);
  const byGame = new Map<string, SlateGame>();
  for (const s of todayOpen) {
    // Fall back to a matchup-derived key when the schema doesn't expose game_id
    const key = s.game_id ?? `${s.game_date}|${s.home_team}|${s.away_team}`;
    const g = byGame.get(key) ?? {
      game_id: key,
      matchup: `${s.away_team} @ ${s.home_team}`,
      signalCount: 0,
      topEdge: null,
    };
    g.signalCount += 1;
    if (s.edge_pp != null && (g.topEdge == null || s.edge_pp > g.topEdge)) {
      g.topEdge = s.edge_pp;
    }
    byGame.set(key, g);
  }
  const games = Array.from(byGame.values()).sort(
    (a, b) => (b.topEdge ?? 0) - (a.topEdge ?? 0),
  );

  return (
    <Panel>
      <SectionHead
        icon={Clock}
        title={`Today's slate · ${today}`}
        right={<span className="text-[10px] text-[#6b7068]">{games.length} game{games.length !== 1 ? "s" : ""}</span>}
      />
      {games.length === 0 ? (
        <EmptyState>No open signals on games today. Worker will populate this as divergences fire.</EmptyState>
      ) : (
        <div className="flex flex-wrap gap-2">
          {games.map((g) => (
            <div
              key={g.game_id}
              className="rounded-lg border border-[#1a1e1a] bg-[#0a0b0a] px-3 py-2 flex items-center gap-3"
            >
              <span className="text-[12px] text-[#c4c7c0] font-mono">{g.matchup}</span>
              <span className="text-[9px] text-[#6b7068] uppercase tracking-[0.12em]">
                {g.signalCount} sig
              </span>
              {g.topEdge != null && (
                <span className="text-[10px] font-mono font-bold text-[#3ee68a]">
                  {fmtPp(g.topEdge)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

// ─── Open signals split: actionable today vs awaiting grade ──────────────────

export function OpenSignalsPanel({
  signals,
  today,
}: { signals: OpsSignal[]; today: string }) {
  const open       = signals.filter((s) => s.status === "open");
  const actionable = open.filter((s) => s.game_date >= today)
                         .sort((a, b) => (b.edge_pp ?? 0) - (a.edge_pp ?? 0));
  const awaiting   = open.filter((s) => s.game_date < today)
                         .sort((a, b) => (a.game_date.localeCompare(b.game_date)));

  return (
    <Panel>
      <SectionHead
        icon={Target}
        title="Open signals"
        right={
          <span className="text-[10px] text-[#6b7068]">
            {actionable.length} actionable · {awaiting.length} awaiting grade
          </span>
        }
      />
      {open.length === 0 ? (
        <EmptyState>No open signals. New ones land here as the worker detects divergences.</EmptyState>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <OpenSignalsTable
            title="Actionable (today / future)"
            rows={actionable}
            emptyText="Nothing actionable yet — open signals will appear here when games are still future."
          />
          <OpenSignalsTable
            title="Awaiting grade (past games)"
            rows={awaiting}
            emptyText="No signals awaiting grade. Once games finish, grading flips them here briefly then to graded."
          />
        </div>
      )}
    </Panel>
  );
}

function OpenSignalsTable({
  title,
  rows,
  emptyText,
}: { title: string; rows: OpsSignal[]; emptyText: string }) {
  return (
    <div className="rounded-lg border border-[#1a1e1a] bg-[#0a0b0a] p-3">
      <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-[#6b7068] mb-2.5">
        {title} · {rows.length}
      </p>
      {rows.length === 0 ? (
        <p className="text-[10px] text-[#4a524a] py-3 text-center">{emptyText}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[10px] font-mono">
            <thead className="text-[#6b7068] uppercase tracking-[0.12em] border-b border-[#1e2220]">
              <tr>
                <th className="py-1.5 px-1 font-semibold">Date</th>
                <th className="py-1.5 px-1 font-semibold">Matchup</th>
                <th className="py-1.5 px-1 font-semibold">Pick</th>
                <th className="py-1.5 px-1 font-semibold">Book</th>
                <th className="py-1.5 px-1 font-semibold text-right">Edge</th>
                <th className="py-1.5 px-1 font-semibold text-center">Tier</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#141714]">
              {rows.slice(0, 10).map((s) => (
                <tr key={s.id} className="text-[#c4c7c0]">
                  <td className="py-1.5 px-1 text-[#9ca39a]">{s.game_date.slice(5)}</td>
                  <td className="py-1.5 px-1 truncate max-w-[140px]">{s.away_team} @ {s.home_team}</td>
                  <td className="py-1.5 px-1 text-white">
                    <span className="text-[#6b7068]">{marketLabel(s.market)} </span>
                    {betLabel(s)}
                  </td>
                  <td className="py-1.5 px-1 text-[#9ca39a] truncate max-w-[80px]">{s.book}</td>
                  <td className="py-1.5 px-1 text-right text-[#3ee68a] font-bold">{fmtPp(s.edge_pp)}</td>
                  <td className="py-1.5 px-1 text-center">
                    {s.confidence_tier === "A" && <StatusPill label="A" tone="a" />}
                    {s.confidence_tier === "B" && <StatusPill label="B" tone="b" />}
                    {s.confidence_tier === "C" && <StatusPill label="C" tone="c" />}
                    {!s.confidence_tier && <span className="text-[#3a4033]">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 10 && (
            <p className="text-[9px] text-[#4a524a] text-center mt-1.5">
              +{rows.length - 10} more
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── CLV / Edge Validation ───────────────────────────────────────────────────
// The honest "is our edge real?" panel. Only meaningful once we have graded
// signals with closing-line snapshots. Until then, shows accumulating sample.

export function CLVStatsPanel({ signals }: { signals: OpsSignal[] }) {
  const withClv = signals.filter((s) => s.clv_pp != null);
  const graded  = signals.filter((s) => s.status === "graded");

  const avgClv =
    withClv.length > 0
      ? withClv.reduce((a, s) => a + (s.clv_pp ?? 0), 0) / withClv.length
      : null;

  const pctPositive =
    withClv.length > 0
      ? withClv.filter((s) => (s.clv_pp ?? 0) > 0).length / withClv.length
      : null;

  // Flat-bet -110 units P&L (same convention as the overview's ROI calc).
  const wins   = graded.filter((s) => s.correct === 1).length;
  const losses = graded.filter((s) => s.correct === 0).length;
  const pnlUnits = graded.length > 0 ? wins * (100 / 110) + losses * -1 : null;

  // CLV is the more honest forward-looking metric than W/L — it tells you
  // whether you beat the closing line, which is what predicts long-term ROI.
  const stillAccumulating = withClv.length < 30;

  const tone = avgClv === null ? "—"
    : avgClv >= 0.005 ? "promising"
    : avgClv > 0 ? "marginal"
    : "bad";

  const toneColor = tone === "promising" ? "#3ee68a"
    : tone === "marginal" ? "#f5c062"
    : tone === "bad" ? "#ef4444"
    : "#6b7068";

  return (
    <Panel>
      <SectionHead
        icon={BarChart2}
        title="Edge validation · CLV"
        right={
          stillAccumulating ? (
            <Tag label={`${withClv.length}/30 sample`} color="#6b7068" />
          ) : (
            <Tag label={tone.toUpperCase()} color={toneColor} />
          )
        }
      />
      <div className="flex gap-3 flex-wrap">
        <KpiCard
          label="Avg CLV"
          value={avgClv === null ? "—" : fmtPp(avgClv)}
          color={avgClv === null ? "#6b7068" : avgClv >= 0 ? "#3ee68a" : "#ef4444"}
          sub={withClv.length > 0 ? `across ${withClv.length} graded` : "needs graded signals with closing snapshots"}
        />
        <KpiCard
          label="% Positive CLV"
          value={pctPositive === null ? "—" : fmtPct(pctPositive)}
          color={pctPositive === null ? "#6b7068"
                : pctPositive >= 0.55 ? "#3ee68a"
                : pctPositive >= 0.50 ? "#f5c062" : "#ef4444"}
          sub="% of bets beating the close"
        />
        <KpiCard
          label="P&L (units)"
          value={fmtUnits(pnlUnits)}
          color={pnlUnits === null ? "#6b7068" : pnlUnits >= 0 ? "#3ee68a" : "#ef4444"}
          sub={`${wins}W / ${losses}L flat at -110`}
        />
        <KpiCard
          label="Graded"
          value={String(graded.length)}
          sub={`${withClv.length} with closing snapshot`}
        />
      </div>
    </Panel>
  );
}

// ─── By book — which soft books are diverging from Pinnacle most ─────────────

interface BookRow {
  book: string;
  total: number;
  avgEdge: number | null;
  graded: number;
  wins: number;
  winRate: number | null;
}

export function ByBookPanel({ signals }: { signals: OpsSignal[] }) {
  const map = new Map<string, BookRow>();
  for (const s of signals) {
    if (!s.book) continue;
    const r = map.get(s.book) ?? {
      book: s.book, total: 0, avgEdge: null,
      graded: 0, wins: 0, winRate: null,
    };
    r.total += 1;
    if (s.edge_pp != null) {
      r.avgEdge = ((r.avgEdge ?? 0) * (r.total - 1) + s.edge_pp) / r.total;
    }
    if (s.status === "graded") {
      r.graded += 1;
      if (s.correct === 1) r.wins += 1;
    }
    map.set(s.book, r);
  }
  for (const r of map.values()) {
    r.winRate = r.graded > 0 ? r.wins / r.graded : null;
  }
  const books = Array.from(map.values()).sort((a, b) => b.total - a.total);

  return (
    <Panel>
      <SectionHead
        icon={BookMarked}
        title="By book"
        right={<span className="text-[10px] text-[#6b7068]">soft books diverging from Pinnacle</span>}
      />
      {books.length === 0 ? (
        <EmptyState>No book attribution yet — fills in as signals fire.</EmptyState>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2.5">
          {books.map((r) => (
            <div key={r.book} className="rounded-lg border border-[#1a1e1a] bg-[#0a0b0a] px-3 py-2.5">
              <p className="text-[10px] font-bold text-white truncate mb-1">{r.book}</p>
              <div className="grid grid-cols-3 gap-1.5 text-[9px]">
                <div>
                  <p className="text-[#6b7068] uppercase tracking-[0.12em]">Sigs</p>
                  <p className="text-white font-mono font-bold mt-0.5">{r.total}</p>
                </div>
                <div>
                  <p className="text-[#6b7068] uppercase tracking-[0.12em]">Avg edge</p>
                  <p className="text-[#3ee68a] font-mono font-bold mt-0.5">{r.avgEdge !== null ? `${(r.avgEdge * 100).toFixed(1)}pp` : "—"}</p>
                </div>
                <div>
                  <p className="text-[#6b7068] uppercase tracking-[0.12em]">Win %</p>
                  <p
                    className="font-mono font-bold mt-0.5"
                    style={{
                      color: r.winRate === null ? "#6b7068"
                        : r.winRate >= 0.524 ? "#3ee68a"
                        : r.winRate >= 0.48 ? "#f5c062" : "#ef4444",
                    }}
                  >
                    {r.winRate === null ? "—" : `${(r.winRate * 100).toFixed(0)}%`}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

// ─── Stale signals — open & old, eligible for auto-void ──────────────────────

export function StaleSignalsPanel({
  signals,
  today,
  thresholdHours = 36,
}: { signals: OpsSignal[]; today: string; thresholdHours?: number }) {
  // Open AND game_date >= thresholdHours/24 days behind today. Practically,
  // these are signals whose underlying game has been over long enough that
  // a grade should have happened — surfaces grading failures or missing
  // scores on the worker side.
  const todayMs = new Date(today + "T00:00:00Z").getTime();
  const thresholdMs = thresholdHours * 60 * 60 * 1000;

  const stale = signals.filter((s) => {
    if (s.status !== "open") return false;
    const gMs = new Date(s.game_date + "T00:00:00Z").getTime();
    return todayMs - gMs > thresholdMs;
  });

  return (
    <Panel>
      <SectionHead
        icon={AlertTriangle}
        title={`Stale signals (>${thresholdHours}h)`}
        right={<span className="text-[10px] text-[#6b7068]">{stale.length} eligible for void</span>}
      />
      {stale.length === 0 ? (
        <EmptyState>None — grading is keeping up.</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[10px] font-mono">
            <thead className="text-[#6b7068] uppercase tracking-[0.12em] border-b border-[#1e2220]">
              <tr>
                <th className="py-1.5 px-1 font-semibold">Date</th>
                <th className="py-1.5 px-1 font-semibold">Matchup</th>
                <th className="py-1.5 px-1 font-semibold">Pick</th>
                <th className="py-1.5 px-1 font-semibold">Book</th>
                <th className="py-1.5 px-1 font-semibold text-right">Edge</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#141714]">
              {stale.slice(0, 20).map((s) => (
                <tr key={s.id} className="text-[#c4c7c0]">
                  <td className="py-1.5 px-1 text-[#f5c062]">{s.game_date}</td>
                  <td className="py-1.5 px-1 truncate max-w-[180px]">{s.away_team} @ {s.home_team}</td>
                  <td className="py-1.5 px-1 text-white">
                    <span className="text-[#6b7068]">{marketLabel(s.market)} </span>
                    {betLabel(s)}
                  </td>
                  <td className="py-1.5 px-1 text-[#9ca39a]">{s.book}</td>
                  <td className="py-1.5 px-1 text-right text-[#3ee68a]">{fmtPp(s.edge_pp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

// ─── Activity stream — last N signals across all statuses (compact) ──────────
// Surfaces 'is the worker actually firing?' at a glance.

export function ActivityStreamPanel({ signals }: { signals: OpsSignal[] }) {
  const recent = [...signals]
    .sort((a, b) => (b.detected_at || "").localeCompare(a.detected_at || ""))
    .slice(0, 30);

  return (
    <Panel>
      <SectionHead
        icon={Activity}
        title={`Activity stream · last ${recent.length}`}
        right={<span className="text-[10px] text-[#6b7068]">most recent first</span>}
      />
      {recent.length === 0 ? (
        <EmptyState>No signal activity yet.</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[10px] font-mono">
            <thead className="text-[#6b7068] uppercase tracking-[0.12em] border-b border-[#1e2220]">
              <tr>
                <th className="py-1.5 px-1 font-semibold">When</th>
                <th className="py-1.5 px-1 font-semibold">Date</th>
                <th className="py-1.5 px-1 font-semibold">Matchup</th>
                <th className="py-1.5 px-1 font-semibold">Pick</th>
                <th className="py-1.5 px-1 font-semibold">Book / Odds</th>
                <th className="py-1.5 px-1 font-semibold text-right">Edge</th>
                <th className="py-1.5 px-1 font-semibold text-center">Tier</th>
                <th className="py-1.5 px-1 font-semibold text-right">CLV</th>
                <th className="py-1.5 px-1 font-semibold text-center">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#141714]">
              {recent.map((s) => (
                <tr key={s.id} className="text-[#c4c7c0]">
                  <td className="py-1.5 px-1 text-[#4a524a]">
                    {s.detected_at ? new Date(s.detected_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}
                  </td>
                  <td className="py-1.5 px-1 text-[#9ca39a]">{s.game_date.slice(5)}</td>
                  <td className="py-1.5 px-1 truncate max-w-[160px]">{s.away_team} @ {s.home_team}</td>
                  <td className="py-1.5 px-1 text-white">
                    <span className="text-[#6b7068]">{marketLabel(s.market)} </span>
                    {betLabel(s)}
                  </td>
                  <td className="py-1.5 px-1">
                    <span className="text-[#9ca39a]">{s.book}</span>{" "}
                    <span className="text-white">{fmtOdds(s.book_odds)}</span>
                  </td>
                  <td className="py-1.5 px-1 text-right text-[#3ee68a]">{fmtPp(s.edge_pp)}</td>
                  <td className="py-1.5 px-1 text-center">
                    {s.confidence_tier === "A" && <StatusPill label="A" tone="a" />}
                    {s.confidence_tier === "B" && <StatusPill label="B" tone="b" />}
                    {s.confidence_tier === "C" && <StatusPill label="C" tone="c" />}
                    {!s.confidence_tier && <span className="text-[#3a4033]">—</span>}
                  </td>
                  <td className="py-1.5 px-1 text-right" style={{
                    color: s.clv_pp == null ? "#3a4033"
                      : s.clv_pp > 0 ? "#3ee68a" : "#ef4444",
                  }}>
                    {s.clv_pp != null ? fmtPp(s.clv_pp) : "—"}
                  </td>
                  <td className="py-1.5 px-1 text-center">
                    {s.status === "graded" && s.correct === 1 && <StatusPill label="WIN"  tone="win"  />}
                    {s.status === "graded" && s.correct === 0 && <StatusPill label="LOSS" tone="loss" />}
                    {s.status === "open"  && <StatusPill label="OPEN" tone="open" />}
                    {s.status === "void"  && <StatusPill label="VOID" tone="void" />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
