"use client";

/**
 * ComparisonPanel — the lab's hypothesis tester.
 *
 * Define two slices of the signal universe (slice A and slice B), see
 * their win rate / ROI / CLV / sample size side-by-side, plus a delta
 * column that flags when 95% confidence intervals are non-overlapping
 * (i.e. the difference is statistically meaningful, not just noise).
 *
 * Lets you answer questions like:
 *   - Tier A vs Tier B: is our tiering doing real work?
 *   - FanDuel vs DraftKings: is one book consistently softer?
 *   - Last 30d vs Prior 30d: is performance trending up?
 *   - Low edge (3-4pp) vs High edge (6pp+): is edge predictive at the margin?
 *
 * Reads /api/ops/signals-all and filters client-side.
 */
import { useEffect, useMemo, useState } from "react";
import { GitCompare, ArrowRightLeft } from "lucide-react";
import { Panel, SectionHead, EmptyState, Tag } from "@/components/ops/shared/primitives";

interface SignalDTO {
  id: number;
  sport: "nba" | "mlb" | "soccer";
  game_id: string | null;
  game_date: string;
  commence_time: string | null;
  home_team: string;
  away_team: string;
  market: string;
  bet_side: string;
  line: number | null;
  book: string;
  book_odds: number | null;
  edge_pp: number | null;
  status: string;
  correct: number | null;
  detected_at: string | null;
  confidence_tier: "A" | "B" | "C" | null;
  kelly_fraction: number | null;
  closing_pinnacle_prob: number | null;
  clv_pp: number | null;
}

interface SignalsAllResponse {
  signals: SignalDTO[];
  meta: { days: number; counts: Record<string, number>; today: string; refreshed_at: string };
  error?: string;
}

interface SliceFilter {
  name: string;
  sport:  "all" | "nba" | "mlb" | "soccer";
  status: "all" | "open" | "graded" | "win" | "loss";
  tier:   "all" | "A" | "B" | "C" | "none";
  market: string;
  book:   string;
  range:  "all" | "7d" | "30d" | "60d" | "prior-30d";
  minEdgePp: number;
}

const DEFAULT_A: SliceFilter = {
  name: "Slice A", sport: "all", status: "graded", tier: "A",
  market: "all", book: "all", range: "30d", minEdgePp: 0,
};
const DEFAULT_B: SliceFilter = {
  name: "Slice B", sport: "all", status: "graded", tier: "B",
  market: "all", book: "all", range: "30d", minEdgePp: 0,
};

const PRESETS: { label: string; a: Partial<SliceFilter>; b: Partial<SliceFilter> }[] = [
  { label: "Tier A vs Tier B",
    a: { name: "Tier A", tier: "A", status: "graded" },
    b: { name: "Tier B", tier: "B", status: "graded" } },
  { label: "FanDuel vs DraftKings",
    a: { name: "FanDuel",    book: "fanduel",    status: "graded" },
    b: { name: "DraftKings", book: "draftkings", status: "graded" } },
  { label: "Last 30d vs Prior 30d",
    a: { name: "Last 30d",  range: "30d",       status: "graded" },
    b: { name: "Prior 30d", range: "prior-30d", status: "graded" } },
  { label: "Low edge vs High edge",
    a: { name: "3-4pp", minEdgePp: 0.03, status: "graded" },
    b: { name: "5pp+",  minEdgePp: 0.05, status: "graded" } },
  { label: "NBA vs MLB",
    a: { name: "NBA", sport: "nba", status: "graded" },
    b: { name: "MLB", sport: "mlb", status: "graded" } },
];

export default function ComparisonPanel() {
  const [data, setData] = useState<SignalsAllResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [a, setA] = useState<SliceFilter>(DEFAULT_A);
  const [b, setB] = useState<SliceFilter>(DEFAULT_B);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/ops/signals-all?days=180", { cache: "no-store" });
        const json = await res.json();
        if (alive) setData(json as SignalsAllResponse);
      } catch { /* silent */ }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, []);

  // Derive the set of market/book options from the actual data.
  const { markets, books } = useMemo(() => {
    const m = new Set<string>(), bk = new Set<string>();
    for (const s of data?.signals ?? []) {
      if (s.market) m.add(s.market);
      if (s.book)   bk.add(s.book);
    }
    return {
      markets: ["all", ...Array.from(m).sort()],
      books:   ["all", ...Array.from(bk).sort()],
    };
  }, [data]);

  const sliceA = useMemo(() => applyFilter(data?.signals ?? [], a), [data, a]);
  const sliceB = useMemo(() => applyFilter(data?.signals ?? [], b), [data, b]);

  const statsA = useMemo(() => computeStats(sliceA), [sliceA]);
  const statsB = useMemo(() => computeStats(sliceB), [sliceB]);

  const delta = useMemo(() => computeDelta(statsA, statsB), [statsA, statsB]);

  const applyPreset = (preset: typeof PRESETS[number]) => {
    setA({ ...DEFAULT_A, ...preset.a });
    setB({ ...DEFAULT_B, ...preset.b });
  };

  const swap = () => { const tmp = a; setA(b); setB(tmp); };

  return (
    <Panel>
      <SectionHead
        icon={GitCompare}
        title="Comparison — hypothesis tester"
        right={
          <div className="flex items-center gap-2">
            <button
              onClick={swap}
              className="flex items-center gap-1 text-[9px] uppercase tracking-[0.12em] text-[#9ca39a] hover:text-white border border-[#1e2220] hover:border-[#2e332a] rounded px-2 py-0.5 transition-colors"
              title="Swap A and B"
            >
              <ArrowRightLeft className="h-2.5 w-2.5" />
              Swap
            </button>
            <select
              onChange={(e) => {
                const p = PRESETS.find((x) => x.label === e.target.value);
                if (p) applyPreset(p);
                e.currentTarget.selectedIndex = 0;
              }}
              defaultValue=""
              className="text-[9px] uppercase tracking-[0.12em] rounded border border-[#1e2220] bg-[#0a0b0a] text-[#9ca39a] hover:text-white px-2 py-0.5 outline-none"
            >
              <option value="" disabled>Preset…</option>
              {PRESETS.map((p) => (
                <option key={p.label} value={p.label}>{p.label}</option>
              ))}
            </select>
          </div>
        }
      />

      {loading && (
        <div className="h-[300px] flex items-center justify-center text-[11px] text-[#6b7068]">
          Loading signals…
        </div>
      )}

      {!loading && data && (
        <>
          {/* The two slices side by side */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <SliceColumn filter={a} setFilter={setA} stats={statsA} markets={markets} books={books} accent="#3ee68a" />
            <SliceColumn filter={b} setFilter={setB} stats={statsB} markets={markets} books={books} accent="#7ab8ff" />
          </div>

          {/* Delta row — the headline answer */}
          <DeltaRow delta={delta} statsA={statsA} statsB={statsB} aLabel={a.name} bLabel={b.name} />
        </>
      )}
    </Panel>
  );
}

// ─── Slice column ─────────────────────────────────────────────────────────────

function SliceColumn({
  filter, setFilter, stats, markets, books, accent,
}: {
  filter: SliceFilter;
  setFilter: (f: SliceFilter) => void;
  stats: SliceStats;
  markets: string[];
  books: string[];
  accent: string;
}) {
  const setF = <K extends keyof SliceFilter>(key: K, v: SliceFilter[K]) =>
    setFilter({ ...filter, [key]: v });

  return (
    <div className="rounded-lg border-2 bg-[#0a0b0a] p-3 space-y-2" style={{ borderColor: `${accent}30` }}>
      {/* Name */}
      <input
        value={filter.name}
        onChange={(e) => setF("name", e.target.value)}
        className="w-full bg-transparent text-[12px] font-bold outline-none border-b border-transparent hover:border-[#1e2220] focus:border-[#2e332a] py-1"
        style={{ color: accent }}
      />

      {/* Filter pills */}
      <div className="flex flex-wrap gap-1.5 text-[9px]">
        <Mini label="Sport" v={filter.sport}
          opts={[["all","All"],["nba","NBA"],["mlb","MLB"],["soccer","Soccer"]]}
          onChange={(v) => setF("sport", v as SliceFilter["sport"])} />
        <Mini label="Status" v={filter.status}
          opts={[["all","All"],["open","Open"],["graded","Graded"],["win","W"],["loss","L"]]}
          onChange={(v) => setF("status", v as SliceFilter["status"])} />
        <Mini label="Tier" v={filter.tier}
          opts={[["all","All"],["A","A"],["B","B"],["C","C"],["none","—"]]}
          onChange={(v) => setF("tier", v as SliceFilter["tier"])} />
        <Mini label="Range" v={filter.range}
          opts={[["7d","7d"],["30d","30d"],["60d","60d"],["prior-30d","prior 30d"],["all","All"]]}
          onChange={(v) => setF("range", v as SliceFilter["range"])} />
      </div>

      {/* Dropdowns + slider */}
      <div className="flex flex-wrap items-center gap-2 text-[9px]">
        <DropDown label="Market" value={filter.market} opts={markets}
          format={(m) => m === "all" ? "All" : m}
          onChange={(v) => setF("market", v)} />
        <DropDown label="Book" value={filter.book} opts={books}
          format={(b) => b === "all" ? "All" : b}
          onChange={(v) => setF("book", v)} />
        <div className="flex items-center gap-1">
          <span className="text-[#6b7068] uppercase tracking-[0.12em]">Edge≥</span>
          <input type="range" min={0} max={0.10} step={0.005}
            value={filter.minEdgePp}
            onChange={(e) => setF("minEdgePp", parseFloat(e.target.value))}
            className="w-16 accent-[#3ee68a]" />
          <span className="text-[#9ca39a] font-mono w-10 text-right">
            {filter.minEdgePp === 0 ? "any" : `${(filter.minEdgePp * 100).toFixed(1)}pp`}
          </span>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-4 gap-1.5 pt-1">
        <StatBox label="Signals" value={String(stats.signals)} />
        <StatBox label="Graded"  value={String(stats.graded)}  />
        <StatBox
          label="Win %"
          value={stats.winRate !== null ? `${(stats.winRate * 100).toFixed(1)}%` : "—"}
          color={stats.winRate === null ? "#6b7068"
            : stats.winRate >= 0.524 ? "#3ee68a"
            : stats.winRate >= 0.48 ? "#f5c062" : "#ef4444"}
          sub={stats.graded > 0 ? `${stats.wins}W/${stats.losses}L` : ""}
        />
        <StatBox
          label="ROI"
          value={stats.roi !== null ? `${stats.roi > 0 ? "+" : ""}${(stats.roi * 100).toFixed(1)}%` : "—"}
          color={stats.roi === null ? "#6b7068" : stats.roi >= 0 ? "#3ee68a" : "#ef4444"}
        />
        <StatBox
          label="Avg CLV"
          value={stats.avgClv !== null ? `${stats.avgClv > 0 ? "+" : ""}${(stats.avgClv * 100).toFixed(1)}pp` : "—"}
          color={stats.avgClv === null ? "#6b7068" : stats.avgClv >= 0 ? "#3ee68a" : "#ef4444"}
        />
        <StatBox
          label="95% CI"
          value={stats.ciLow !== null && stats.ciHigh !== null
            ? `${(stats.ciLow * 100).toFixed(0)}-${(stats.ciHigh * 100).toFixed(0)}%`
            : "—"}
          sub="of win %"
          color="#9ca39a"
        />
        <StatBox
          label="+CLV %"
          value={stats.positiveCLV !== null ? `${(stats.positiveCLV * 100).toFixed(0)}%` : "—"}
          sub="bets beat close"
          color={stats.positiveCLV === null ? "#6b7068"
            : stats.positiveCLV >= 0.55 ? "#3ee68a"
            : stats.positiveCLV >= 0.50 ? "#f5c062" : "#ef4444"}
        />
        <StatBox
          label="Sample"
          value={stats.graded < 30 ? "thin" : "OK"}
          color={stats.graded < 30 ? "#f5c062" : "#3ee68a"}
          sub={stats.graded < 30 ? "n<30, low conf" : ""}
        />
      </div>
    </div>
  );
}

// ─── Delta row ────────────────────────────────────────────────────────────────

function DeltaRow({
  delta, statsA, statsB, aLabel, bLabel,
}: {
  delta: ReturnType<typeof computeDelta>;
  statsA: SliceStats; statsB: SliceStats;
  aLabel: string; bLabel: string;
}) {
  if (statsA.graded === 0 || statsB.graded === 0) {
    return (
      <div className="mt-4 rounded-lg border border-[#1e2220] bg-[#0a0b0a] p-3">
        <p className="text-[11px] text-[#9ca39a] text-center">
          Need graded picks in both slices to compare.
          {" "}{statsA.graded === 0 ? `"${aLabel}" has 0 graded.` : ""}
          {" "}{statsB.graded === 0 ? `"${bLabel}" has 0 graded.` : ""}
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-lg border border-[#1e2220] bg-[#0a0b0a] p-3">
      <p className="text-[9px] font-bold text-[#6b7068] uppercase tracking-[0.15em] mb-2">
        Delta · {aLabel} minus {bLabel}
      </p>
      <div className="grid grid-cols-3 gap-3">
        <DeltaBox
          label="Win rate"
          delta={delta.winRate}
          unit="pp"
          significant={delta.winRateSignificant}
          sigText={delta.winRateSignificant ? "95% CIs do not overlap" : "CIs overlap — could be noise"}
        />
        <DeltaBox
          label="ROI"
          delta={delta.roi}
          unit="pp"
        />
        <DeltaBox
          label="Avg CLV"
          delta={delta.avgClv}
          unit="pp"
        />
      </div>
      {delta.verdict && (
        <div className="mt-3 text-[10px] leading-relaxed"
             style={{
               color: delta.verdict.tone === "good" ? "#3ee68a"
                 : delta.verdict.tone === "bad" ? "#ef4444" : "#9ca39a",
             }}>
          <span className="font-bold uppercase tracking-[0.12em] mr-2">
            {delta.verdict.tone === "good" ? "Significant"
              : delta.verdict.tone === "bad" ? "Inverted"
              : "Inconclusive"}
          </span>
          {delta.verdict.text}
        </div>
      )}
    </div>
  );
}

function DeltaBox({
  label, delta, unit, significant, sigText,
}: {
  label: string;
  delta: number | null;
  unit: string;
  significant?: boolean;
  sigText?: string;
}) {
  const v = delta !== null
    ? `${delta > 0 ? "+" : ""}${(delta * 100).toFixed(1)}${unit}`
    : "—";
  const color = delta === null ? "#6b7068"
    : delta > 0 ? "#3ee68a"
    : delta < 0 ? "#ef4444" : "#c4c7c0";
  return (
    <div className="rounded border border-[#1a1e1a] bg-[#0d0f0d] px-3 py-2">
      <p className="text-[9px] text-[#6b7068] uppercase tracking-[0.15em] mb-1">{label}</p>
      <p className="text-[20px] font-bold font-mono tabular-nums" style={{ color }}>
        {v}
      </p>
      {sigText !== undefined && (
        <p className="text-[8px] text-[#4a524a] uppercase tracking-[0.12em] mt-0.5">
          {significant && <span className="text-[#3ee68a]">● </span>}
          {sigText}
        </p>
      )}
    </div>
  );
}

// ─── Smaller controls ─────────────────────────────────────────────────────────

function Mini<T extends string>({
  label, v, opts, onChange,
}: { label: string; v: T; opts: [T, string][]; onChange: (val: T) => void }) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[#6b7068] uppercase tracking-[0.12em]">{label}</span>
      <div className="flex border border-[#1e2220] rounded overflow-hidden">
        {opts.map(([key, lbl]) => (
          <button
            key={key}
            onClick={() => onChange(key)}
            className={`px-1.5 py-0.5 uppercase tracking-[0.12em] transition-colors ${
              v === key ? "bg-[#3ee68a]/15 text-[#3ee68a]" : "text-[#6b7068] hover:text-white"
            }`}
          >
            {lbl}
          </button>
        ))}
      </div>
    </div>
  );
}

function DropDown({
  label, value, opts, format, onChange,
}: {
  label: string; value: string; opts: string[];
  format: (v: string) => string; onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[#6b7068] uppercase tracking-[0.12em]">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-[#1e2220] bg-[#0a0b0a] text-[9px] text-white outline-none px-1 py-0.5 uppercase tracking-[0.12em]"
      >
        {opts.map((o) => <option key={o} value={o}>{format(o)}</option>)}
      </select>
    </div>
  );
}

function StatBox({
  label, value, sub, color = "#c4c7c0",
}: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="rounded border border-[#1a1e1a] bg-[#0d0f0d] px-2 py-1.5">
      <p className="text-[8px] text-[#6b7068] uppercase tracking-[0.12em]">{label}</p>
      <p className="text-[13px] font-mono font-bold tabular-nums leading-tight" style={{ color }}>
        {value}
      </p>
      {sub && <p className="text-[8px] text-[#4a524a] mt-0.5 truncate">{sub}</p>}
    </div>
  );
}

// ─── Filter application ───────────────────────────────────────────────────────

function applyFilter(signals: SignalDTO[], f: SliceFilter): SignalDTO[] {
  const now = Date.now();
  const cutoff =
    f.range === "7d"  ? now - 7  * 86400000 :
    f.range === "30d" ? now - 30 * 86400000 :
    f.range === "60d" ? now - 60 * 86400000 :
    f.range === "prior-30d" ? now - 60 * 86400000 :
    null;
  const upper =
    f.range === "prior-30d" ? now - 30 * 86400000 : null;

  return signals.filter((s) => {
    if (f.sport !== "all" && s.sport !== f.sport) return false;
    if (cutoff !== null && s.detected_at) {
      const ts = new Date(s.detected_at).getTime();
      if (Number.isFinite(ts) && ts < cutoff) return false;
      if (upper !== null && Number.isFinite(ts) && ts > upper) return false;
    }
    if (f.market !== "all" && s.market !== f.market) return false;
    if (f.book   !== "all" && s.book   !== f.book)   return false;
    if (f.tier === "none" && s.confidence_tier) return false;
    if (f.tier !== "all" && f.tier !== "none" && s.confidence_tier !== f.tier) return false;
    if (f.status !== "all") {
      if (f.status === "win"  && !(s.status === "graded" && s.correct === 1)) return false;
      if (f.status === "loss" && !(s.status === "graded" && s.correct === 0)) return false;
      if (f.status === "open"   && s.status !== "open")   return false;
      if (f.status === "graded" && s.status !== "graded") return false;
    }
    if (f.minEdgePp > 0 && (s.edge_pp ?? 0) < f.minEdgePp) return false;
    return true;
  });
}

// ─── Stats + delta ────────────────────────────────────────────────────────────

interface SliceStats {
  signals: number;
  graded: number;
  wins: number;
  losses: number;
  winRate: number | null;
  roi: number | null;
  avgClv: number | null;
  positiveCLV: number | null;
  ciLow: number | null;
  ciHigh: number | null;
}

function computeStats(rows: SignalDTO[]): SliceStats {
  const graded = rows.filter((s) => s.status === "graded");
  const wins   = graded.filter((s) => s.correct === 1).length;
  const losses = graded.filter((s) => s.correct === 0).length;
  const totGraded = wins + losses;
  const winRate = totGraded > 0 ? wins / totGraded : null;
  const payout  = 100 / 110;
  const roi     = totGraded > 0 ? (wins * payout + losses * -1) / totGraded : null;
  const clvs    = rows.filter((s) => s.clv_pp != null).map((s) => s.clv_pp as number);
  const avgClv  = clvs.length > 0 ? clvs.reduce((a, b) => a + b, 0) / clvs.length : null;
  const posClv  = clvs.length > 0 ? clvs.filter((c) => c > 0).length / clvs.length : null;
  const [ciLow, ciHigh] = wilsonCI(wins, totGraded);
  return {
    signals: rows.length, graded: totGraded, wins, losses,
    winRate, roi, avgClv, positiveCLV: posClv, ciLow, ciHigh,
  };
}

function wilsonCI(wins: number, n: number, z = 1.96): [number | null, number | null] {
  if (n === 0) return [null, null];
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const radius = z * Math.sqrt((p * (1 - p) / n) + (z * z) / (4 * n * n));
  return [(centre - radius) / denom, (centre + radius) / denom];
}

function computeDelta(a: SliceStats, b: SliceStats) {
  const winRate = (a.winRate !== null && b.winRate !== null) ? a.winRate - b.winRate : null;
  const roi     = (a.roi     !== null && b.roi     !== null) ? a.roi     - b.roi     : null;
  const avgClv  = (a.avgClv  !== null && b.avgClv  !== null) ? a.avgClv  - b.avgClv  : null;

  // 95% CI non-overlap → "significant" in the casual sense
  const winRateSignificant =
    a.ciLow !== null && a.ciHigh !== null && b.ciLow !== null && b.ciHigh !== null &&
    (a.ciLow > b.ciHigh || b.ciLow > a.ciHigh);

  let verdict: { tone: "good" | "bad" | "neutral"; text: string } | null = null;
  if (winRate !== null) {
    if (winRate > 0.02 && winRateSignificant) {
      verdict = {
        tone: "good",
        text: `Slice A beats Slice B by ${(winRate * 100).toFixed(1)}pp with non-overlapping 95% CIs. This difference is unlikely to be noise — the dimension you're slicing on matters.`,
      };
    } else if (winRate < -0.02 && winRateSignificant) {
      verdict = {
        tone: "bad",
        text: `Slice B beats Slice A by ${(-winRate * 100).toFixed(1)}pp with non-overlapping 95% CIs. If A was your hypothesis, it's not confirmed — investigate why B outperforms.`,
      };
    } else if (Math.abs(winRate) > 0.02) {
      verdict = {
        tone: "neutral",
        text: `Slice ${winRate > 0 ? "A" : "B"} leads by ${(Math.abs(winRate) * 100).toFixed(1)}pp but 95% CIs overlap. Could be a real edge, could be noise. Need more graded picks before concluding.`,
      };
    } else {
      verdict = {
        tone: "neutral",
        text: `Both slices winning at similar rates. The dimension you're slicing on isn't carrying meaningful signal yet.`,
      };
    }
  }

  return { winRate, roi, avgClv, winRateSignificant, verdict };
}
